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
//   node scripts/consumer-upgrade.mjs --self-test
//
// Exit 0: nothing new (and, with --apply, upgraded). 1: something new, or the
// project is in use. 2: not a project this can upgrade.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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

function fail(code, message) {
  process.stderr.write(`consumer-upgrade: ${message}\n`);
  process.exit(code);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
  return {
    findings,
    incomplete,
    crashed,
    safe:
      findings.length === 0 &&
      incomplete.length === 0 &&
      crashed.length === 0 &&
      sameExit,
  };
}

/** The gate's report from one kit, run in the project. */
function gate(bin, project) {
  const done = spawnSync(bin, GATE, {
    cwd: project,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: GATE_TIMEOUT_MS,
    shell: windows,
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

/** The tarball of the committed kit, packed once per commit. */
function tarball() {
  if (git(repoRoot, ["status", "--porcelain", "--", "packages/validate-kit"]))
    fail(2, "packages/validate-kit has uncommitted changes: commit, then pack");
  const commit = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
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

/** Point an install folder at `spec` and install it. */
function install(folder, spec) {
  const manifest = join(folder, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const table = pkg.dependencies?.["validate-kit"]
    ? "dependencies"
    : "devDependencies";
  pkg[table] = { ...pkg[table], "validate-kit": spec };
  writeFileSync(manifest, `${JSON.stringify(pkg)}\n`);
  execFileSync("pnpm", ["install", "--silent"], {
    cwd: folder,
    stdio: ["ignore", "ignore", "inherit"],
    shell: windows,
  });
}

/** Is someone working in the project: a commit or an edit in the last hour? */
function inUse(project) {
  const since = Date.now() - BUSY_MS;
  if (Number(git(project, ["log", "-1", "--format=%ct"])) * 1000 > since)
    return true;
  return git(project, ["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return statSync(join(project, line.slice(3))).mtimeMs > since;
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
  const apply = args.includes("--apply");
  const evenIfBusy = args.includes("--even-if-busy");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target)
    fail(2, "usage: consumer-upgrade.mjs <project> [--apply] | --self-test");
  const project = resolve(target);
  const folder = join(project, ".tools", "validate-kit");
  if (!existsSync(join(folder, "package.json")) || !existsSync(binOf(folder)))
    fail(2, `${project} has no kit installed under .tools/validate-kit`);
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
    if (!verdict.safe) {
      process.stdout.write(
        "  not safe to upgrade: the new kit reports what the old one did not\n",
      );
      process.exit(1);
    }
    if (!apply) {
      process.stdout.write("  nothing new: safe to upgrade (--apply)\n");
      return;
    }
    copyFileSync(packed, join(folder, basename(packed)));
    install(folder, `file:${basename(packed)}`);
    const after = gate(binOf(folder), project);
    if (!compare(newRun, after, project).safe)
      fail(1, "the installed kit does not report what the trial did");
    process.stdout.write(`  upgraded to ${basename(packed)}\n`);
  } finally {
    rmSync(trial, { recursive: true, force: true });
  }
}

main();
