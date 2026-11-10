#!/usr/bin/env node
// Move a project that uses validate-kit to this checkout's kit, when its gate
// says the same.
//
// A project holds its kit as a private install: <project>/.tools/validate-kit,
// a package whose one dependency is a packed tarball. This packs the committed
// kit, runs the project's gate (`check --profile ci`) with the kit it has and
// with the new one, and compares what each reports. With --apply it repoints
// the install, and only when the new kit reports no finding, no missing tool
// and no crash the old one did not: an upgrade must never turn a project's
// gate red behind the back of whoever works there. A project with a commit or
// an edit in the last hour is left alone altogether (--even-if-busy).
//
//   node scripts/consumer-upgrade.mjs <project>            compare; change nothing
//   node scripts/consumer-upgrade.mjs <project> --apply    compare, then upgrade when nothing is new
//       --accept-new-findings   also when the gate was failing already and fails the same way with more
//                               findings (a kit fix that finds what the old kit missed); never from a clean gate
//   node scripts/consumer-upgrade.mjs <project> --install  a project with no kit: install, init, baseline, prove it silent
//                                                          (--commit commits the wiring there; nothing is pushed;
//                                                          --config=<file> is its validate.config.json, for a
//                                                          project `extends: "recommended"` alone does not fit)
//       --wait=<minutes>        with --apply or --install: a project in use is looked at again each minute
//                               until it has been left alone for an hour, or the minutes run out
//   node scripts/consumer-upgrade.mjs --status [folder]    the projects under a folder (default: beside this
//                                                          repository) whose kit is not the committed one;
//                                                          nothing printed, exit 0, when none is
//   node scripts/consumer-upgrade.mjs --self-test
//
// Exit 0: nothing new (and, with --apply, upgraded). 1: something new, or the
// project is in use. 2: not a project this can upgrade.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = ["check", "--profile", "ci", "--json"];
const GATE_TIMEOUT_MS = 30 * 60_000;
// A commit or an edit this recent means someone's hooks are in use right now.
const BUSY_MS = 60 * 60_000;
const windows = process.platform === "win32";
// How pnpm installs the kit in a project, whatever that project's pnpm and
// its settings: no release younger than a day among the kit's dependencies
// (a packed kit carries no lockfile, so they are resolved on the spot), and,
// without a terminal, leave to replace a node_modules another pnpm made
// (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY): the folder holds nothing else.
const PNPM_POLICY = [
  "--config.minimumReleaseAge=1440",
  "--config.confirmModulesPurge=false",
];

function fail(code, message) {
  process.stderr.write(`consumer-upgrade: ${message}\n`);
  process.exit(code);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/**
 * `git status --porcelain` as [state, path] pairs. The two state columns are
 * part of each line (" M .gitignore"): trimming the output shifts the first.
 */
export function statusOf(porcelain) {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, 2), line.slice(3)]);
}

/** What differs from HEAD in a work tree, as [state, path] pairs. */
function changes(project) {
  return statusOf(
    execFileSync(
      "git",
      ["-C", project, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
}

// What an install writes in a project: `init`'s files and the baseline.
const WIRING =
  /^(?:\.gitignore|\.mcp\.json|\.claude\/settings\.json|lefthook\.yml|\.lefthook\/.+|validate\.config\.(?:json|mjs|ts)|validate\.baseline\.json)$/;

/**
 * The paths an install wrote: what differs now and did not before it began.
 * `before` and `after` are [state, path] pairs; only wiring paths count, so
 * a file someone else saved meanwhile is never taken for the install's.
 */
export function wrote(before, after) {
  const had = new Set(before.map(([, path]) => path));
  return after.filter(([, path]) => !had.has(path) && WIRING.test(path));
}

/** One line per finding, the same for both kits: `tool/rule path:line`. */
function keysOf(report, root) {
  return new Set(
    (report.findings ?? []).map(
      (f) =>
        `${f.tool}/${f.ruleId} ${relative(root, f.file ?? "")}:${String(f.line ?? 0)}`,
    ),
  );
}

/** The tools in a report's list: `{ id, stderr }` entries, or bare ids from an older kit. */
function names(list) {
  return (list ?? []).map((item) =>
    typeof item === "string" ? item : item.id,
  );
}

/** The tools in `list` that `before` does not name. */
function fresh(list, before) {
  return names(list).filter((name) => !names(before).includes(name));
}

/** How many findings a gate run reported. */
function count(gateRun) {
  return (gateRun.report.findings ?? []).length;
}

/**
 * What the new kit reports that the old one did not. Safe to upgrade when
 * all three lists are empty and the gate's exit code is the old one or 0.
 */
export function compare(oldRun, newRun, root) {
  const had = keysOf(oldRun.report, root);
  const findings = [...keysOf(newRun.report, root)]
    .filter((key) => !had.has(key))
    .toSorted();
  const incomplete = fresh(newRun.report.incomplete, oldRun.report.incomplete);
  const crashed = fresh(newRun.report.crashed, oldRun.report.crashed);
  const sameExit = newRun.status === oldRun.status || newRun.status === 0;
  const toolsHold = incomplete.length === 0 && crashed.length === 0;
  return {
    findings,
    incomplete,
    crashed,
    safe: findings.length === 0 && toolsHold && sameExit,
    // The gate was failing already, and fails the same way with more to say:
    // nobody's green gate turns red (--accept-new-findings).
    onlyMoreFindings:
      findings.length > 0 &&
      toolsHold &&
      oldRun.status !== 0 &&
      newRun.status === oldRun.status,
  };
}

/**
 * Run a command in a folder as that folder's own shell would: a login shell
 * started there, so a version manager (mise, asdf) picks the project's tools.
 * Run directly, the command inherits this repository's: one consumer's gate
 * exited 0 from its own shell and 4 from here, under another Go.
 */
function inFolder(folder, command, args, options = {}) {
  const shell = process.env.SHELL;
  const spawnOptions = { cwd: folder, encoding: "utf8", ...options };
  if (windows || !shell)
    return spawnSync(command, args, { ...spawnOptions, shell: windows });
  return spawnSync(
    shell,
    ["-lc", 'exec "$@"', "sh", command, ...args],
    spawnOptions,
  );
}

/** The gate's report from one kit, run in the project. */
function gate(bin, project) {
  const done = inFolder(project, bin, GATE, {
    maxBuffer: 256 * 1024 * 1024,
    timeout: GATE_TIMEOUT_MS,
  });
  if (done.error)
    fail(1, `${bin} did not finish the gate: ${done.error.message}`);
  let report = {};
  try {
    report = JSON.parse(done.stdout);
  } catch {
    // A config error or a crash prints no report: the exit code says which.
  }
  return { status: done.status, report };
}

/** The committed kit: the last commit that changed the package. */
function kitCommit() {
  return git(repoRoot, [
    "log",
    "-1",
    "--format=%h",
    "--",
    "packages/validate-kit",
  ]);
}

/** `file:validate-kit-0.2.5-817e3e3.tgz` as `817e3e3`; nothing for a tarball named without its commit. */
export function commitOf(spec) {
  return /validate-kit-[\d.]+-([0-9a-f]{7,40})\.tgz$/.exec(spec ?? "")?.[1];
}

/** Is the kit package the same at both commits? */
function sameKit(a, b) {
  return (
    spawnSync("git", [
      "-C",
      repoRoot,
      "diff",
      "--quiet",
      a,
      b,
      "--",
      "packages/validate-kit",
    ]).status === 0
  );
}

/**
 * One line per project under `root` whose private kit install is not the
 * committed kit. Read from each .tools/validate-kit/package.json: nothing is
 * run in any project.
 */
/** The kit an install folder names, if pnpm could read its manifest. */
function namedKit(folder) {
  try {
    const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    return (
      pkg.devDependencies?.["validate-kit"] ??
      pkg.dependencies?.["validate-kit"]
    );
  } catch {
    return undefined;
  }
}

function listBehind(root) {
  const current = kitCommit();
  const behind = [];
  // Projects that stay behind on purpose, with the reason (a private file:
  // it names them).
  const holdsFile = join(repoRoot, "docs", "consumers", "holds.json");
  const holds = existsSync(holdsFile)
    ? JSON.parse(readFileSync(holdsFile, "utf8"))
    : {};
  for (const name of readdirSync(root).toSorted()) {
    if (Object.hasOwn(holds, name)) continue;
    const folder = join(root, name, ".tools", "validate-kit");
    if (!existsSync(join(folder, "package.json"))) continue;
    const spec = namedKit(folder);
    // An install that failed after pnpm cleared node_modules: the folder
    // names a kit, and the project's hooks have nothing to run.
    if (spec && !existsSync(binOf(folder))) {
      behind.push(
        `${name}: .tools/validate-kit names a kit and holds no binary, so its hooks cannot run: run consumer-upgrade.mjs on it`,
      );
      continue;
    }
    const has = commitOf(spec);
    if (has && sameKit(has, current)) continue;
    behind.push(
      spec
        ? `${name}: its kit (${has ?? "built before tarballs carried their commit"}) is behind ${current}`
        : `${name}: .tools/validate-kit holds no kit (an install that did not finish)`,
    );
  }
  if (behind.length === 0) return;
  process.stdout.write(`${behind.join("\n")}\n`);
  process.exitCode = 1;
}

/** The tarball of the committed kit, packed once per commit of the package. */
function tarball() {
  if (git(repoRoot, ["status", "--porcelain", "--", "packages/validate-kit"]))
    fail(2, "packages/validate-kit has uncommitted changes: commit, then pack");
  const commit = kitCommit();
  const { version } = JSON.parse(
    readFileSync(join(repoRoot, "packages/validate-kit/package.json"), "utf8"),
  );
  const dir = process.env.VALIDATE_KIT_TARBALLS ?? homedir();
  const path = join(dir, `validate-kit-${version}-${commit}.tgz`);
  if (!existsSync(path)) {
    const out = mkdtempSync(join(tmpdir(), "vk-pack-"));
    execFileSync(
      "pnpm",
      ["--filter", "validate-kit", "pack", "--pack-destination", out],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"], shell: windows },
    );
    renameSync(join(out, `validate-kit-${version}.tgz`), path);
    rmSync(out, { recursive: true, force: true });
  }
  return path;
}

/** The kit binary of an install folder. */
function binOf(folder) {
  return join(
    folder,
    "node_modules",
    ".bin",
    windows ? "validate-kit.cmd" : "validate-kit",
  );
}

// The install folder is its own pnpm workspace. pnpm takes the nearest
// pnpm-workspace.yaml, and in a project that is itself a workspace that was
// the project's: `pnpm add --allow-build` there replaced the project's build
// approvals with the kit's one (pnpm 11.9.0) and relinked its node_modules.
// The approval is written here instead, under both names pnpm has used.
const OWN_WORKSPACE = `# validate-kit installs here as its own pnpm workspace, so pnpm never reads
# or rewrites the pnpm-workspace.yaml of the project around it.
allowBuilds:
  "@ast-grep/cli": true
onlyBuiltDependencies:
  - "@ast-grep/cli"
`;
function ownWorkspace(folder) {
  const file = join(folder, "pnpm-workspace.yaml");
  if (!existsSync(file)) writeFileSync(file, OWN_WORKSPACE);
}

/** Point an install folder at `spec` and install it. */
function install(folder, spec) {
  ownWorkspace(folder);
  const manifest = join(folder, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const table = pkg.dependencies?.["validate-kit"]
    ? "dependencies"
    : "devDependencies";
  pkg[table] = { ...pkg[table], "validate-kit": spec };
  // The kit the folder names now, to go back to.
  const before = readFileSync(manifest, "utf8");
  const lockfile = join(folder, "pnpm-lock.yaml");
  // The kit's own dependencies are resolved again each time, under the
  // cooldown: a lockfile kept from an earlier install can name a release
  // that was hours old when it was written, which pnpm then refuses.
  const installAs = (text) => {
    writeFileSync(manifest, text);
    rmSync(lockfile, { force: true });
    return inFolder(folder, "pnpm", ["install", ...PNPM_POLICY]);
  };
  // A trial folder holds no kit yet, and has nothing to go back to.
  const had = existsSync(binOf(folder));
  const done = installAs(`${JSON.stringify(pkg)}\n`);
  if (done.status === 0) return;
  const why = `${done.stdout}${done.stderr}`.trim().split("\n").slice(-15);
  if (!had) fail(1, `pnpm install failed in ${folder}:\n${why.join("\n")}`);
  // pnpm clears node_modules before it fails: naming the old kit again is
  // not enough, the old kit has to be installed again, or the project's
  // hooks have no binary to run.
  const back = installAs(before);
  fail(
    1,
    `pnpm install failed in ${folder}; ${back.status === 0 && existsSync(binOf(folder)) ? "the kit it had is installed again" : "AND the kit it had could not be installed again: its hooks have no binary until `pnpm install` succeeds there"}:\n${why.join("\n")}`,
  );
}

/**
 * An install folder after an install that is not kept: gone when the install
 * made it, and otherwise holding what it held (`held`), no more and no less.
 */
function putBack(folder, held) {
  if (!held) {
    rmSync(folder, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync(folder))
    if (!held.names.includes(name))
      rmSync(join(folder, name), { recursive: true, force: true });
  if (held.manifest !== undefined)
    writeFileSync(join(folder, "package.json"), held.manifest);
}

/** Is someone working in the project: a commit or an edit in the last hour? */
function inUse(project) {
  return changedSince(project, Date.now() - BUSY_MS);
}

/** Was the project committed to, or an uncommitted file edited, since then? */
function changedSince(project, since) {
  if (Number(git(project, ["log", "-1", "--format=%ct"])) * 1000 > since)
    return true;
  return changes(project).some(([, path]) => {
    try {
      return statSync(join(project, path)).mtimeMs > since;
    } catch {
      return false; // deleted, or a rename's "a -> b"
    }
  });
}

/** A finding and a gate run, for the self-test. */
function finding(ruleId, line) {
  return { tool: "ruff", ruleId, file: "/p/a.py", line };
}
function run(status, findings, more = {}) {
  return {
    status,
    report: { findings, incomplete: [], crashed: [], ...more },
  };
}

/**
 * The files the gate's quiet output and the stop hook speak about, or nothing
 * when a line is neither a finding (`path:line:col severity …`) nor one of
 * their own lines around the findings: something this cannot vouch for.
 */
export function spokenOf(text) {
  const paths = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const found = /^(.+?):\d+:\d+ (?:error|warning|info) /.exec(line);
    if (found) paths.push(found[1]);
    else if (
      !/^validate-kit: (?:exit \d+:|your changes leave these findings)/.test(
        line,
      ) &&
      !line.startsWith("The working tree has uncommitted changes:")
    )
      return undefined;
  }
  return paths;
}

/**
 * Put the tree back as it was before an install that did not end silent:
 * the install's own files go, and nothing that was uncommitted before it
 * began is touched.
 */
function undo(project, folder, before, held) {
  putBack(folder, held);
  for (const [state, path] of wrote(before, changes(project))) {
    if (state === "??")
      rmSync(join(project, path), { recursive: true, force: true });
    else git(project, ["checkout", "--", path]);
  }
}

/**
 * Give a project with no kit the committed one, the way the README says:
 * a private install under .tools/validate-kit, `init` for the config, the
 * hooks and the MCP entry, and today's findings recorded as its baseline so
 * the gate starts silent and only what is new speaks. From a clean tree
 * only, and undone unless the gate ends at exit 0 with nothing printed.
 */
function installInto(project, commit, config) {
  const name = basename(project);
  const folder = join(project, ".tools", "validate-kit");
  // A folder with a package.json and no kit in it is an install that never
  // finished: this one takes its place.
  if (existsSync(join(folder, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    if (
      pkg.devDependencies?.["validate-kit"] ??
      pkg.dependencies?.["validate-kit"]
    )
      fail(2, `${name} already has a kit: upgrade it (no --install)`);
  }
  // Uncommitted work stays as it is: the install writes its own files and
  // commits only those. It cannot share a file with that work.
  const before = changes(project);
  const shared = before.filter(([, path]) => WIRING.test(path));
  if (shared.length > 0)
    fail(
      1,
      `${name} has uncommitted changes to ${shared.map(([, path]) => path).join(", ")}, which the install also writes: commit or set them aside first`,
    );
  const packed = tarball();
  // What the folder holds now, when it is there: an install that is not kept
  // puts exactly that back.
  const manifest = join(folder, "package.json");
  const held = existsSync(folder)
    ? {
        names: readdirSync(folder),
        manifest: existsSync(manifest)
          ? readFileSync(manifest, "utf8")
          : undefined,
      }
    : undefined;
  mkdirSync(folder, { recursive: true });
  writeFileSync(manifest, '{ "private": true }\n');
  ownWorkspace(folder);
  copyFileSync(packed, join(folder, basename(packed)));
  const added = inFolder(folder, "pnpm", [
    "add",
    "-D",
    ...PNPM_POLICY,
    `./${basename(packed)}`,
  ]);
  if (added.status !== 0) {
    putBack(folder, held);
    fail(
      1,
      `pnpm add failed in ${folder}, which is ${held ? "put back as it was" : "removed"}:\n${`${added.stdout}${added.stderr}`.trim().split("\n").slice(-15).join("\n")}`,
    );
  }
  // The install is this machine's: never tracked.
  const ignored = spawnSync("git", [
    "-C",
    project,
    "check-ignore",
    "-q",
    ".tools",
  ]);
  if (ignored.status !== 0)
    appendFileSync(
      join(project, ".gitignore"),
      "\n# validate-kit's local install\n.tools/\n",
    );
  const bin = binOf(folder);
  const kit = (args) =>
    inFolder(project, bin, args, {
      maxBuffer: 256 * 1024 * 1024,
      timeout: GATE_TIMEOUT_MS,
    });
  // A project the recommended preset alone does not fit brings its config:
  // init keeps one that is there.
  if (config) copyFileSync(config, join(project, "validate.config.json"));
  const init = kit(["init"]);
  const found = init.status === 0 ? count(gate(bin, project)) : 0;
  // A step that stopped is said by name, with what it printed: init, or the
  // baseline (unchecked, its failure read as "the gate is not silent").
  const baseline = found > 0 ? kit(["baseline"]) : init;
  const stopped =
    init.status === 0
      ? baseline.status === 0
        ? undefined
        : ["baseline", baseline]
      : ["init", init];
  const quiet = stopped
    ? stopped[1]
    : kit(["check", "--profile", "ci", "--quiet"]);
  // The stop hook on a tree with nothing of the agent's in it.
  const hook = inFolder(project, bin, ["hook", "claude"], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: project }),
  });
  const said =
    `${quiet.stdout}${quiet.stderr}${hook.stdout}${hook.stderr}`.trim();
  // Work that was uncommitted before the install is its author's to hear
  // about: findings there are the hook doing its job, not a gate that starts
  // red. Anything else it says, and the install is undone.
  const work = new Set(before.map(([, path]) => path));
  const spoken = stopped ? undefined : spokenOf(said);
  const theirs =
    spoken !== undefined &&
    spoken.length > 0 &&
    spoken.every((path) => work.has(path));
  const silent = quiet.status === 0 && hook.status === 0 && said === "";
  if (stopped || !(silent || theirs)) {
    process.stdout.write(
      `${name}: not installed, and put back as it was: ${stopped ? `${stopped[0]} stopped (exit ${String(stopped[1].status)})` : "its gate does not end silent with today's findings as the baseline"}\n${(stopped
        ? `${stopped[1].stdout}${stopped[1].stderr}`.trim()
        : said
      )
        .split("\n")
        .slice(0, 40)
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    undo(project, folder, before, held);
    process.exit(1);
  }
  const own = wrote(before, changes(project));
  process.stdout.write(
    `${name}: installed ${basename(packed)}; ${String(found)} findings of today recorded as the baseline; the gate and the stop hook ${theirs ? `speak only about ${String(new Set(spoken).size)} files that were uncommitted before the install` : "print nothing"}\n${own.map(([state, path]) => `  ${state} ${path}`).join("\n")}\n`,
  );
  if (!commit) return;
  // Its own files only: whatever else is uncommitted there stays uncommitted.
  const paths = own.map(([, path]) => path);
  git(project, ["add", "--", ...paths]);
  git(project, [
    "commit",
    "-q",
    "--only",
    "-m",
    `chore: validate-kit as this repository's gate\n\nThe config, the lefthook pre-commit and pre-push hooks, Claude Code's stop\nhook and the MCP entry, as \`validate-kit init\` writes them, and today's\n${String(found)} findings as the baseline: the gate starts silent and speaks only\nabout what is new. The kit itself is a local install under .tools/ (ignored).\n\nCo-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`,
    "--",
    ...paths,
  ]);
  process.stdout.write(
    `  committed as ${git(project, ["rev-parse", "--short", "HEAD"])}; not pushed\n`,
  );
}

function selfTest() {
  const old = run(1, [finding("E501", 3)]);
  assert.equal(compare(old, run(1, [finding("E501", 3)]), "/p").safe, true);
  assert.equal(compare(old, run(0, []), "/p").safe, true, "fewer is safe");
  const more = compare(
    old,
    run(1, [finding("E501", 3), finding("F401", 9)]),
    "/p",
  );
  assert.deepEqual(more.findings, ["ruff/F401 a.py:9"]);
  assert.equal(more.safe, false, "a new finding is not safe");
  const missing = compare(
    run(0, []),
    run(3, [], { incomplete: [{ id: "shfmt", stderr: "not installed" }] }),
    "/p",
  );
  assert.deepEqual(missing.incomplete, ["shfmt"]);
  assert.equal(missing.safe, false, "a tool the machine lacks is not safe");
  assert.equal(
    compare(run(0, []), run(4, [], { crashed: ["tsc"] }), "/p").safe,
    false,
  );
  // More findings on a gate that was failing already can be taken on request;
  // on a clean gate, or with a tool newly missing, never.
  assert.equal(more.onlyMoreFindings, true);
  assert.equal(
    compare(run(0, []), run(1, [finding("F401", 9)]), "/p").onlyMoreFindings,
    false,
  );
  assert.equal(missing.onlyMoreFindings, false);
  assert.equal(commitOf("file:validate-kit-0.2.5-817e3e3.tgz"), "817e3e3");
  assert.equal(
    commitOf("file:/Users/x/Projects/p/.tools/validate-kit-0.2.5-57c8de0.tgz"),
    "57c8de0",
  );
  assert.equal(commitOf("file:validate-kit-0.2.5.tgz"), undefined);
  assert.equal(commitOf(undefined), undefined);
  // What the gate and the hook speak about: findings by file, or nothing
  // when a line is not theirs.
  assert.deepEqual(
    spokenOf(
      "src/a.go:72:23 warning golangci-lint/errcheck Error return value is not checked\nvalidate-kit: exit 1: 0 error(s), 1 warning(s)\nThe working tree has uncommitted changes: this run judged them too.\nvalidate-kit: your changes leave these findings; fix them before you finish:\nsrc/a.go:72:23 warning golangci-lint/errcheck Error return value is not checked",
    ),
    ["src/a.go", "src/a.go"],
  );
  assert.deepEqual(spokenOf(""), []);
  assert.equal(spokenOf("panic: something else"), undefined);
  // An install's own files: new since it began, and only what it writes.
  assert.deepEqual(
    wrote(
      [[" M", "src/app.go"]],
      [
        [" M", "src/app.go"],
        [" M", ".mcp.json"],
        ["??", "lefthook.yml"],
        ["??", ".lefthook/pre-push/validate-kit-preflight.sh"],
        ["??", "validate.config.json"],
        ["??", "notes.txt"],
      ],
    ).map(([, path]) => path),
    [
      ".mcp.json",
      "lefthook.yml",
      ".lefthook/pre-push/validate-kit-preflight.sh",
      "validate.config.json",
    ],
  );
  // The first line of git's status keeps its leading column.
  assert.deepEqual(statusOf(" M .gitignore\n?? lefthook.yml\nA  new.txt\n"), [
    [" M", ".gitignore"],
    ["??", "lefthook.yml"],
    ["A ", "new.txt"],
  ]);
  // A tool that crashed under the old kit too is not news, whatever it printed.
  const crash = (stderr) =>
    run(4, [], { crashed: [{ id: "govulncheck", stderr }] });
  assert.equal(
    compare(crash("built with go1.26"), crash("built with go1.26 "), "/p").safe,
    true,
  );
  assert.equal(
    compare(run(0, []), run(2, []), "/p").safe,
    false,
    "a config the new kit refuses is not safe",
  );
  process.stdout.write("consumer-upgrade self-test: ok\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  if (args.includes("--status"))
    return listBehind(
      resolve(
        args.find((arg) => !arg.startsWith("--")) ?? join(repoRoot, ".."),
      ),
    );
  const apply = args.includes("--apply");
  const evenIfBusy = args.includes("--even-if-busy");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target)
    fail(2, "usage: consumer-upgrade.mjs <project> [--apply] | --self-test");
  const project = resolve(target);
  // --kit=<folder>: a project that keeps its kit elsewhere (one install per
  // pinned commit, moved by its own script) is compared from there, and
  // nothing of it is changed.
  const elsewhere = args.find((arg) => arg.startsWith("--kit="))?.slice(6);
  if (elsewhere && (apply || args.includes("--install")))
    fail(
      2,
      "--kit only compares: a project that keeps its kit elsewhere moves it by its own process",
    );
  const folder = elsewhere
    ? resolve(project, elsewhere)
    : join(project, ".tools", "validate-kit");
  // --wait=<minutes>: a project in use is looked at again each minute, and
  // the work starts when it has been left alone for an hour.
  const wait = Number(
    args.find((arg) => arg.startsWith("--wait="))?.slice(7) ?? 0,
  );
  const deadline = Date.now() + wait * 60_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  if (!evenIfBusy)
    while (inUse(project) && Date.now() < deadline)
      Atomics.wait(pause, 0, 0, 60_000);
  if (args.includes("--install")) {
    if (inUse(project) && !evenIfBusy)
      fail(
        1,
        `${basename(project)} changed in the last hour, so someone is working there (--even-if-busy)`,
      );
    return installInto(
      project,
      args.includes("--commit"),
      args.find((arg) => arg.startsWith("--config="))?.slice(9),
    );
  }
  const named = namedKit(folder);
  if (!named || (elsewhere && !existsSync(binOf(folder))))
    fail(
      2,
      `${project} has no kit installed under ${relative(project, folder)}`,
    );
  // It names a kit and holds no binary (an install that failed after pnpm
  // cleared node_modules): what it names is installed again first, in use
  // or not, since its hooks have nothing to run until then.
  if (!existsSync(binOf(folder))) {
    install(folder, named);
    process.stdout.write(
      `${basename(project)}: its install folder named a kit and held no binary: installed again\n`,
    );
  }
  // The gate runs the project's own tests and builds: not beside whoever is
  // working there, and its kit is not swapped under them.
  if (inUse(project) && !evenIfBusy) {
    process.stdout.write(
      `${basename(project)}: changed in the last hour, so someone is working there: not running its gate or touching its kit (--even-if-busy)\n`,
    );
    process.exit(1);
  }
  const packed = tarball();

  // The new kit, installed beside the project as the project installs its own.
  const trial = mkdtempSync(join(tmpdir(), "vk-trial-"));
  try {
    for (const name of ["package.json", "pnpm-workspace.yaml"])
      if (existsSync(join(folder, name)))
        copyFileSync(join(folder, name), join(trial, name));
    install(trial, `file:${packed}`);
    const began = Date.now();
    const oldRun = gate(binOf(folder), project);
    const newRun = gate(binOf(trial), project);
    const verdict = compare(oldRun, newRun, project);
    process.stdout.write(
      `${basename(project)}: its kit exits ${String(oldRun.status)} with ${String(count(oldRun))} findings; ${basename(packed)} exits ${String(newRun.status)} with ${String(count(newRun))}\n`,
    );
    for (const [what, list] of [
      ["new finding", verdict.findings],
      ["tool this machine lacks", verdict.incomplete],
      ["tool that crashed", verdict.crashed],
    ])
      for (const item of list.slice(0, 40))
        process.stdout.write(`  ${what}: ${item}\n`);
    const accepted =
      verdict.onlyMoreFindings && args.includes("--accept-new-findings");
    if (!verdict.safe && !accepted) {
      process.stdout.write(
        `  not safe to upgrade: the new kit reports what the old one did not${verdict.onlyMoreFindings ? " (the gate was failing already, with the same exit code: --accept-new-findings takes them)" : ""}\n`,
      );
      process.exit(1);
    }
    if (!apply) {
      process.stdout.write(
        `  ${accepted ? "more findings on a gate that was failing already" : "nothing new"}: safe to upgrade (--apply)\n`,
      );
      return;
    }
    copyFileSync(packed, join(folder, basename(packed)));
    install(folder, `file:${basename(packed)}`);
    const after = gate(binOf(folder), project);
    const again = compare(newRun, after, project);
    // Someone committed or edited there while the gate ran (--even-if-busy):
    // findings can differ for that reason alone. An install that went wrong
    // shows as a tool that is missing or crashes, and that is still refused.
    const theirs =
      changedSince(project, began) &&
      again.incomplete.length === 0 &&
      again.crashed.length === 0;
    if (!again.safe && !theirs)
      fail(1, "the installed kit does not report what the trial did");
    process.stdout.write(
      `  upgraded to ${basename(packed)}${again.safe ? "" : "; the project changed while its gate ran, so the confirming run differs in findings only"}\n`,
    );
  } finally {
    rmSync(trial, { recursive: true, force: true });
  }
}

main();
