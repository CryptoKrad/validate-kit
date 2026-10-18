#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The fixtures live in temp folders mise does not cover, where `go` is
// whichever one PATH finds; a GOROOT a mise shim exported for this repo's go
// then contradicts it and go cannot compile its standard library
// (scripts/verify-clean.sh unsets it for the same reason).
delete process.env.GOROOT;

const repoRoot = process.cwd();
const builtCli = join(repoRoot, "packages", "validate-kit", "dist", "cli.js");
const requiredRuleIds = [
  "py-no-eq-none",
  "py-no-print",
  "ts-no-console",
  "ts-no-explicit-any",
  "ts-no-loose-equality",
];
// Anything that would resolve the kit through a package registry.
const registryFetch = /\bnpx\b|\bdlx\b|-p validate-kit/;
let scaffoldedFilesChecked = 0;
const tempRoot = mkdtempSync(join(tmpdir(), "validate-kit-external-smoke-"));
const packDir = join(tempRoot, "pack");
const consumerRoot = join(tempRoot, "consumer");

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  run("pnpm", [
    "--filter",
    "validate-kit",
    "pack",
    "--pack-destination",
    packDir,
  ]);

  const tarball = readdirSync(packDir)
    .filter((entry) => /^validate-kit-.+\.tgz$/.test(entry))
    .map((entry) => join(packDir, entry))[0];
  assert(
    tarball,
    `pnpm pack did not create validate-kit tarball in ${packDir}`,
  );

  // Plans must be reproducible (engine-generalisation.md, G1.1b): the same
  // tree gives the same tasks in the same order, and that order is a
  // property (ascending directories per tool), not a lucky draw.
  const planRuns = [1, 2, 3, 4, 5].map(
    () => run("node", [builtCli, "list", "--json"]).stdout,
  );
  assert(
    planRuns.every((text) => text === planRuns[0]),
    "list --json differs between runs on the same tree",
  );
  const dirsByTool = new Map();
  for (const task of JSON.parse(planRuns[0]).tasks) {
    // The planner orders absolute paths, where the project root is a prefix
    // of every other root; "." would not sort that way against "-x" or "+x".
    const dir = task.cwd === "." ? "" : task.cwd;
    dirsByTool.set(task.tool, [...(dirsByTool.get(task.tool) ?? []), dir]);
  }
  for (const [tool, dirs] of dirsByTool) {
    assert(
      dirs.join("\n") === dirs.toSorted().join("\n"),
      `${tool} tasks are not in directory order: ${dirs.join(", ")}`,
    );
  }

  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "validate-kit-external-smoke-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  // pnpm >=10.16 hard-fails on ignored build scripts (ERR_PNPM_IGNORED_BUILDS)
  // and @ast-grep/cli needs its postinstall to place the platform binary.
  // --allow-build is the mechanism pnpm 10.23 actually honors here (the
  // package.json "pnpm" field is ignored, and an onlyBuiltDependencies list in
  // pnpm-workspace.yaml did NOT lift the block for `pnpm add` in testing).
  // Real consumers hit the same wall (npm v12 defaults install scripts off
  // too; see sota-07) — README documents the consumer-side fix.
  run("pnpm", ["add", "-D", "--allow-build=@ast-grep/cli", tarball], {
    cwd: consumerRoot,
  });

  const lockfilePath = join(consumerRoot, "pnpm-lock.yaml");
  assert(
    existsSync(lockfilePath),
    "consumer pnpm install did not create pnpm-lock.yaml",
  );

  mkdirSync(join(consumerRoot, "src"), { recursive: true });
  mkdirSync(join(consumerRoot, "py"), { recursive: true });
  writeFileSync(
    join(consumerRoot, "src", "index.ts"),
    [
      "export function bad(value: any) {",
      "  console.log(value)",
      "  if (value == 1) return 1",
      "  return 0",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumerRoot, "py", "score.py"),
    [
      "def score(value):",
      "    print(value)",
      "    if value == None:",
      "        return 1",
      "    return 0",
      "",
    ].join("\n"),
  );

  const initResult = run("pnpm", ["exec", "check", "init"], {
    cwd: consumerRoot,
  });
  // A JS package root with no root tsconfig: a module config, not a .ts file
  // outside every TypeScript project (DV1).
  const configPath = join(consumerRoot, "validate.config.mjs");
  assert(
    existsSync(configPath) &&
      !existsSync(join(consumerRoot, "validate.config.ts")),
    "installed check init did not scaffold validate.config.mjs",
  );
  assert(
    readFileSync(configPath, "utf8").includes('from "validate-kit"'),
    "installed check init did not scaffold a package import",
  );

  // Scaffold safety (docs/architecture/engine-generalisation.md, C0). The
  // unscoped npm name belongs to an unrelated package, so nothing init writes
  // may fetch the kit from a registry, and what it writes must really run.
  const localBin = "node_modules/.bin/validate-kit";
  assertNoRegistryFetch(consumerRoot, [
    "validate.config.mjs",
    ".mcp.json",
    "lefthook.yml",
  ]);
  const mcpEntry = JSON.parse(
    readFileSync(join(consumerRoot, ".mcp.json"), "utf8"),
  ).mcpServers["Tester.MCP"];
  assert(
    mcpEntry.command === localBin && mcpEntry.args.join(" ") === "mcp",
    `init scaffolded an unexpected MCP command: ${JSON.stringify(mcpEntry)}`,
  );
  const hookRun = scaffoldedHookRun(consumerRoot);
  assert(
    hookRun === `${localBin} check --staged --quiet`,
    `init scaffolded an unexpected hook command: ${hookRun}`,
  );
  // Run both exactly as a hook or an agent would: through a shell, from the
  // project root. A command that does not resolve exits 127 here.
  run("sh", ["-c", `${mcpEntry.command} --version`], { cwd: consumerRoot });
  run("git", ["init", "--quiet"], { cwd: consumerRoot });
  run("git", ["add", "src/index.ts"], { cwd: consumerRoot });
  const hookResult = run("sh", ["-c", `${hookRun} --only ast-grep --json`], {
    cwd: consumerRoot,
    allowedStatuses: [1],
  });
  const hookJson = parseJsonOutput(hookResult, "scaffolded hook command");
  assert(
    hookJson.findings?.some((finding) => finding.ruleId === "ts-no-console"),
    "scaffolded hook command did not report findings for the staged file",
  );

  // A project the kit is NOT installed in, with no TS or JS, and with an
  // unrelated package of the same name in its node_modules (what a registry
  // install of the unscoped name would produce).
  const impostorRoot = join(tempRoot, "impostor");
  const impostorPkg = join(impostorRoot, "node_modules", "validate-kit");
  const impostorBinDir = join(impostorRoot, "node_modules", ".bin");
  mkdirSync(impostorPkg, { recursive: true });
  mkdirSync(impostorBinDir, { recursive: true });
  writeFileSync(
    join(impostorPkg, "package.json"),
    `${JSON.stringify({ name: "validate-kit", version: "1.0.5" })}\n`,
  );
  writeFileSync(join(impostorBinDir, "validate-kit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  writeFileSync(
    join(impostorRoot, "main.go"),
    "package main\n\nfunc main() {}\n",
  );
  const installedKit = join(consumerRoot, localBin);
  run(installedKit, ["init"], { cwd: impostorRoot });
  assert(
    existsSync(join(impostorRoot, "validate.config.json")) &&
      !existsSync(join(impostorRoot, "validate.config.ts")),
    "init in a repo without TS must scaffold validate.config.json only",
  );
  assertNoRegistryFetch(impostorRoot, [
    "validate.config.json",
    ".mcp.json",
    "lefthook.yml",
  ]);
  const impostorMcp = JSON.parse(
    readFileSync(join(impostorRoot, ".mcp.json"), "utf8"),
  ).mcpServers["Tester.MCP"];
  assert(
    impostorMcp.command === "validate-kit" &&
      scaffoldedHookRun(impostorRoot) === "validate-kit check --staged --quiet",
    "init must scaffold the PATH command when the kit is not the project's own dependency",
  );
  const impostorList = parseJsonOutput(
    run(installedKit, ["list", "--json"], { cwd: impostorRoot }),
    "list --json in the non-TS project",
  );
  assert(
    impostorList.languages.join(",") === "go",
    `scaffolding a config must not add a language to the project: ${impostorList.languages.join(",")}`,
  );

  // DV1, DV2, DV15 (dark-visitor, 2026-10-09): a Go root whose TypeScript
  // lives in frontend/ gets a JSON config, not a .ts file no tsconfig covers;
  // --dry-run writes nothing; --no-hook and --no-mcp leave those out (and
  // never run lefthook, which would write a lefthook.yml); a kit installed in
  // a tools folder is scaffolded by its own path.
  const dvInitRoot = join(tempRoot, "dv-init");
  mkdirSync(join(dvInitRoot, "frontend", "src"), { recursive: true });
  writeFileSync(join(dvInitRoot, "go.mod"), "module dvinit\n\ngo 1.22\n");
  writeFileSync(join(dvInitRoot, "frontend", "tsconfig.json"), "{}\n");
  writeFileSync(
    join(dvInitRoot, "frontend", "src", "a.ts"),
    "export const a = 1;\n",
  );
  // A script under docs/ is not the root's own JS: still JSON (2026-10-13: a
  // Rust and Python root got validate.config.mjs).
  mkdirSync(join(dvInitRoot, "docs", "site"), { recursive: true });
  writeFileSync(join(dvInitRoot, "docs", "site", "app.js"), "export {};\n");
  const toolsDir = join(dvInitRoot, ".tools", "vk");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(
    join(toolsDir, "package.json"),
    '{ "name": "vk-tools", "private": true }\n',
  );
  run("pnpm", ["add", "-D", "--allow-build=@ast-grep/cli", tarball], {
    cwd: toolsDir,
  });
  const toolsKit = join(toolsDir, "node_modules", ".bin", "validate-kit");
  const dvInitEntries = () => readdirSync(dvInitRoot).toSorted().join();
  const dvDry = run(toolsKit, ["init", "--dry-run"], { cwd: dvInitRoot });
  const afterDry = dvInitEntries();
  // A root with JS of its own (a script beside go.mod) gets a JS config.
  const ownJsRoot = join(tempRoot, "dv-init-own-js");
  mkdirSync(ownJsRoot);
  writeFileSync(join(ownJsRoot, "go.mod"), "module ownjs\n\ngo 1.22\n");
  writeFileSync(join(ownJsRoot, "build.mjs"), "export {};\n");
  const ownJsDry = run(toolsKit, ["init", "--dry-run"], { cwd: ownJsRoot });
  run(toolsKit, ["init", "--no-hook", "--no-mcp"], { cwd: dvInitRoot });
  const afterSkip = dvInitEntries();
  run(toolsKit, ["init"], { cwd: dvInitRoot });
  const toolsCommand = ".tools/vk/node_modules/.bin/validate-kit";
  const dvMcp = JSON.parse(readFileSync(join(dvInitRoot, ".mcp.json"), "utf8"))
    .mcpServers["Tester.MCP"];
  run("sh", ["-c", `${dvMcp.command} --version`], { cwd: dvInitRoot });
  assert(
    afterDry === ".tools,docs,frontend,go.mod" &&
      /Would write .*validate\.config\.json/.test(dvDry.stdout) &&
      /Would write .*validate\.config\.mjs/.test(ownJsDry.stdout) &&
      /Would write .*lefthook\.yml/.test(dvDry.stdout) &&
      afterSkip === ".tools,docs,frontend,go.mod,validate.config.json" &&
      dvMcp.command === toolsCommand &&
      scaffoldedHookRun(dvInitRoot) ===
        `${toolsCommand} check --staged --quiet`,
    `DV1/DV2/DV15 init: ${JSON.stringify({ afterDry, afterSkip, dvMcp, hook: scaffoldedHookRun(dvInitRoot), dry: dvDry.stdout, ownJs: ownJsDry.stdout })}`,
  );

  // DV21 (dark-visitor, 2026-10-10): init beside hook setups `lefthook
  // install` refuses or breaks (docs/research/hooks/lefthook-existing-hooks.md).
  // The machine's global git config is replaced, and lefthook is this
  // repository's.
  const dv21Env = (globalConfig) => ({
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    // Nothing from the developer's shell steers lefthook (LEFTHOOK,
    // LEFTHOOK_CONFIG, LEFTHOOK_OUTPUT, LEFTHOOK_VERBOSE, ...).
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("LEFTHOOK"))
        .map((key) => [key, ""]),
    ),
    PATH: [
      dirname(installedKit),
      join(repoRoot, "node_modules", ".bin"),
      process.env.PATH,
    ].join(delimiter),
    GIT_AUTHOR_NAME: "smoke",
    GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "smoke",
    GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  });
  const noGlobal = join(tempRoot, "dv21-gitconfig");
  writeFileSync(noGlobal, "");
  const dv21Init = (name, setup, env = dv21Env(noGlobal), sub = ".") => {
    const dir = join(tempRoot, name);
    mkdirSync(dir);
    run("git", ["init", "--quiet"], { cwd: dir, env });
    setup(dir, (hook, text) =>
      writeFileSync(join(dir, ".git", "hooks", hook), text, { mode: 0o755 }),
    );
    const init = run(installedKit, ["init", "--no-mcp"], {
      cwd: join(dir, sub),
      env,
      allowedStatuses: [0, 2],
    });
    return { dir, init, hooks: join(dir, ".git", "hooks"), env };
  };
  const dv21 = {};
  // The reported setup: core.hooksPath=.git/hooks (relative) and a hook of
  // the user's own. It keeps running, first, and check --staged runs after.
  const reported = dv21Init("dv21-reported", (dir, hook) => {
    run("git", ["config", "--local", "core.hooksPath", ".git/hooks"], {
      cwd: dir,
    });
    hook("pre-commit", oldHook(dir));
  });
  writeFileSync(join(reported.dir, "a.md"), "hello\n");
  run("git", ["add", "a.md"], { cwd: reported.dir, env: reported.env });
  // The job names show the order.
  const reportedCommit = run("git", ["commit", "--quiet", "-m", "one"], {
    cwd: reported.dir,
    env: { ...reported.env, LEFTHOOK_OUTPUT: "execution_info" },
    allowedStatuses: [0, 1],
  });
  dv21.reported =
    reported.init.status === 0 &&
    reportedCommit.status === 0 &&
    readFileSync(join(reported.hooks, "pre-commit.old"), "utf8") ===
      oldHook(reported.dir) &&
    readFileSync(join(reported.dir, "old-hook-ran"), "utf8") === "ran\n" &&
    /existing pre-commit hook[\s\S]*validate/.test(
      reportedCommit.stdout + reportedCommit.stderr,
    );
  // A global hooks folder whose pre-commit does not call lefthook: nothing
  // is installed there (it serves every repository), and init says so.
  const globalHooks = join(tempRoot, "dv21-global-hooks");
  mkdirSync(globalHooks);
  writeFileSync(join(globalHooks, "pre-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const withGlobal = join(tempRoot, "dv21-gitconfig-hooks");
  writeFileSync(withGlobal, `[core]\n\thooksPath = ${globalHooks}\n`);
  const global = dv21Init("dv21-global", () => {}, dv21Env(withGlobal));
  dv21.globalRefused =
    global.init.status === 2 &&
    readdirSync(globalHooks).join() === "pre-commit" &&
    readFileSync(join(globalHooks, "pre-commit"), "utf8") ===
      "#!/bin/sh\nexit 0\n" &&
    global.init.stderr.includes("does not call lefthook");
  // The user's own lefthook config (.lefthook.yml): a new lefthook.yml would
  // take over from it, so init writes none and prints the job to add.
  const userConfig = "pre-commit:\n  jobs:\n    - run: echo mine\n";
  const own = dv21Init("dv21-own-config", (dir) =>
    writeFileSync(join(dir, ".lefthook.yml"), userConfig),
  );
  dv21.userConfigKept =
    own.init.status === 2 &&
    !existsSync(join(own.dir, "lefthook.yml")) &&
    readFileSync(join(own.dir, ".lefthook.yml"), "utf8") === userConfig &&
    own.init.stderr.includes("run: validate-kit check --staged");
  // A hook of the user's beside a pre-commit.old: init moves neither.
  const both = dv21Init("dv21-both", (_dir, hook) => {
    hook("pre-commit", "#!/bin/sh\necho a\n");
    hook("pre-commit.old", "#!/bin/sh\necho b\n");
  });
  dv21.oldConflict =
    both.init.status === 2 &&
    both.init.stderr.includes("init moves neither") &&
    !existsSync(join(both.dir, "lefthook.yml")) &&
    readFileSync(join(both.hooks, "pre-commit"), "utf8") ===
      "#!/bin/sh\necho a\n" &&
    readFileSync(join(both.hooks, "pre-commit.old"), "utf8") ===
      "#!/bin/sh\necho b\n";
  // A config the user edited around the kit's job is the user's: kept.
  const edited =
    "pre-commit:\n  jobs:\n    - run: pnpm lint && validate-kit check --staged\n";
  const editedInit = dv21Init("dv21-edited", (dir) =>
    writeFileSync(join(dir, "lefthook.yml"), edited),
  );
  dv21.editedKept =
    readFileSync(join(editedInit.dir, "lefthook.yml"), "utf8") === edited;
  // From a subfolder: lefthook reads its config at the work tree's root, so
  // init moves no hook and writes no config there.
  const subRoot = dv21Init(
    "dv21-sub",
    (dir, hook) => {
      mkdirSync(join(dir, "pkg"));
      hook("pre-commit", "#!/bin/sh\necho mine\n");
    },
    dv21Env(noGlobal),
    "pkg",
  );
  const subInit = subRoot.init;
  dv21.subfolderRefused =
    subInit.status === 2 &&
    subInit.stderr.includes("root: pkg/") &&
    readFileSync(join(subRoot.hooks, "pre-commit"), "utf8") ===
      "#!/bin/sh\necho mine\n" &&
    !existsSync(join(subRoot.dir, "pkg", "lefthook.yml"));
  assert(
    Object.values(dv21).every(Boolean),
    `DV21 init beside existing hooks: ${JSON.stringify({ dv21, reported: [reported.init.stdout, reported.init.stderr, reportedCommit.stdout, reportedCommit.stderr], global: global.init.stderr, own: own.init.stderr, both: both.init.stderr, sub: subInit.stderr })}`,
  );

  // PF1: init wires a pre-push preflight, the run CI makes (`check --profile
  // ci`), so what a push carries is judged before CI sees it. A pre-push hook
  // of the user's runs first, with git's arguments and the pushed refs; the
  // remote's path has a space, which the arguments must survive.
  const pf1 = {};
  const remote = join(tempRoot, "pf1 remote.git");
  run("git", ["init", "--quiet", "--bare", remote], { env: dv21Env(noGlobal) });
  const pushArgs = join(tempRoot, "pf1-old-push-args");
  const pushRefs = join(tempRoot, "pf1-old-push-refs");
  const pushed = dv21Init("pf1-push", (dir, hook) => {
    hook(
      "pre-push",
      `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$2" >> ${JSON.stringify(pushArgs)}\ncat >> ${JSON.stringify(pushRefs)}\n`,
    );
    // Committed before the hooks exist: no pre-commit run ever saw it.
    writeFileSync(join(dir, "app.mjs"), "debugger;\nexport const a = 1;\n");
    for (const args of [
      ["add", "app.mjs"],
      ["commit", "--quiet", "-m", "debugger"],
      ["remote", "add", "origin", remote],
    ])
      run("git", args, { cwd: dir, env: dv21Env(noGlobal) });
  });
  const pushGit = (args, allowedStatuses = [0]) =>
    run("git", args, { cwd: pushed.dir, env: pushed.env, allowedStatuses });
  const remoteHeads = () =>
    run("git", ["ls-remote", "--heads", remote], {
      env: pushed.env,
    }).stdout.trim();
  pushGit(["add", "-A"]);
  pushGit(["commit", "--quiet", "-m", "hooks"]);
  const blocked = pushGit(["push", "origin", "HEAD"], [0, 1]);
  pf1.blocked =
    pushed.init.status === 0 &&
    blocked.status === 1 &&
    remoteHeads() === "" &&
    // Only the failure prints: the finding and the exit code.
    /app\.mjs:1:1 warning oxlint\/eslint\(no-debugger\)[\s\S]*validate-kit: exit 1: 0 error\(s\), 1 warning\(s\)/.test(
      blocked.stdout + blocked.stderr,
    ) &&
    // No tool table, no passing tool: only what failed.
    !/All clear|oxlint\s+\S*✗|ast-grep\s+\S*✔/.test(
      blocked.stdout + blocked.stderr,
    );
  writeFileSync(join(pushed.dir, "app.mjs"), "export const a = 1;\n");
  pushGit(["add", "app.mjs"]);
  pushGit(["commit", "--quiet", "-m", "fix"]);
  const passed = pushGit(["push", "origin", "HEAD"], [0, 1]);
  const pushedHead = pushGit(["rev-parse", "HEAD"]).stdout.trim();
  // A passing hook prints nothing: git's own two lines are all there is.
  pf1.passed =
    passed.status === 0 &&
    remoteHeads().startsWith(pushedHead) &&
    /^To [^\n]+\n \* \[new branch\] +HEAD -> \S+\n$/.test(
      passed.stdout + passed.stderr,
    );
  const refLines = readFileSync(pushRefs, "utf8").trim().split("\n");
  pf1.oldHookFed =
    readFileSync(pushArgs, "utf8") === `origin|${remote}\norigin|${remote}\n` &&
    refLines.length === 2 &&
    refLines[1].includes(` ${pushedHead} `);
  // A ci run on a tree with uncommitted changes says so, since its verdict
  // covers them and a push carries only the commit; under --quiet only
  // beside a failure, so a quiet pass prints nothing.
  writeFileSync(join(pushed.dir, "app.mjs"), "export const a = 2;\n");
  const ciRun = (args) =>
    run(installedKit, ["--profile", "ci", ...args], {
      cwd: pushed.dir,
      env: pushed.env,
      allowedStatuses: [0, 1],
    });
  const dirtyLoud = ciRun([]);
  const dirtyQuiet = ciRun(["--quiet"]);
  writeFileSync(join(pushed.dir, "c.mjs"), "debugger;\n");
  const dirtyFailing = ciRun(["--quiet"]);
  rmSync(join(pushed.dir, "c.mjs"));
  const notice = /^The working tree has uncommitted changes[^\n]*\n$/;
  pf1.dirtySaid =
    dirtyLoud.status === 0 &&
    dirtyLoud.stderr.includes("The working tree has uncommitted changes") &&
    dirtyQuiet.status === 0 &&
    dirtyQuiet.stdout === "" &&
    dirtyQuiet.stderr === "" &&
    dirtyFailing.status === 1 &&
    notice.test(dirtyFailing.stderr) &&
    /c\.mjs:1:1 warning [^\n]*\nvalidate-kit: exit 1: /.test(
      dirtyFailing.stdout,
    );
  // So a push whose commit holds what the working tree has fixed passes, as
  // the tree does, and prints nothing (judging the pushed commit itself is
  // PUSH1). The commit is made with plumbing: the pre-commit hook would have
  // stopped it.
  writeFileSync(join(pushed.dir, "b.mjs"), "debugger;\n");
  pushGit(["add", "b.mjs"]);
  const badTree = pushGit(["write-tree"]).stdout.trim();
  const badCommit = pushGit(["commit-tree", badTree, "-p", "HEAD", "-m", "b"]);
  pushGit(["update-ref", "HEAD", badCommit.stdout.trim()]);
  writeFileSync(join(pushed.dir, "b.mjs"), "export {};\n");
  const dirtyPush = pushGit(["push", "origin", "HEAD"], [0, 1]);
  pf1.dirtyPushSilent =
    dirtyPush.status === 0 &&
    /^To [^\n]+\n [^\n]+\n$/.test(dirtyPush.stdout + dirtyPush.stderr);
  // A pre-commit hook of the user's that calls lefthook after a step of its
  // own is left as it is: only the missing pre-push hook is installed.
  const wrapper =
    '#!/bin/sh\necho own-step\nlefthook run pre-commit "$@" || exit $?\n';
  const wrapped = dv21Init("pf1-wrapper", (_dir, hook) =>
    hook("pre-commit", wrapper),
  );
  pf1.wrapperKept =
    wrapped.init.status === 0 &&
    readFileSync(join(wrapped.hooks, "pre-commit"), "utf8") === wrapper &&
    !existsSync(join(wrapped.hooks, "pre-commit.old")) &&
    /lefthook\s+run\s+"?pre-push/.test(
      readFileSync(join(wrapped.hooks, "pre-push"), "utf8"),
    );
  // A moved-aside hook that calls lefthook would run itself again: refused.
  const looping = dv21Init("pf1-loop", (_dir, hook) =>
    hook("pre-commit.old", wrapper),
  );
  pf1.loopRefused =
    looping.init.status === 2 &&
    looping.init.stderr.includes("would loop") &&
    !existsSync(join(looping.dir, "lefthook.yml"));
  // A config 0.2.2 wrote, pre-commit only, is replaced: init adds the
  // pre-push job and lefthook installs the hook. So is one written before
  // --quiet, and one of 0.2.3/0.2.4, which showed a passing job's output;
  // one the user edited (--quiet taken out) is kept.
  const v022 =
    "# Written by validate-kit init.\nassert_lefthook_installed: true\nmin_version: 1.10.0\n\npre-commit:\n  parallel: false\n  jobs:\n    - name: validate\n      run: validate-kit check --staged\n";
  const loudPush =
    "\npre-push:\n  parallel: false\n  jobs:\n    - name: preflight\n      run: validate-kit check --profile ci\n";
  const reinit = (name, text) => {
    const result = dv21Init(name, (dir) => {
      writeFileSync(join(dir, "lefthook.yml"), text);
      run("lefthook", ["install"], { cwd: dir, env: dv21Env(noGlobal) });
    });
    return {
      ...result,
      config: readFileSync(join(result.dir, "lefthook.yml"), "utf8"),
    };
  };
  const upgraded = reinit("pf1-upgrade", v022);
  const current = upgraded.config;
  const unquiet = reinit("pf1-upgrade-loud", v022 + loudPush);
  const v023 = reinit(
    "pf1-upgrade-023",
    current.replace(
      /# A passing hook prints nothing\.[\s\S]*?output:\n {2}- failure\n/,
      "# check --quiet prints what needs acting on: a failure's findings and exit\n# code, or that a push was judged with uncommitted changes. Run the command\n# without --quiet for the full report.\noutput:\n  - failure\n  - execution_out\n",
    ),
  );
  const userEdited = current.replace(
    "check --profile ci --quiet",
    "check --profile ci",
  );
  const kept = reinit("pf1-edited", userEdited);
  pf1.upgraded =
    upgraded.init.status === 0 &&
    current.includes("\npre-push:\n") &&
    current.includes("check --profile ci --quiet") &&
    /lefthook\s+run\s+"?pre-push/.test(
      readFileSync(join(upgraded.hooks, "pre-push"), "utf8"),
    ) &&
    unquiet.init.status === 0 &&
    unquiet.config === current &&
    v023.init.status === 0 &&
    v023.config === current &&
    !current.includes("execution_out") &&
    kept.init.status === 0 &&
    kept.config === userEdited;
  // A global folder whose pre-commit calls lefthook but has no pre-push: the
  // preflight would never run, and init installs nothing there.
  const halfHooks = join(tempRoot, "pf1-global-hooks");
  mkdirSync(halfHooks);
  writeFileSync(
    join(halfHooks, "pre-commit"),
    '#!/bin/sh\nlefthook run pre-commit "$@" || exit $?\n',
    { mode: 0o755 },
  );
  const halfConfig = join(tempRoot, "pf1-gitconfig-hooks");
  writeFileSync(halfConfig, `[core]\n\thooksPath = ${halfHooks}\n`);
  const half = dv21Init("pf1-global", () => {}, dv21Env(halfConfig));
  pf1.globalPushRefused =
    half.init.status === 2 &&
    readdirSync(halfHooks).join() === "pre-commit" &&
    // git names the folder by its real path (/private/var on macOS).
    /There is no \S*\/pf1-global-hooks\/pre-push /.test(half.init.stderr);
  // The user's config runs the staged check but no preflight: kept as it
  // is, and init prints the one job it lacks.
  const commitOnly =
    "pre-commit:\n  jobs:\n    - run: validate-kit check --staged\n";
  const userPush = dv21Init("pf1-user-config", (dir) =>
    writeFileSync(join(dir, "lefthook.yml"), commitOnly),
  );
  pf1.userConfigNeedsPush =
    userPush.init.status === 2 &&
    readFileSync(join(userPush.dir, "lefthook.yml"), "utf8") === commitOnly &&
    userPush.init.stderr.includes("run: validate-kit check --profile ci") &&
    !userPush.init.stderr.includes("run: validate-kit check --staged");
  assert(
    Object.values(pf1).every(Boolean),
    `PF1 pre-push preflight: ${JSON.stringify({ pf1, init: [pushed.init.stdout, pushed.init.stderr], blocked: blocked.stdout + blocked.stderr, passed: passed.stdout + passed.stderr, dirty: [dirtyLoud.stderr, dirtyQuiet.stdout + dirtyQuiet.stderr], wrapped: wrapped.init.stdout + wrapped.init.stderr, looping: looping.init.stderr, dirtyPush: dirtyPush.stdout + dirtyPush.stderr, upgraded: [upgraded, unquiet, kept].map(({ init }) => init.stdout + init.stderr), half: half.init.stderr, userPush: userPush.init.stderr })}`,
  );

  // Project-level tools, run evidence and plan-based doctor
  // (engine-generalisation.md, C3). The Go-only project is reused: it has no
  // TS toolchain to get in the way.
  const impostorConfig = join(impostorRoot, "validate.config.json");
  const writeImpostorConfig = (config) =>
    writeFileSync(impostorConfig, `${JSON.stringify(config, null, 2)}\n`);
  const planTools = (args) =>
    parseJsonOutput(
      run(installedKit, ["list", "--json", ...args], { cwd: impostorRoot }),
      `list --json ${args.join(" ")}`,
    ).tasks.map((task) => task.tool);

  // Outside a repository there is no commit to tie a report to.
  const outsideRepo = parseJsonOutput(
    run(installedKit, ["--only", "ast-grep", "--json"], {
      cwd: impostorRoot,
      allowedStatuses: [0, 1],
    }),
    "check --json outside a repository",
  );
  assert(
    outsideRepo.schemaVersion === 2 &&
      outsideRepo.evidence.revision === null &&
      outsideRepo.evidence.dirty === null,
    `evidence outside a repository must have no revision: ${JSON.stringify(outsideRepo.evidence)}`,
  );

  // A tool with no language is planned whatever changed, and only when its
  // own condition holds; --lang excludes it.
  writeFileSync(join(impostorRoot, "openapi.json"), "{}\n");
  run("git", ["init", "--quiet"], { cwd: impostorRoot });
  assert(
    !planTools([]).includes("oasdiff"),
    "oasdiff planned although apiDiff is not enabled",
  );
  writeImpostorConfig({
    extends: "recommended",
    apiDiff: { enabled: true, specs: ["openapi.json"] },
  });
  const stagedPlan = planTools(["--staged"]);
  assert(
    stagedPlan.join(",") === "oasdiff",
    `with nothing staged only the project-level tool should be planned, got: ${stagedPlan.join(",")}`,
  );
  assert(
    !planTools(["--lang", "go"]).includes("oasdiff"),
    "a --lang filter must exclude a tool that serves no language",
  );
  // Fan-out belongs to the adapter (engine-generalisation.md, C2): two specs
  // are two tasks, each carrying the spec it will diff.
  writeFileSync(join(impostorRoot, "second.json"), "{}\n");
  writeImpostorConfig({
    extends: "recommended",
    apiDiff: { enabled: true, specs: ["openapi.json", "second.json"] },
  });
  const specTasks = parseJsonOutput(
    run(installedKit, ["list", "--json"], { cwd: impostorRoot }),
    "list --json with two specs",
  ).tasks.filter((task) => task.tool === "oasdiff");
  assert(
    specTasks.map((task) => task.options?.spec).join(",") ===
      "openapi.json,second.json",
    `two specs must plan two oasdiff tasks, each naming its spec: ${JSON.stringify(specTasks)}`,
  );
  // It has no language to hang config on, so tools.<id> is where it is
  // configured.
  const apiDiff = { enabled: true, specs: ["openapi.json"] };
  writeImpostorConfig({
    extends: "recommended",
    apiDiff,
    tools: { oasdiff: { enabled: false } },
  });
  assert(
    !planTools([]).includes("oasdiff"),
    "tools.oasdiff.enabled: false must switch the project-level tool off",
  );
  // And its task must not hide that the source files reach no tool at all.
  writeImpostorConfig({
    extends: "recommended",
    apiDiff,
    languages: { go: { enabled: false } },
  });
  const unrouted = run(installedKit, ["list", "--json"], {
    cwd: impostorRoot,
    allowedStatuses: [0, 2],
  });
  assert(
    unrouted.status === 2,
    `source files that reach no tool must be a config error even with a project-level task planned: exit ${unrouted.status}`,
  );

  // doctor asks the planner what this project needs. With nothing on PATH
  // the Go project is incomplete; with Go switched off nothing is needed.
  // The kit is started through node's own path, so PATH can be truly empty
  // and the result does not depend on what this machine has installed.
  const emptyBin = join(tempRoot, "empty-bin");
  mkdirSync(emptyBin);
  const kitEntry = join(
    consumerRoot,
    "node_modules/validate-kit/bin/validate-kit.mjs",
  );
  const doctorIn = (config) => {
    writeImpostorConfig(config);
    return run(process.execPath, [kitEntry, "doctor", "--json"], {
      cwd: impostorRoot,
      env: { PATH: emptyBin },
      allowedStatuses: [0, 3],
    });
  };
  const doctorGoOn = doctorIn({ extends: "recommended" });
  const goTools = parseJsonOutput(doctorGoOn, "doctor --json").tools;
  const goFmt = goTools.find((tool) => tool.id === "gofmt");
  const goFumpt = goTools.find((tool) => tool.id === "gofumpt");
  const goLint = goTools.find((tool) => tool.id === "golangci-lint");
  // main.go and no go.mod: the file tool is needed; the module tool is not
  // (it cannot run outside a module, R2); gofumpt is not configured, so Go's
  // own gofmt is the formatter (R11).
  assert(
    doctorGoOn.status === 3 &&
      goFmt.status === "missing-required" &&
      goFumpt.status === "not-needed" &&
      goLint.status === "not-needed",
    `doctor must require Go tools in a Go project: exit ${doctorGoOn.status}, gofmt ${goFmt.status}, gofumpt ${goFumpt.status}, golangci-lint ${goLint.status}`,
  );
  const doctorGoOff = doctorIn({
    extends: "recommended",
    languages: { go: { enabled: false } },
  });
  assert(
    doctorGoOff.status === 0,
    `doctor must not require tools the config switched off: exit ${doctorGoOff.status}`,
  );

  // Invariants (engine-generalisation.md, C4b): plain data in a JSON config,
  // each one a gate named inv:<id>.
  mkdirSync(join(impostorRoot, "proof"), { recursive: true });
  mkdirSync(join(impostorRoot, "worker"), { recursive: true });
  writeFileSync(
    join(impostorRoot, "proof", "lease.tla"),
    "---- MODULE lease ----\n",
  );
  writeFileSync(join(impostorRoot, "notes.txt"), "unrelated\n");
  writeFileSync(join(impostorRoot, "worker", "run.go"), "package worker\n");
  writeImpostorConfig({
    extends: "recommended",
    invariants: [
      {
        id: "JOB-001",
        statement: "a worker with a stale lease cannot commit",
        evidence: ["proof/lease.tla"],
        covers: ["worker/**"],
        check: "echo 2 passed",
        expect: "passed",
      },
      {
        id: "SILENT",
        statement: "the suite ran",
        check: "true",
        expect: "passed",
      },
      {
        id: "GONE",
        statement: "the model exists",
        evidence: ["proof/missing.tla"],
      },
    ],
  });
  const invariant = (id, allowedStatuses) => {
    const result = run(installedKit, ["--only", `inv:${id}`, "--json"], {
      cwd: impostorRoot,
      allowedStatuses,
    });
    return {
      status: result.status,
      json: parseJsonOutput(result, `inv:${id}`),
    };
  };
  const holds = invariant("JOB-001", [0]);
  assert(
    holds.json.ranTools.join(",") === "inv:JOB-001" &&
      holds.json.findings.length === 0,
    `--only inv:JOB-001 must run exactly it, and it holds: ${JSON.stringify(holds.json.ranTools)}`,
  );
  const silent = invariant("SILENT", [1]);
  assert(
    silent.json.findings[0]?.message.includes("did not contain"),
    "an invariant whose check printed nothing must fail its expect",
  );
  const gone = invariant("GONE", [1]);
  assert(
    gone.json.findings.length === 1 &&
      gone.json.findings[0].file.endsWith("/proof/missing.tla") &&
      gone.json.findings[0].message.includes("does not exist"),
    `missing evidence must be a finding at that path: ${JSON.stringify(gone.json.findings)}`,
  );
  // A failing check points at the evidence, not at the project directory.
  writeImpostorConfig({
    extends: "recommended",
    invariants: [
      {
        id: "JOB-001",
        statement: "a worker with a stale lease cannot commit",
        evidence: ["proof/lease.tla"],
        check: "exit 3",
      },
    ],
  });
  const located = invariant("JOB-001", [1]);
  assert(
    located.json.findings[0]?.file.endsWith("/proof/lease.tla"),
    `a failed invariant must point at its evidence: ${JSON.stringify(located.json.findings)}`,
  );
  // In a changed-file run, an invariant with `covers` runs only when one of
  // its files changed; one without runs whatever changed.
  writeImpostorConfig({
    extends: "recommended",
    invariants: [
      {
        id: "JOB-001",
        statement: "a worker with a stale lease cannot commit",
        covers: ["worker/**"],
        check: "echo 2 passed",
      },
      { id: "ALWAYS", statement: "always checked", check: "true" },
    ],
  });
  run("git", ["add", "notes.txt"], { cwd: impostorRoot });
  const unrelated = planTools(["--staged"]);
  run("git", ["add", "worker/run.go"], { cwd: impostorRoot });
  const related = planTools(["--staged"]);
  assert(
    !unrelated.includes("inv:JOB-001") &&
      unrelated.includes("inv:ALWAYS") &&
      related.includes("inv:JOB-001"),
    `covers must decide changed-file runs: unrelated ${unrelated.join(",")} / related ${related.join(",")}`,
  );
  run("git", ["reset", "--quiet"], { cwd: impostorRoot });

  // Changed-file runs read git's change list correctly (engine-
  // generalisation.md, C4b rows 8-11): deletions and files outside the
  // validation scope reach `covers`, and a project in a sub-directory of its
  // repository sees its own staged files, non-ASCII names included.
  const historyRoot = join(tempRoot, "history");
  mkdirSync(join(historyRoot, "app", "src"), { recursive: true });
  mkdirSync(join(historyRoot, "proof"), { recursive: true });
  writeFileSync(
    join(historyRoot, "proof", "lease.tla"),
    "---- MODULE lease ----\n",
  );
  writeFileSync(
    join(historyRoot, "app", "src", "ok.ts"),
    "export const ok = 1;\n",
  );
  writeFileSync(
    join(historyRoot, "validate.config.json"),
    `${JSON.stringify(
      {
        extends: "recommended",
        include: ["app", "proof"],
        invariants: [
          {
            id: "SPEC",
            statement: "the lease model is kept",
            covers: ["proof/**", "!proof/drafts/**"],
            check: "true",
          },
          {
            id: "DIR",
            statement: "the proof directory is kept",
            covers: ["nothing-matches/**"],
            evidence: ["proof/"],
            check: "true",
          },
          {
            id: "NOTES",
            statement: "the notes were reviewed",
            covers: ["notes.txt"],
            check: "true",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const inHistory = (args, options = {}) =>
    run("git", args, { cwd: historyRoot, ...options });
  inHistory(["init", "--quiet"]);
  inHistory([
    "add",
    "proof/lease.tla",
    "app/src/ok.ts",
    "validate.config.json",
  ]);
  inHistory([
    "-c",
    "user.email=smoke@example.invalid",
    "-c",
    "user.name=smoke",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const historyPlan = () =>
    parseJsonOutput(
      run(installedKit, ["list", "--staged", "--json"], { cwd: historyRoot }),
      "list --staged in the history repo",
    ).tasks.map((task) => task.tool);
  inHistory(["rm", "--quiet", "proof/lease.tla"]);
  const afterDelete = historyPlan();
  assert(
    afterDelete.includes("inv:SPEC") &&
      afterDelete.includes("inv:DIR") &&
      !afterDelete.includes("inv:NOTES"),
    `deleting a covered file, or a file under an evidence directory, must re-run its invariant: ${afterDelete.join(",")}`,
  );
  inHistory(["reset", "--quiet", "HEAD", "--", "proof/lease.tla"]);
  inHistory(["checkout", "--quiet", "--", "proof/lease.tla"]);
  writeFileSync(join(historyRoot, "notes.txt"), "reviewed\n");
  inHistory(["add", "notes.txt"]);
  const outsideScope = historyPlan();
  assert(
    outsideScope.includes("inv:NOTES") && !outsideScope.includes("inv:SPEC"),
    `a covered file outside the validation scope must still count: ${outsideScope.join(",")}`,
  );
  inHistory(["reset", "--quiet"]);
  mkdirSync(join(historyRoot, "proof", "drafts"));
  writeFileSync(join(historyRoot, "proof", "drafts", "idea.txt"), "draft\n");
  inHistory(["add", "proof/drafts/idea.txt"]);
  const excluded = historyPlan();
  assert(
    !excluded.includes("inv:SPEC") && !excluded.includes("inv:NOTES"),
    `a change matched only by a negated pattern must not run the invariant: ${excluded.join(",")}`,
  );
  inHistory(["reset", "--quiet"]);
  const consoleLine = "export function f() {\n  console.log(1);\n}\n";
  writeFileSync(join(historyRoot, "app", "src", "bad.ts"), consoleLine);
  writeFileSync(join(historyRoot, "app", "src", "café.ts"), consoleLine);
  inHistory(["add", "app/src/bad.ts", "app/src/café.ts"]);
  const subdir = run(
    installedKit,
    ["app", "--staged", "--only", "ast-grep", "--json"],
    { cwd: historyRoot, allowedStatuses: [0, 1] },
  );
  const subdirFiles = parseJsonOutput(subdir, "check app --staged")
    .findings.filter((finding) => finding.ruleId === "ts-no-console")
    .map((finding) => finding.file.split("/").pop())
    .toSorted();
  assert(
    subdir.status === 1 && subdirFiles.join(",") === "bad.ts,café.ts",
    `a project in a sub-directory must see its staged files: exit ${subdir.status}, findings in ${subdirFiles.join(",")}`,
  );
  // Under ci an empty plan is an error only for a full-scope run: a staged
  // run where nothing relevant changed is clean.
  inHistory(["reset", "--quiet"]);
  const ciNothingStaged = run(
    installedKit,
    ["app", "--profile", "ci", "--staged", "--json"],
    { cwd: historyRoot, allowedStatuses: [0, 2] },
  );
  assert(
    ciNothingStaged.status === 0,
    `ci with nothing staged must be clean, not a config error: exit ${ciNothingStaged.status} ${ciNothingStaged.stderr}`,
  );
  writeImpostorConfig({
    extends: "recommended",
    invariants: [{ id: "EMPTY", statement: "nothing to check" }],
  });
  const empty = run(installedKit, ["list", "--json"], {
    cwd: impostorRoot,
    allowedStatuses: [0, 2],
  });
  assert(
    empty.status === 2 && empty.stderr.includes("needs a check command"),
    `an invariant with nothing to check must be a config error: exit ${empty.status} ${empty.stderr}`,
  );

  // In this repository the report names the commit it judged, the config it
  // used and the kit that produced it.
  const repoRun = parseJsonOutput(
    run("node", [builtCli, "--only", "ast-grep", "--json"]),
    "check --json in this repository",
  );
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const dirty = run("git", ["status", "--porcelain"]).stdout.trim() !== "";
  const kitVersion = JSON.parse(
    readFileSync(join(repoRoot, "packages/validate-kit/package.json"), "utf8"),
  ).version;
  assert(
    repoRun.evidence.revision === head && repoRun.evidence.dirty === dirty,
    `evidence must name the judged commit: ${JSON.stringify(repoRun.evidence)} vs ${head} dirty=${dirty}`,
  );
  assert(
    /^[0-9a-f]{64}$/.test(repoRun.evidence.configDigest) &&
      repoRun.evidence.kitVersion === kitVersion &&
      run("node", [builtCli, "--version"]).stdout.trim() === kitVersion,
    `evidence must carry the config digest and the kit version ${kitVersion}: ${JSON.stringify(repoRun.evidence)}`,
  );
  // The digest names the policy, not how the run was executed: it must be
  // the same on a laptop and on a CI runner with another core count.
  const oneWorker = parseJsonOutput(
    run("node", [
      builtCli,
      "--only",
      "ast-grep",
      "--json",
      "--concurrency",
      "1",
    ]),
    "check --json --concurrency 1",
  );
  assert(
    oneWorker.evidence.configDigest === repoRun.evidence.configDigest,
    "the config digest changes with --concurrency",
  );

  writeFileSync(
    configPath,
    [
      'import { defineConfig } from "validate-kit";',
      "",
      "export default defineConfig({",
      '  extends: "strict",',
      "});",
      "",
    ].join("\n"),
  );

  const doctorResult = run("pnpm", ["exec", "check", "doctor", "--json"], {
    cwd: consumerRoot,
    allowedStatuses: [0, 3],
  });
  const doctorJson = parseJsonOutput(doctorResult, "check doctor --json");
  assert(Array.isArray(doctorJson.tools), "doctor JSON must include tools");
  assert(
    doctorJson.tools.some((tool) => tool.id === "ast-grep"),
    "doctor JSON must report bundled ast-grep",
  );

  // Options built at plan time are what the tool gets at run time: the
  // strict preset's rule ids travel on the ast-grep task.
  const consumerPlan = parseJsonOutput(
    run("pnpm", ["exec", "check", "list", "--json"], { cwd: consumerRoot }),
    "list --json in the consumer",
  );
  const plannedRuleIds =
    consumerPlan.tasks.find((task) => task.tool === "ast-grep")?.options
      ?.ruleIds ?? [];
  for (const ruleId of requiredRuleIds) {
    assert(
      plannedRuleIds.includes(ruleId),
      `list --json must show the rule ids ast-grep will run, missing ${ruleId}`,
    );
  }

  const lockHashBeforeCheck = hashFile(lockfilePath);
  const checkResult = run(
    "pnpm",
    ["exec", "check", "--only", "ast-grep", "--json"],
    {
      cwd: consumerRoot,
      allowedStatuses: [1],
    },
  );
  const checkJson = parseJsonOutput(
    checkResult,
    "check --only ast-grep --json",
  );
  // ruff runs with --no-cache: a check writes nothing into the project.
  run("pnpm", ["exec", "check", "--only", "ruff", "ruff-format"], {
    cwd: consumerRoot,
    allowedStatuses: [0, 1, 3],
  });
  assert(
    !existsSync(join(consumerRoot, ".ruff_cache")) &&
      !existsSync(join(consumerRoot, "py", ".ruff_cache")),
    "ruff must not leave a .ruff_cache in the project",
  );
  const actualRuleIds = new Set(
    checkJson.findings?.map((finding) => finding.ruleId) ?? [],
  );
  for (const ruleId of requiredRuleIds) {
    assert(
      actualRuleIds.has(ruleId),
      `external smoke missing bundled rule finding: ${ruleId}`,
    );
  }

  const fixResult = run(
    "pnpm",
    ["exec", "check", "--only", "ast-grep", "--fix", "--json"],
    {
      cwd: consumerRoot,
      allowedStatuses: [1],
    },
  );
  parseJsonOutput(fixResult, "check --only ast-grep --fix --json");

  const fixedTs = readFileSync(join(consumerRoot, "src", "index.ts"), "utf8");
  const fixedPy = readFileSync(join(consumerRoot, "py", "score.py"), "utf8");
  // ts-no-console is REPORT-ONLY (autofix: none since f93770e — the deletion
  // autofix corrupted braceless control flow). --fix must LEAVE console.log
  // in place and keep reporting it.
  assert(
    fixedTs.includes("console.log"),
    "external --fix removed console.log (ts-no-console must be report-only)",
  );
  assert(
    fixedTs.includes("value === 1"),
    "external --fix did not rewrite loose equality",
  );
  assert(
    fixedPy.includes("value is None"),
    "external --fix did not rewrite Python == None",
  );
  assert(
    hashFile(lockfilePath) === lockHashBeforeCheck,
    "external check/check --fix modified the consumer pnpm lockfile",
  );

  // A project's own tools and command gates (engine-generalisation.md, C4a).
  writeFileSync(configPath, gatesConfig("echo boom; exit 7"));
  const gate = (only, allowedStatuses) => {
    const result = run("pnpm", ["exec", "check", "--only", ...only, "--json"], {
      cwd: consumerRoot,
      allowedStatuses,
    });
    return {
      status: result.status,
      json: parseJsonOutput(result, only.join(" ")),
    };
  };
  const gatePass = gate(["gate-pass"], [0]);
  assert(
    gatePass.json.findings.length === 0,
    "a passing command gate must report nothing",
  );
  const gateFail = gate(["gate-fail"], [1]);
  const failFinding = gateFail.json.findings[0];
  assert(
    gateFail.json.findings.length === 1 &&
      failFinding.tool === "gate-fail" &&
      failFinding.message.includes("the build must succeed") &&
      failFinding.message.includes("exited 7") &&
      failFinding.message.includes("boom"),
    `a failing command must be one finding that says why: ${JSON.stringify(gateFail.json.findings)}`,
  );
  assert(
    !("language" in failFinding),
    "a finding on a file with no language must not carry one",
  );
  const gateSilent = gate(["gate-silent"], [1]);
  assert(
    gateSilent.json.findings[0]?.message.includes("did not contain"),
    "a command that printed nothing must fail its `expect`",
  );
  const gateMissing = gate(["gate-missing"], [4]);
  assert(
    gateMissing.json.crashed.some((issue) => issue.id === "gate-missing"),
    "a command that cannot run must be a crash, not a finding",
  );
  const isolated = gate(["gate-pass", "throws", "ast-grep"], [4]);
  assert(
    isolated.json.crashed.some((issue) => issue.id === "throws") &&
      isolated.json.findings.some((finding) => finding.tool === "ast-grep"),
    "a project adapter that throws must not take the other tools' findings with it",
  );
  // A gate's timeout must stop everything the shell started, not just the
  // shell: `sleep; echo` would otherwise keep the pipes open for 30 s more.
  const slowStarted = Date.now();
  const gateSlow = gate(["gate-slow"], [4]);
  const slowSeconds = (Date.now() - slowStarted) / 1000;
  const survivors = run("ps", ["-axo", "command"])
    .stdout.split("\n")
    // The process itself, not any command line that merely mentions it.
    .filter((line) => line.trim() === "sleep 31.7");
  assert(
    gateSlow.json.crashed.some((issue) => /timed out/.test(issue.stderr)) &&
      slowSeconds < 20 &&
      survivors.length === 0,
    `a timed-out gate must end promptly and leave nothing running: ${slowSeconds}s, survivors ${JSON.stringify(survivors)}, crashed ${JSON.stringify(gateSlow.json.crashed)}`,
  );
  // Strict ci (engine-generalisation.md, C6): a missing optional tool is a
  // visible skip by default and incomplete coverage under the ci profile.
  const optionalRun = (profileArgs, allowedStatuses) => {
    const result = run(
      "pnpm",
      ["exec", "check", ...profileArgs, "--only", "opt-missing", "--json"],
      { cwd: consumerRoot, allowedStatuses },
    );
    return {
      status: result.status,
      json: parseJsonOutput(result, "opt-missing"),
    };
  };
  const optionalDefault = optionalRun([], [0]);
  const optionalCi = optionalRun(["--profile", "ci"], [3]);
  assert(
    optionalDefault.json.skippedOptional.some((t) => t.id === "opt-missing") &&
      optionalCi.json.incomplete.some((t) => t.id === "opt-missing") &&
      optionalCi.json.toolStatus["opt-missing"] === "not_run",
    `a missing optional tool: skipped by default, incomplete under ci: ${JSON.stringify(optionalCi.json)}`,
  );
  const statuses = {
    pass: gatePass.json.toolStatus["gate-pass"],
    fail: gateFail.json.toolStatus["gate-fail"],
    inconclusive: gateMissing.json.toolStatus["gate-missing"],
    notRun: optionalDefault.json.toolStatus["opt-missing"],
  };
  assert(
    JSON.stringify(statuses) ===
      JSON.stringify({
        pass: "pass",
        fail: "fail",
        inconclusive: "inconclusive",
        notRun: "not_run",
      }),
    `toolStatus must tell pass, fail, crash and not-run apart: ${JSON.stringify(statuses)}`,
  );
  // doctor answers for a profile (engine-generalisation.md, G1.6b).
  const doctorRow = (profileArgs, id) => {
    const result = run(
      "pnpm",
      ["exec", "check", "doctor", ...profileArgs, "--json"],
      { cwd: consumerRoot, allowedStatuses: [0, 3] },
    );
    return {
      status: result.status,
      row: parseJsonOutput(result, "doctor --json").tools.find(
        (tool) => tool.id === id,
      ),
    };
  };
  const doctorPlain = doctorRow([], "opt-missing");
  const doctorCi = doctorRow(["--profile", "ci"], "opt-missing");
  // opt-missing is a verify-tier gate, which the dev profile never runs.
  const doctorDev = doctorRow(["--profile", "dev"], "opt-missing");
  assert(
    doctorPlain.row?.status === "missing-optional" &&
      doctorCi.row?.status === "missing-required" &&
      doctorCi.status === 3 &&
      doctorDev.row?.status === "not-needed",
    `doctor must answer for the profile: plain ${doctorPlain.row?.status}, ci ${doctorCi.row?.status} exit ${doctorCi.status}, dev ${doctorDev.row?.status}`,
  );

  for (const args of [["--ci"], ["--profile", "release"]]) {
    const usage = run("pnpm", ["exec", "check", ...args], {
      cwd: consumerRoot,
      allowedStatuses: [0, 1, 2],
    });
    assert(
      usage.status === 2,
      `${args.join(" ")} must be a usage error (exit 2), got ${usage.status}`,
    );
  }
  const emptyRoot = join(tempRoot, "empty");
  mkdirSync(emptyRoot);
  const emptyDefault = run(installedKit, ["--json"], {
    cwd: emptyRoot,
    allowedStatuses: [0, 2],
  });
  const emptyCi = run(installedKit, ["--profile", "ci"], {
    cwd: emptyRoot,
    allowedStatuses: [0, 2],
  });
  assert(
    emptyDefault.status === 0 && emptyCi.status === 2,
    `an empty plan: clean by default, a config error under ci; got ${emptyDefault.status} and ${emptyCi.status}`,
  );

  // tools.<id>: the config's timeout wins over the tool's own, and options
  // reach the adapter (engine-generalisation.md, C5).
  const hangStarted = Date.now();
  const gateHang = gate(["gate-hang"], [4]);
  const hangSeconds = (Date.now() - hangStarted) / 1000;
  assert(
    gateHang.json.crashed.some((issue) =>
      /timed out after 1s/.test(issue.stderr),
    ) && hangSeconds < 20,
    `tools.<id>.timeoutMs must override the tool's own: ${hangSeconds}s ${JSON.stringify(gateHang.json.crashed)}`,
  );
  const readsTask = parseJsonOutput(
    run("pnpm", ["exec", "check", "list", "--json"], { cwd: consumerRoot }),
    "list --json with tool options",
  ).tasks.find((task) => task.tool === "reads-options");
  assert(
    JSON.stringify(readsTask?.options) ===
      JSON.stringify({ models: ["Lease.cfg"] }),
    `tools.<id>.options must reach the adapter: ${JSON.stringify(readsTask)}`,
  );

  // Under --fix a tool that cannot fix runs once, after the fixes.
  run(
    "pnpm",
    ["exec", "check", "--only", "gate-count", "ast-grep", "--fix", "--json"],
    { cwd: consumerRoot, allowedStatuses: [0, 1] },
  );
  const gateRunsUnderFix = readFileSync(
    join(consumerRoot, ".gate-runs"),
    "utf8",
  )
    .trim()
    .split("\n").length;
  assert(
    gateRunsUnderFix === 1,
    `a gate must run once under --fix, ran ${gateRunsUnderFix} times`,
  );

  // Naming a tool with --only runs it whatever its tier: the alternative is
  // a clean exit that ran nothing.
  const onlyUnderDev = run(
    "pnpm",
    ["exec", "check", "--profile", "dev", "--only", "gate-deep", "--json"],
    { cwd: consumerRoot },
  );
  assert(
    parseJsonOutput(
      onlyUnderDev,
      "--profile dev --only gate-deep",
    ).ranTools.includes("gate-deep"),
    "--only must run the named tool even when the profile's tier would skip it",
  );

  const toolsUnder = (args) =>
    parseJsonOutput(
      run("pnpm", ["exec", "check", "list", "--json", ...args], {
        cwd: consumerRoot,
      }),
      `list --json ${args.join(" ")}`,
    ).tasks.map((task) => task.tool);
  const defaultTools = toolsUnder([]);
  assert(
    defaultTools.includes("gate-pass") && !defaultTools.includes("gate-deep"),
    `a normal run plans verify-tier gates and no deep ones: ${defaultTools.join(",")}`,
  );
  assert(
    !toolsUnder(["--profile", "dev"]).includes("gate-pass"),
    "the dev profile must plan fast-tier tools only",
  );
  assert(
    toolsUnder(["--profile", "ci"]).includes("gate-deep"),
    "the ci profile must plan deep-tier gates",
  );
  // The digest names the policy, and a project adapter is part of it.
  writeFileSync(configPath, gatesConfig("echo boom; exit 8"));
  assert(
    gate(["gate-pass"], [0]).json.evidence.configDigest !==
      gatePass.json.evidence.configDigest,
    "changing a project gate's command must change the config digest",
  );
  writeFileSync(
    configPath,
    [
      'import { commandGate, defineConfig } from "validate-kit";',
      'export default defineConfig({ adapters: [commandGate({ id: "oxlint", run: "true" })] });',
      "",
    ].join("\n"),
  );
  const duplicateId = run("pnpm", ["exec", "check", "list", "--json"], {
    cwd: consumerRoot,
    allowedStatuses: [0, 2],
  });
  assert(
    duplicateId.status === 2 &&
      duplicateId.stderr.includes("Duplicate tool id"),
    `a project adapter must not reuse a built-in id: exit ${duplicateId.status} ${duplicateId.stderr}`,
  );
  const rejectedToolConfigs = [
    { tools: { "golangci-lint": { timeoutMs: 0 } } },
    { tools: { "golangci-lint": { timeoutMs: 2_147_483_648 } } },
    { languages: { go: { tools: { "golangci-lint": { options: {} } } } } },
  ];
  for (const bad of rejectedToolConfigs) {
    writeImpostorConfig({ extends: "recommended", ...bad });
    const rejected = run(installedKit, ["list", "--json"], {
      cwd: impostorRoot,
      allowedStatuses: [0, 2],
    });
    assert(
      rejected.status === 2,
      `${JSON.stringify(bad)} must be a config error: exit ${rejected.status}`,
    );
  }
  writeImpostorConfig({ extends: "recommended", adapters: [{ id: "x" }] });
  const jsonAdapters = run(installedKit, ["list", "--json"], {
    cwd: impostorRoot,
    allowedStatuses: [0, 2],
  });
  assert(
    jsonAdapters.status === 2 && jsonAdapters.stderr.includes("adapters"),
    `a JSON config cannot carry adapters: exit ${jsonAdapters.status} ${jsonAdapters.stderr}`,
  );

  // TLA+ through the tlc adapter (engine-generalisation.md, G2.1), on the
  // fixtures in tests/fixtures/formal/tla. Without TLC the cases are skipped
  // and say so; with SMOKE_REQUIRE_FORMAL=1 (CI) a missing TLC fails.
  const formal = {};
  if (hasTool("tlc", ["-h"])) {
    const tlaRoot = join(tempRoot, "tla");
    cpSync(join(repoRoot, "tests", "fixtures", "formal", "tla"), tlaRoot, {
      recursive: true,
    });
    const writeTlcConfig = (tlc, scope = {}) =>
      writeFileSync(
        join(tlaRoot, "validate.config.json"),
        `${JSON.stringify({ ...scope, tools: { tlc } }, null, 2)}\n`,
      );
    writeTlcConfig({
      options: {
        models: [
          {
            spec: "holds/Counter.tla",
            config: "holds/CounterTwin.cfg",
            expect: "violation",
          },
          {
            spec: "deadlock/Stop.tla",
            config: "deadlock/StopTwin.cfg",
            expect: "violation",
          },
          { spec: "holds/Counter.tla", config: "holds/CounterNothing.cfg" },
          // A model kept in another directory than its spec.
          { spec: "holds/Counter.tla", config: "configs/CounterElsewhere.cfg" },
        ],
      },
    });
    commitAll(tlaRoot);
    // TLC's state directories go under the kit's temp directory; a private
    // one shows whether the kit removed them.
    const tlcTemp = join(tempRoot, "tlc-temp");
    mkdirSync(tlcTemp);
    const runTlc = (args, allowedStatuses) =>
      run(installedKit, ["--only", "tlc", "--json", ...args], {
        cwd: tlaRoot,
        allowedStatuses,
        env: { TMPDIR: tlcTemp },
      });
    const treeBefore = treeHash(tlaRoot);
    const tlaRun = runTlc([], [1]);
    const tlaFindings = parseJsonOutput(tlaRun, "check --only tlc").findings;
    // Paths after the fixture root; findings carry the resolved temp path.
    const seen = findingLines(tlaFindings, "tla");
    const seeded = [
      "tlc/checks-nothing holds/Counter.tla:1",
      "tlc/config-error badcfg/Cfg.cfg:3",
      "tlc/deadlock deadlock/Stop.tla:1",
      "tlc/expected-violation deadlock/Stop.tla:1",
      "tlc/expected-violation holds/Counter.tla:1",
      "tlc/no-model holds/Ghost.tla:1",
      "tlc/no-model unmodelled/CounterBounds.tla:1",
      "tlc/no-model unmodelled/Lonely.tla:1",
      "tlc/parse-error broken/Broken.tla:4",
      "tlc/parse-error extends/Part.tla:3",
      "tlc/parse-error lexical/Tick.tla:4",
      "tlc/parse-error semantic/Unknown.tla:5",
      "tlc/safety variant/Toggle.tla:7",
      "tlc/safety violated/Lease.tla:11",
      "tlc/vacuous vacuous/Still.tla:1",
    ];
    assert(
      JSON.stringify(seen) === JSON.stringify(seeded),
      `tlc must report exactly the seeded problems: ${JSON.stringify(seen)}`,
    );
    assert(
      tlaFindings
        .find((f) => f.ruleId === "tlc/safety" && f.file.endsWith("Lease.tla"))
        .message.includes("AtMostOne"),
      "the safety finding must name the violated invariant",
    );
    // R10 (Apify; Codex P30): a model named <Spec>-<variant>.cfg beside its
    // spec is checked like Spec.cfg, and its finding names that model.
    assert(
      tlaFindings
        .find((f) => f.ruleId === "tlc/safety" && f.file.endsWith("Toggle.tla"))
        ?.message.includes("Toggle-strict.cfg"),
      "the variant model's violation must name Toggle-strict.cfg",
    );
    // DV12 (dark-visitor): twins named by config glob, with the kind of
    // violation each must show; the pretty report prints a formal rule id
    // once (tlc/safety, not tlc/tlc/safety).
    // Only variant/ is in scope: two models, not the whole fixture again.
    const variantRule = (kind) => {
      writeTlcConfig(
        {
          options: {
            violations: [
              { config: "variant/*-strict.cfg", ...(kind ? { kind } : {}) },
            ],
          },
        },
        { include: ["variant"] },
      );
      return findingLines(
        parseJsonOutput(runTlc([], [0, 1]), `tlc twins by glob (${kind})`)
          .findings,
        "tla",
      );
    };
    const twinSafety = variantRule("safety");
    const twinAny = variantRule(undefined);
    const twinLiveness = variantRule("liveness");
    const tlcPretty = run(installedKit, ["--only", "tlc"], {
      cwd: tlaRoot,
      allowedStatuses: [1],
      env: { TMPDIR: tlcTemp },
    }).stdout;
    gitIn(tlaRoot)(["checkout", "--quiet", "--", "validate.config.json"]);
    assert(
      twinSafety.length === 0 &&
        twinAny.length === 0 &&
        twinLiveness.join() === "tlc/expected-violation variant/Toggle.tla:1" &&
        tlcPretty.includes("tlc/expected-violation") &&
        !/tlc\/tlc\//.test(tlcPretty),
      `DV12 twins by glob: ${JSON.stringify({ twinSafety, twinLiveness, twinAny, doubled: /tlc\/tlc\//.test(tlcPretty) })}`,
    );
    assert(
      treeHash(tlaRoot) === treeBefore,
      "tlc must not write into the project (states, trace specs)",
    );
    assert(
      readdirSync(tlcTemp).length === 0,
      `tlc state directories must be removed: ${readdirSync(tlcTemp)}`,
    );
    // doctor needs tlc where check would run it (and, above, not in the Go
    // project, which has no spec).
    const tlcDoctor = parseJsonOutput(
      run(process.execPath, [kitEntry, "doctor", "--json"], {
        cwd: tlaRoot,
        env: { PATH: emptyBin },
        allowedStatuses: [3],
      }),
      "doctor in the TLA+ project",
    ).tools.find((tool) => tool.id === "tlc");
    assert(
      tlcDoctor?.status === "missing-required",
      `doctor must require tlc where models exist: ${tlcDoctor?.status}`,
    );
    // A changed-file run re-checks every model when a config changed, and
    // none when nothing TLC reads changed.
    const tlcTasks = (args) =>
      JSON.parse(
        run(installedKit, ["list", "--only", "tlc", "--json", ...args], {
          cwd: tlaRoot,
        }).stdout,
      ).tasks.length;
    const allTasks = tlcTasks([]);
    writeFileSync(join(tlaRoot, "notes.md"), "not read by TLC\n");
    const afterUnrelated = tlcTasks(["--changed"]);
    writeFileSync(
      join(tlaRoot, "violated", "Lease.cfg"),
      `${readFileSync(join(tlaRoot, "violated", "Lease.cfg"), "utf8")}\\* touched\n`,
    );
    const afterConfig = tlcTasks(["--changed"]);
    assert(
      allTasks === 16 && afterUnrelated === 0 && afterConfig === allTasks,
      `a changed .cfg re-runs every model, an unrelated change none: ${allTasks} ${afterUnrelated} ${afterConfig}`,
    );
    // A run cut off by its timeout still removes TLC's state directories.
    writeTlcConfig({ timeoutMs: 1 });
    runTlc([], [4]);
    assert(
      readdirSync(tlcTemp).length === 0,
      `a timed-out tlc run must remove its state directories: ${readdirSync(tlcTemp)}`,
    );
    // A configured model runs even when no .tla is in scope.
    const model = { spec: "holds/Counter.tla", config: "holds/Counter.cfg" };
    writeTlcConfig({ options: { models: [model] } }, { include: ["none/**"] });
    const outOfScope = tlcTasks([]);
    // A typo in the options is a config error naming it, not a crash.
    writeTlcConfig({ options: { models: [{ ...model, expect: "violated" }] } });
    // Also in a run where no spec changed (nothing is staged).
    const [typo, typoStaged] = [[], ["--staged"]].map((args) =>
      run(installedKit, ["list", "--only", "tlc", "--json", ...args], {
        cwd: tlaRoot,
        allowedStatuses: [2],
      }),
    );
    // TLC's own failure keeps its reason: a config file that does not exist.
    writeTlcConfig(
      { options: { models: [{ ...model, config: "holds/Nope.cfg" }] } },
      { include: ["holds/**"] },
    );
    const missingConfig = parseJsonOutput(
      runTlc([], [4]),
      "tlc with a missing config",
    ).crashed;
    // A JVM that cannot start: the user's JAVA_TOOL_OPTIONS are kept, and
    // the crash says why rather than showing the "Picked up" banner.
    writeTlcConfig({}, { include: ["holds/**"] });
    const jvmFailure = parseJsonOutput(
      run(installedKit, ["--only", "tlc", "--json"], {
        cwd: tlaRoot,
        env: { TMPDIR: tlcTemp, JAVA_TOOL_OPTIONS: "-Xmx1k" },
        allowedStatuses: [4],
      }),
      "tlc whose JVM cannot start",
    ).crashed;
    assert(
      outOfScope === 1 &&
        [typo, typoStaged].every((r) =>
          r.stderr.includes("tools.tlc.options.models.0.expect"),
        ) &&
        jvmFailure.some((crash) =>
          crash.stderr.includes("Error occurred during initialization of VM"),
        ) &&
        missingConfig.some(
          (crash) =>
            crash.id === "tlc" &&
            crash.stderr.includes("(model Nope.cfg)") &&
            crash.stderr.includes("File not found"),
        ),
      `configured models: out of scope ${outOfScope} task(s); typo: ${typo.stderr.trim()} / staged: ${typoStaged.stderr.trim()}; missing config: ${JSON.stringify(missingConfig)}; JVM: ${JSON.stringify(jvmFailure)}`,
    );
    formal.tlc = { findings: seen, tasks: { allTasks, afterConfig } };
  } else if (process.env.SMOKE_REQUIRE_FORMAL === "1") {
    throw new Error("SMOKE_REQUIRE_FORMAL=1 but tlc is not installed");
  } else {
    formal.tlc = "skipped: tlc not installed";
  }

  // Lean through the lean adapter (engine-generalisation.md, G2.2), on the
  // fixtures in tests/fixtures/formal/lean: eight Lake projects and twelve
  // loose files.
  if (hasTool("lean", ["--version"])) {
    const leanRoot = join(tempRoot, "lean");
    cpSync(join(repoRoot, "tests", "fixtures", "formal", "lean"), leanRoot, {
      recursive: true,
    });
    const writeLeanConfig = (lean) =>
      writeFileSync(
        join(leanRoot, "validate.config.json"),
        `${JSON.stringify({ tools: { lean } }, null, 2)}\n`,
      );
    // Four axioms the project declares on purpose.
    const allowAxioms = ["first", "second", "third", "fourth"].map(
      (n) => `${n}AllowedAxiomWithAQuiteLongName`,
    );
    writeLeanConfig({ options: { allowAxioms } });
    commitAll(leanRoot);
    const leanTemp = join(tempRoot, "lean-temp");
    mkdirSync(leanTemp);
    // Lake's own build directory is the one thing a build may add.
    const leanTreeBefore = treeHash(leanRoot, [".lake"]);
    const leanCheck = (cwd) =>
      parseJsonOutput(
        run(installedKit, ["--only", "lean", "--json"], {
          cwd,
          env: { TMPDIR: leanTemp },
          allowedStatuses: [1],
        }),
        "check --only lean",
      ).findings;
    const leanFindings = leanCheck(leanRoot);
    const leanSeen = findingLines(leanFindings, "lean");
    // The second build is cached and the project has moved: Lake replays
    // traces naming the old place, and must still say which files it
    // covered. A leftover .olean of a module that no longer exists (a
    // rename) must not reach the audit.
    const leanMoved = join(tempRoot, "lean-moved");
    cpSync(leanRoot, leanMoved, { recursive: true, preserveTimestamps: true });
    // A rename: Proj.Old is built, then renamed to Proj.New, which leaves
    // Old.olean behind defining the same inductive (importing both fails).
    const movedProj = join(leanMoved, "proj");
    const rootModule = join(movedProj, "Proj.lean");
    const rootImports = readFileSync(rootModule, "utf8");
    const renamed = "inductive Color where\n  | red\n  | blue\n";
    writeFileSync(join(movedProj, "Proj", "Old.lean"), renamed);
    writeFileSync(rootModule, `${rootImports}import Proj.Old\n`);
    run("lake", ["build", "--no-ansi"], { cwd: movedProj });
    rmSync(join(movedProj, "Proj", "Old.lean"));
    writeFileSync(join(movedProj, "Proj", "New.lean"), renamed);
    writeFileSync(rootModule, `${rootImports}import Proj.New\n`);
    const leanCached = findingLines(leanCheck(leanMoved), "lean-moved");
    const leanSeeded = [
      "lean/axioms loose/Guarded.lean:3",
      "lean/axioms loose/Hidden.lean:2",
      "lean/axioms loose/Native.lean:1",
      "lean/axioms loose/Private.lean:2",
      "lean/axioms loose/Split.lean:3",
      "lean/axioms loose/Tokenless.lean:2",
      "lean/axioms loose/Underscore.lean:2",
      "lean/axioms proj/Proj/Basic.lean:2",
      "lean/axioms proj/Proj/Basic.lean:3",
      "lean/axioms proj/Proj/Twins.lean:5",
      "lean/axioms quiet/Quiet.lean:1",
      "lean/build-error nolib/lakefile.toml:1",
      "lean/error badlake/lakefile.toml:1",
      "lean/error broken/Broken/Wrong.lean:1",
      "lean/error broken/Broken/Wrong.lean:1",
      "lean/error loose/Wrong.lean:1",
      "lean/error loose/Wrong.lean:1",
      "lean/kernel-off loose/KernelOff.lean:1",
      "lean/no-toolchain broken/lakefile.toml:1",
      "lean/not-built proj/Stray.lean:1",
      "lean/not-built proj/Tests/Proj.lean:1",
      "lean/runs-code lakecode/lakefile.lean:10",
      "lean/runs-code loose/Raw.lean:4",
      "lean/runs-code loose/Raw.lean:6",
      "lean/runs-code proj/Proj/Ini.lean:2",
      "lean/runs-code proj/Proj/Spoof.lean:3",
      "lean/runs-code proj/Proj/Spoof.lean:4",
      "lean/runs-code proj/Proj/Spoof.lean:5",
      "lean/runs-code proj/Proj/Spoof.lean:7",
      "lean/runs-code proj/Proj/Spoof.lean:8",
      "lean/sorry loose/Sorry.lean:1",
      "lean/sorry proj/Proj/Later.lean:1",
      "lean/sorry proj/Proj/Twins.lean:1",
    ];
    assert(
      JSON.stringify(leanSeen) === JSON.stringify(leanSeeded) &&
        JSON.stringify(leanCached) === JSON.stringify(leanSeeded),
      `lean must report exactly the seeded problems, built and cached: ${JSON.stringify(leanSeen)} / ${JSON.stringify(leanCached)}`,
    );
    assert(
      leanFindings.some(
        (f) => f.ruleId === "lean/axioms" && f.message.includes("sorryAx"),
      ) &&
        leanFindings.some(
          (f) =>
            f.ruleId === "lean/build-error" && f.message.includes("Missing"),
        ),
      "lean findings must say which axiom and which target",
    );
    assert(
      treeHash(leanRoot, [".lake"]) === leanTreeBefore &&
        readdirSync(leanTemp).length === 0,
      `lean must write only .lake/ into the project and leave no temp files: ${readdirSync(leanTemp)}`,
    );
    // A changed-file run re-runs Lean when a toolchain changed, and not for
    // an unrelated file.
    const leanTasks = (args) =>
      JSON.parse(
        run(installedKit, ["list", "--only", "lean", "--json", ...args], {
          cwd: leanRoot,
        }).stdout,
      ).tasks.length;
    const leanAll = leanTasks([]);
    writeFileSync(join(leanRoot, "notes.md"), "not read by Lean\n");
    const leanAfterUnrelated = leanTasks(["--changed"]);
    writeFileSync(
      join(leanRoot, "proj", "lean-toolchain"),
      "leanprover/lean4:v4.34.1\n\n",
    );
    const leanAfterToolchain = leanTasks(["--changed"]);
    assert(
      // One task per Lake project and per loose file (modsys: the 20th).
      leanAll === 20 &&
        leanAfterUnrelated === 0 &&
        leanAfterToolchain === leanAll,
      `a changed lean-toolchain re-runs Lean, an unrelated change does not: ${leanAll} ${leanAfterUnrelated} ${leanAfterToolchain}`,
    );
    // Options are checked: an unknown key, and an audit of no Lake project.
    // Options are checked, also in a run where nothing Lean reads changed.
    writeLeanConfig({ options: { allowAxiom: allowAxioms } });
    const leanConfigErrors = [[], ["--staged"]].map(
      (args) =>
        run(installedKit, ["list", "--only", "lean", "--json", ...args], {
          cwd: leanRoot,
          allowedStatuses: [2],
        }).stderr,
    );
    assert(
      leanConfigErrors.every((e) => e.includes("tools.lean.options")),
      `lean option errors must name the option: ${leanConfigErrors.join(" / ")}`,
    );
    formal.lean = { findings: leanSeen, tasks: leanAll };
  } else if (process.env.SMOKE_REQUIRE_FORMAL === "1") {
    throw new Error("SMOKE_REQUIRE_FORMAL=1 but lean is not installed");
  } else {
    formal.lean = "skipped: lean not installed";
  }

  // Quint through the quint adapter (engine-generalisation.md, G2.3), on the
  // fixtures in tests/fixtures/formal/quint.
  if (hasTool("quint", ["--version"])) {
    const quintRoot = join(tempRoot, "quint");
    cpSync(join(repoRoot, "tests", "fixtures", "formal", "quint"), quintRoot, {
      recursive: true,
    });
    const writeQuintConfig = (quint) =>
      writeFileSync(
        join(quintRoot, "validate.config.json"),
        `${JSON.stringify({ tools: { quint } }, null, 2)}\n`,
      );
    const specs = [
      { spec: "good/counter.qnt", invariants: ["inv"] },
      { spec: "violated/lease.qnt", invariants: ["atMostOne"] },
      { spec: "stuck/stuck.qnt", invariants: ["safety"] },
      { spec: "frozen/frozen.qnt", invariants: ["safety"] },
      { spec: "missinginv/spec.qnt", invariants: ["nope"] },
      { spec: "multi/bank.qnt", main: "bankTests", invariants: ["inv"] },
      { spec: "divzero/div.qnt", invariants: ["inv"] },
    ];
    writeQuintConfig({ options: { maxSamples: 200, specs } });
    commitAll(quintRoot);
    const quintTemp = join(tempRoot, "quint-temp");
    mkdirSync(quintTemp);
    const quintTreeBefore = treeHash(quintRoot);
    const quintFindings = parseJsonOutput(
      run(installedKit, ["--only", "quint", "--json"], {
        cwd: quintRoot,
        env: { TMPDIR: quintTemp },
        allowedStatuses: [1],
      }),
      "check --only quint",
    ).findings;
    const quintSeen = findingLines(quintFindings, "quint");
    const quintSeeded = [
      "quint/config-error missinginv/spec.qnt:1",
      "quint/config-error twomods/two.qnt:1",
      "quint/error broken/broken.qnt:4",
      "quint/error divzero/div.qnt:4",
      "quint/error twomods/two.qnt:1",
      "quint/error typed/typed.qnt:3",
      "quint/invariant violated/lease.qnt:8",
      "quint/test-failed multi/bank.qnt:10",
      "quint/test-failed testfail/tests.qnt:6",
      "quint/unchecked unchecked/lonely.qnt:1",
      "quint/vacuous frozen/frozen.qnt:5",
      "quint/vacuous stuck/stuck.qnt:5",
    ];
    assert(
      JSON.stringify(quintSeen) === JSON.stringify(quintSeeded),
      `quint must report exactly the seeded problems: ${JSON.stringify(quintSeen)}`,
    );
    assert(
      quintFindings.some(
        (f) =>
          f.ruleId === "quint/invariant" &&
          f.message.includes("atMostOne") &&
          f.message.includes("--seed=0x1"),
      ),
      "the invariant finding must name the invariant and how to repeat it",
    );
    assert(
      treeHash(quintRoot) === quintTreeBefore &&
        readdirSync(quintTemp).length === 0,
      `quint must not write into the project or leave temp files: ${readdirSync(quintTemp)}`,
    );
    const quintTasks = (args) =>
      JSON.parse(
        run(installedKit, ["list", "--only", "quint", "--json", ...args], {
          cwd: quintRoot,
        }).stdout,
      ).tasks.length;
    const quintAll = quintTasks([]);
    writeFileSync(join(quintRoot, "notes.md"), "not read by Quint\n");
    const quintAfterUnrelated = quintTasks(["--changed"]);
    writeFileSync(
      join(quintRoot, "good", "helpers.qnt"),
      `${readFileSync(join(quintRoot, "good", "helpers.qnt"), "utf8")}// touched\n`,
    );
    const quintAfterSpec = quintTasks(["--changed"]);
    assert(
      quintAll === 14 &&
        quintAfterUnrelated === 0 &&
        quintAfterSpec === quintAll,
      `a changed .qnt re-runs Quint, an unrelated change does not: ${quintAll} ${quintAfterUnrelated} ${quintAfterSpec}`,
    );
    // Options are checked, also in a run where no spec changed.
    writeQuintConfig({ options: { specs, maxSample: 1 } });
    const quintConfigErrors = [[], ["--staged"]].map(
      (args) =>
        run(installedKit, ["list", "--only", "quint", "--json", ...args], {
          cwd: quintRoot,
          allowedStatuses: [2],
        }).stderr,
    );
    assert(
      quintConfigErrors.every((e) => e.includes("tools.quint.options")),
      `quint option errors must name the option: ${quintConfigErrors.join(" / ")}`,
    );
    formal.quint = { findings: quintSeen, tasks: quintAll };
  } else if (process.env.SMOKE_REQUIRE_FORMAL === "1") {
    throw new Error("SMOKE_REQUIRE_FORMAL=1 but quint is not installed");
  } else {
    formal.quint = "skipped: quint not installed";
  }

  // G1.7 (engine-generalisation.md): scope from git, trusted policy, bisect,
  // kitVersion. Each assertion names the failure mode it closes.
  const trustRoot = join(tempRoot, "trust");
  // A package directory with glob characters in its name (24).
  const pkg = "pk[g]";
  // macOS: the file system ignores case (18, 26 only bite there).
  const caseInsensitiveFs = existsSync(tempRoot.toUpperCase());
  const trustGit = gitIn(trustRoot);
  const kitVersionNow = JSON.parse(
    readFileSync(
      join(repoRoot, "packages", "validate-kit", "package.json"),
      "utf8",
    ),
  ).version;
  const trustConfig = (severity, extra = "") =>
    `export default { kitVersion: "^${kitVersionNow}", severityOverrides: [{ tool: "ast-grep", ruleId: "ts-no-console", severity: "${severity}" }]${extra} };\n`;
  mkdirSync(join(trustRoot, "src"), { recursive: true });
  mkdirSync(join(trustRoot, "vendor"), { recursive: true });
  writeFileSync(
    join(trustRoot, ".gitignore"),
    "vendor/\nsandbox/\nnode_modules/\n",
  );
  writeFileSync(join(trustRoot, "vendor", "bad.ts"), consoleLine);
  writeFileSync(join(trustRoot, "src", "ok.ts"), "export const ok = 1;\n");
  writeFileSync(join(trustRoot, "src", "gone.ts"), "export const gone = 1;\n");
  writeFileSync(
    join(trustRoot, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true } }\n',
  );
  writeFileSync(join(trustRoot, ".prettierrc"), "{}\n");
  // A settings file no default glob matches, named by the config.
  mkdirSync(join(trustRoot, "fmt"), { recursive: true });
  writeFileSync(join(trustRoot, "fmt", "style.json"), "{}\n");
  writeFileSync(
    join(trustRoot, "validate.config.ts"),
    // The security layer off (to drop semgrep) must not drop the policy
    // check (25).
    trustConfig(
      "error",
      ', tools: { prettier: { configPath: "fmt/style.json" } }, layers: { security: { enabled: false } }',
    ),
  );
  // A project in a sub-directory of the repository (a monorepo package),
  // with its own ast-grep rules through an sgconfig.
  mkdirSync(join(trustRoot, pkg, "rules"), { recursive: true });
  writeFileSync(
    join(trustRoot, pkg, "validate.config.ts"),
    'export default { extends: [], astGrep: { sgconfig: "sg.yml" } };\n',
  );
  writeFileSync(join(trustRoot, pkg, "sg.yml"), "ruleDirs: [rules]\n");
  writeFileSync(
    join(trustRoot, pkg, "rules", "no-log.yml"),
    "id: no-log\nlanguage: TypeScript\nseverity: error\nrule: { pattern: console.log($A) }\nmessage: no log\n",
  );
  writeFileSync(join(trustRoot, pkg, "tsconfig.json"), "{}\n");
  commitAll(trustRoot);
  // Findings carry the real path (/private/var on macOS for /var).
  const trustReal = realpathSync(trustRoot);
  const trustCheck = (args, allowedStatuses = [0, 1], env = {}) =>
    run(installedKit, ["check", ...args], {
      cwd: trustRoot,
      allowedStatuses,
      env,
    });
  const consoleFiles = (result) =>
    parseJsonOutput(result, "check")
      .findings.filter((f) => f.ruleId === "ts-no-console")
      .map((f) => f.file.slice(trustReal.length + 1))
      .toSorted();

  // 1, 2: an ignored file is out of scope; a new file nobody added is in it.
  writeFileSync(join(trustRoot, "src", "new.ts"), consoleLine);
  const scoped = consoleFiles(trustCheck(["--only", "ast-grep", "--json"]));
  assert(
    scoped.join() === "src/new.ts",
    `scope must be git's: ignored vendor/ out, untracked src/new.ts in; got ${scoped.join()}`,
  );
  rmSync(join(trustRoot, "src", "new.ts"));
  // 3: a tracked file deleted from the work tree is not handed to a tool.
  const filesBefore = JSON.parse(
    trustCheck(["--only", "ast-grep", "--json"]).stdout,
  ).scope.files;
  rmSync(join(trustRoot, "src", "gone.ts"));
  const deletedRun = trustCheck(["--only", "ast-grep", "--json"], [0]);
  const filesAfter = JSON.parse(deletedRun.stdout).scope.files;
  assert(
    filesAfter === filesBefore - 1,
    `a deleted tracked file must leave the scope: ${filesBefore} -> ${filesAfter}`,
  );
  trustGit(["checkout", "--quiet", "--", "src/gone.ts"]);
  // 4: outside a git work tree the globs alone decide.
  const plainRoot = join(tempRoot, "no-git");
  mkdirSync(join(plainRoot, "src"), { recursive: true });
  writeFileSync(join(plainRoot, "src", "bad.ts"), consoleLine);
  run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: plainRoot,
    allowedStatuses: [128],
  });
  const noGit = parseJsonOutput(
    run(installedKit, ["check", "--only", "ast-grep", "--json"], {
      cwd: plainRoot,
      allowedStatuses: [0, 1],
    }),
    "check outside git",
  ).findings.filter((f) => f.ruleId === "ts-no-console");
  assert(
    noGit.length === 1,
    `a project outside git must still be checked: ${noGit.length}`,
  );
  // 17: a project inside an ignored directory (a scratch copy) is checked.
  mkdirSync(join(trustRoot, "sandbox", "src"), { recursive: true });
  writeFileSync(join(trustRoot, "sandbox", "src", "bad.ts"), consoleLine);
  const sandbox = consoleFiles(
    trustCheck(["sandbox", "--only", "ast-grep", "--json"]),
  );
  assert(
    sandbox.join() === "sandbox/src/bad.ts",
    `a project in an ignored directory must still be checked: ${sandbox.join()}`,
  );
  rmSync(join(trustRoot, "sandbox"), { recursive: true });
  // 18: git and the disk spell a name differently: NFD on disk while git
  // lists NFC (macOS), or a case-only rename made on disk.
  const namesRoot = join(tempRoot, "names");
  mkdirSync(join(namesRoot, "src"), { recursive: true });
  writeFileSync(join(namesRoot, "src", "cafe\u0301.ts"), consoleLine);
  writeFileSync(join(namesRoot, "src", "lower.ts"), "export const l = 1;\n");
  commitAll(namesRoot);
  renameSync(
    join(namesRoot, "src", "lower.ts"),
    join(namesRoot, "src", "x.ts"),
  );
  renameSync(
    join(namesRoot, "src", "x.ts"),
    join(namesRoot, "src", "LOWER.ts"),
  );
  writeFileSync(join(namesRoot, "src", "LOWER.ts"), consoleLine);
  const namesCheck = (args, allowedStatuses) =>
    run(installedKit, ["check", "--only", "ast-grep", ...args], {
      cwd: namesRoot,
      allowedStatuses,
    });
  const spelled = parseJsonOutput(
    namesCheck(["--json"], [0, 1]),
    "names",
  ).findings.filter((f) => f.ruleId === "ts-no-console").length;
  assert(
    spelled === 2,
    `files git and the disk spell differently must stay in scope: ${spelled} of 2`,
  );
  // G1.1c: a source extension in another case reaches no tool (oxlint and
  // ast-grep skip `B.TS`): exit 2 naming it, clean once it is ignored.
  const caseRoot = join(tempRoot, "ext-case");
  mkdirSync(join(caseRoot, "src"), { recursive: true });
  writeFileSync(join(caseRoot, "src", "a.ts"), consoleLine);
  writeFileSync(join(caseRoot, "src", "B.TS"), consoleLine);
  commitAll(caseRoot);
  const miscased = run(installedKit, ["check", "--only", "ast-grep"], {
    cwd: caseRoot,
    allowedStatuses: [2],
  }).stderr;
  // A commit that does not touch it is not blocked by it.
  writeFileSync(join(caseRoot, "src", "a.ts"), `${consoleLine}// edited\n`);
  const changedOnly = run(
    installedKit,
    ["check", "--changed", "--only", "ast-grep"],
    { cwd: caseRoot, allowedStatuses: [0, 1, 2] },
  ).status;
  writeFileSync(
    join(caseRoot, "validate.config.json"),
    `${JSON.stringify({ ignore: ["src/B.TS"] })}\n`,
  );
  const caseIgnored = parseJsonOutput(
    run(installedKit, ["check", "--only", "ast-grep", "--json"], {
      cwd: caseRoot,
      allowedStatuses: [0, 1],
    }),
    "ext-case",
  ).findings.filter((f) => f.ruleId === "ts-no-console").length;
  assert(
    miscased.includes("src/B.TS") && changedOnly === 1 && caseIgnored === 1,
    `a mis-cased source extension is exit 2 naming it in a full run, not in a run of other changed files, and ignorable: ${miscased} / ${changedOnly} / ${caseIgnored}`,
  );
  // Review 2026-10-03: ESLint is planned only where a flat config reaches
  // (one package's config did not make it runnable in its siblings, and
  // ESLint crashed there); and a tool whose output passes the capture limit
  // is a crash that says so, not "invalid JSON" from a truncated stream.
  const reviewRoot = join(tempRoot, "review-shapes");
  for (const side of ["front", "back"]) {
    mkdirSync(join(reviewRoot, side, "src"), { recursive: true });
    writeFileSync(
      join(reviewRoot, side, "package.json"),
      `{ "name": "${side}" }\n`,
    );
    writeFileSync(
      join(reviewRoot, side, "src", "a.js"),
      "export const a = 1;\n",
    );
  }
  writeFileSync(
    join(reviewRoot, "front", "eslint.config.mjs"),
    "export default [];\n",
  );
  writeFileSync(
    join(reviewRoot, "validate.config.ts"),
    `export default {
  adapters: [{
    id: "loud", layer: "lint", languages: [], bin: "sh", supportsFix: false,
    fixWriteBack: false, minVersion: "0.0.0", installHint: "sh",
    versionArgs: ["-c", "echo 1.0.0"],
    buildArgs: () => ({ bin: "sh", args: ["-c", "head -c 120000000 /dev/zero | tr '\\\\0' a"] }),
    parseOutput: (raw) => ({ findings: [], filesProcessed: 1, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }),
  }, {
    // A shim that exists but cannot run its tool, as mise prints it.
    id: "shimmed", layer: "lint", languages: [], bin: "sh", supportsFix: false,
    fixWriteBack: false, minVersion: "0.0.0", installHint: "reinstall it",
    versionArgs: ["-c", "echo 'mise ERROR osemgrep is not a valid shim.' >&2; echo 'mise ERROR Version: 2026.6.12 macos-arm64' >&2; exit 1"],
    buildArgs: () => ({ bin: "sh", args: ["-c", "true"] }),
    parseOutput: (raw) => ({ findings: [], filesProcessed: 1, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }),
  }],
};
`,
  );
  // A .ts file and no tsconfig.json: tsc has no project to check.
  writeFileSync(
    join(reviewRoot, "front", "src", "b.ts"),
    "export const b = 1;\n",
  );
  const eslintRoots = JSON.parse(
    run(installedKit, ["list", "--json"], { cwd: reviewRoot }).stdout,
  )
    .tasks.filter((task) => task.tool === "eslint")
    .map((task) => task.cwd.split("/").pop());
  const loud = parseJsonOutput(
    run(installedKit, ["check", "--only", "loud", "--json"], {
      cwd: reviewRoot,
      allowedStatuses: [4],
    }),
    "loud",
  );
  const reviewTasks = JSON.parse(
    run(installedKit, ["list", "--json"], { cwd: reviewRoot }).stdout,
  ).tasks;
  const reviewTools = reviewTasks.map((task) => task.tool);
  const reviewTsc = reviewTasks.filter((task) => task.tool === "tsc");
  const loudPretty = run(installedKit, ["check", "--only", "loud"], {
    cwd: reviewRoot,
    allowedStatuses: [4],
  }).stdout;
  // A broken shim: not "ok" in doctor, "cannot run" (exit 3) in check, with
  // the shim's own words; never a version read out of its error.
  const shimDoctor = JSON.parse(
    run(installedKit, ["doctor", "--json"], {
      cwd: reviewRoot,
      allowedStatuses: [0, 3],
    }).stdout,
  ).tools.find((tool) => tool.id === "shimmed");
  const shimCheck = parseJsonOutput(
    run(installedKit, ["check", "--only", "shimmed", "--json"], {
      cwd: reviewRoot,
      allowedStatuses: [3],
    }),
    "shimmed",
  );
  // --json still prints JSON when the run stops with a config error.
  const jsonError = JSON.parse(
    run(installedKit, ["check", "--json", "--trusted-ref", "no-such-ref"], {
      cwd: reviewRoot,
      allowedStatuses: [2],
    }).stdout,
  );
  assert(
    eslintRoots.join() === "front" &&
      reviewTsc.length === 1 &&
      reviewTsc[0].cannotRun?.includes("in no tsconfig project") &&
      loud.crashed.some(
        (c) => c.id === "loud" && c.stderr.includes("maxBuffer"),
      ) &&
      loudPretty.includes("crashed or timed out (loud)") &&
      loudPretty.includes("Add them to `ignore`") &&
      shimDoctor?.status === "missing-required" &&
      shimDoctor?.problem?.includes("not a valid shim") &&
      shimDoctor?.version === null &&
      shimCheck.incomplete.some(
        (i) => i.id === "shimmed" && i.problem?.includes("not a valid shim"),
      ) &&
      jsonError.exitCode === 2 &&
      jsonError.error?.kind === "config" &&
      jsonError.error.message.includes("no-such-ref"),
    `review shapes: eslint ${eslintRoots.join()}, tools ${reviewTools.join()}, tsc ${JSON.stringify(reviewTsc)}, loud ${JSON.stringify(loud.crashed)}, shim ${JSON.stringify(shimDoctor)} / ${JSON.stringify(shimCheck.incomplete)}, json ${JSON.stringify(jsonError)}`,
  );
  // --trusted-ref in a repository with no validate config anywhere: judged
  // by the built-in defaults, not refused.
  const bareRoot = join(tempRoot, "bare");
  mkdirSync(join(bareRoot, "src"), { recursive: true });
  writeFileSync(join(bareRoot, "src", "a.ts"), "export const a = 1;\n");
  commitAll(bareRoot);
  const bareTrusted = run(
    installedKit,
    ["check", "--only", "ast-grep", "policy", "--trusted-ref", "HEAD"],
    { cwd: bareRoot, allowedStatuses: [0, 1, 2] },
  );
  assert(
    bareTrusted.status === 0,
    `--trusted-ref with no config anywhere runs on the defaults: exit ${bareTrusted.status} ${bareTrusted.stderr}`,
  );
  // R7 (engine-generalisation.md; acceptance cases P01-P06 from the Codex
  // pressure review): tsc once per TypeScript project. Each fixture links
  // this repository's TypeScript as its node_modules/.bin/tsc.
  // TypeScript 7's tsc (@typescript/native), the one this repository's checks
  // run; its package exports no bin/ path, so it is found next to its
  // package.json (docs/research/upgrades-2026-10/typescript-7.md).
  const tscBin = join(
    dirname(
      createRequire(join(repoRoot, "apps", "web", "package.json")).resolve(
        "@typescript/native/package.json",
      ),
    ),
    "bin",
    "tsc",
  );
  const tsRoot = join(tempRoot, "ts-projects");
  const bad = 'export const x: number = "nope";\n';
  const fine = "export const y = 1;\n";
  // `files` maps a path to its text, or to { link } for a symlink. Options:
  // `sub`, the folder the run starts in; `tsc`, a script (given the real
  // tsc and the case folder) in place of the linked tsc; `git`, commit the
  // files, then `after` changes the tree; `args`, added to each run.
  // Findings and projects are relative to the case folder.
  const tsCase = (
    name,
    files,
    { sub = ".", tsc, git = false, after, args = [] } = {},
  ) => {
    const caseDir = join(tsRoot, name);
    mkdirSync(join(caseDir, "node_modules", ".bin"), { recursive: true });
    const tscPath = join(caseDir, "node_modules", ".bin", "tsc");
    if (tsc) writeFileSync(tscPath, tsc(tscBin, caseDir), { mode: 0o755 });
    else symlinkSync(tscBin, tscPath);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(caseDir, path)), { recursive: true });
      if (typeof text === "string") writeFileSync(join(caseDir, path), text);
      else symlinkSync(text.link, join(caseDir, path));
    }
    if (git) {
      writeFileSync(join(caseDir, ".gitignore"), "node_modules/\n");
      commitAll(caseDir);
    }
    after?.(caseDir, gitIn(caseDir));
    const dir = join(caseDir, sub);
    const real = realpathSync(caseDir);
    const tscRun = (profile) =>
      parseJsonOutput(
        run(
          installedKit,
          ["check", "--only", "tsc", "--profile", profile, ...args, "--json"],
          {
            cwd: dir,
            allowedStatuses: [0, 1, 3],
          },
        ),
        `tsc ${name}`,
      );
    const ci = tscRun("ci");
    const projects = JSON.parse(
      run(installedKit, ["list", "--only", "tsc", ...args, "--json"], {
        cwd: dir,
      }).stdout,
    ).tasks.flatMap((task) =>
      task.options?.project
        ? [task.options.project.slice(real.length + 1)]
        : [],
    );
    return {
      exit: ci.exitCode,
      findings: ci.findings
        .filter((f) => f.tool === "tsc" && f.severity !== "info")
        .map((f) => `${f.file.slice(real.length + 1)}:${f.ruleId}`)
        .toSorted(),
      incomplete: ci.incomplete.map((i) => i.problem ?? ""),
      status: ci.toolStatus?.tsc,
      defaultExit: tscRun("default").exitCode,
      projects: projects.toSorted(),
    };
  };
  const strict =
    '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n';
  // An extends-only root stub and a base (JSONC) over a JSX package; the
  // stub's options would fail the JSX file.
  const p04Files = {
    "tsconfig.base.json":
      '{\n  // shared\n  "compilerOptions": { "strict": true, },\n}\n',
    "tsconfig.json": '{ "extends": "./tsconfig.base.json" }\n',
    "apps/ui/tsconfig.json":
      '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "preserve" }, "include": ["src"] }\n',
    "apps/ui/src/jsx.d.ts":
      "declare namespace JSX { interface IntrinsicElements { [name: string]: unknown } }\n",
    "apps/ui/src/c.tsx": "export const C = () => <div />;\n",
    "apps/ui/src/a.ts": bad,
  };
  const cypressFiles = {
    "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    "cypress/tsconfig.json":
      '{ "compilerOptions": { "strict": false }, "include": ["**/*.ts"] }\n',
    "cypress/e2e.ts": "export function f(x) {\n  return x;\n}\n",
  };
  const depFiles = {
    "tsconfig.json":
      '{ "compilerOptions": { "strict": true, "types": [], "skipLibCheck": false }, "include": ["src"] }\n',
    "node_modules/pkg/package.json":
      '{ "name": "pkg", "version": "1.0.0", "types": "index.d.ts" }\n',
    "node_modules/pkg/index.d.ts":
      'export interface Foo { a: number }\nexport declare const wrong: number = "bad";\n',
    "src/a.ts":
      'import type { Foo } from "pkg";\nexport const f: Foo = { a: 1 };\n',
  };
  const tsCases = {
    // P01: a second project beside tsconfig.json.
    p01: tsCase("p01", {
      "tsconfig.json": strict,
      "tsconfig.web.json":
        '{ "compilerOptions": { "strict": true }, "include": ["web"] }\n',
      "src/a.ts": fine,
      "web/a.ts": bad,
    }),
    // P02: only tsconfig.app.json.
    p02: tsCase("p02", { "tsconfig.app.json": strict, "src/a.ts": bad }),
    // P03: a configured project is the one that runs, and list says which.
    p03: tsCase("p03", {
      "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
      "tsconfig.build.json":
        '{ "extends": "./tsconfig.json", "include": ["src"] }\n',
      "validate.config.ts":
        'export default { tools: { tsc: { configPath: "tsconfig.build.json" } } };\n',
      "src/a.ts": fine,
      "test/bad.ts": bad,
    }),
    // P04: an extends-only root stub and a base (JSONC) over a JSX package.
    p04: tsCase("p04", p04Files),
    // P05: TypeScript in no project.
    p05: tsCase("p05", { "src/a.ts": bad }),
    // P06: declared dependencies not installed.
    p06: tsCase("p06", {
      "tsconfig.json": strict,
      "package.json":
        '{ "name": "p06", "dependencies": { "left-pad": "1.3.0" } }\n',
      "src/a.ts": 'import pad from "left-pad";\nexport const z = pad;\n',
    }),
    // A dependency's .d.ts that fails: tsc exits non-zero with every error
    // inside node_modules, which must not read as clean.
    dep: tsCase("dep", depFiles),
    // ... and beside it the project's own error is still reported.
    depapp: tsCase("depapp", { ...depFiles, "src/b.ts": bad }),
    // One project clean, TypeScript elsewhere in none: tsc did not pass.
    partial: tsCase("partial", {
      "pkg/tsconfig.json": strict,
      "pkg/src/a.ts": fine,
      "loose/b.ts": fine,
    }),
    // Rows 12-18 (a fresh review of the first draft).
    // 12: NestJS, whose tsconfig.build.json extends tsconfig.json.
    nest: tsCase("nest", {
      "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
      "tsconfig.build.json":
        '{ "extends": "./tsconfig.json", "exclude": ["node_modules", "test", "dist", "**/*spec.ts"] }\n',
      "src/a.ts": fine,
      "test/app.e2e-spec.ts": bad,
    }),
    // Two projects over the same files with different options (Codex
    // R14): the stricter one runs too.
    overlap: tsCase("overlap", {
      "tsconfig.json":
        '{ "compilerOptions": { "strict": false }, "include": ["src"] }\n',
      "tsconfig.strict.json":
        '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n',
      "src/a.ts": "export function identity(value) {\n  return value;\n}\n",
    }),
    // 13: the language's configPath wins, in the run as in `list`.
    langcfg: tsCase("langcfg", {
      "tsconfig.a.json":
        '{ "compilerOptions": { "strict": true }, "include": ["a"] }\n',
      "tsconfig.b.json":
        '{ "compilerOptions": { "strict": true }, "include": ["b"] }\n',
      "validate.config.ts":
        'export default { tools: { tsc: { configPath: "tsconfig.a.json" } }, languages: { ts: { tools: { tsc: { configPath: "tsconfig.b.json" } } } } };\n',
      "a/x.ts": fine,
      "b/y.ts": bad,
    }),
    // 14: a solution-style root checks nothing itself.
    solution: tsCase("solution", {
      "tsconfig.json":
        '{ "files": [], "references": [{ "path": "./packages/a" }] }\n',
      "packages/a/tsconfig.json":
        '{ "compilerOptions": { "strict": true, "composite": true }, "include": ["src"] }\n',
      "packages/a/src/x.ts": fine,
      "packages/b/src/y.ts": bad,
    }),
    // 15: a root project with no include beside cypress/tsconfig.json; the
    // root's strict options would fail the Cypress file, its own do not.
    cypress: tsCase("cypress", { ...cypressFiles, "src/a.ts": bad }),
    // 16: the project's config is outside the validation scope.
    narrow: tsCase("narrow", {
      "tsconfig.json": strict,
      "validate.config.ts": 'export default { include: ["src/**"] };\n',
      "src/a.ts": bad,
    }),
    // 17: a shared base extended by package name.
    pkgbase: tsCase("pkgbase", {
      "packages/tsconfig/package.json":
        '{ "name": "@repo/tsconfig", "version": "0.0.0" }\n',
      "packages/tsconfig/tsconfig.base.json":
        '{ "compilerOptions": { "strict": true } }\n',
      "node_modules/@repo/tsconfig": { link: "../../packages/tsconfig" },
      "apps/web/tsconfig.json":
        '{ "extends": "@repo/tsconfig/tsconfig.base.json", "include": ["src"] }\n',
      "apps/web/src/a.ts": fine,
    }),
    // 18: a project that itself sits under node_modules.
    undernm: tsCase(
      "undernm",
      {
        "node_modules/app/tsconfig.json": strict,
        "node_modules/app/src/a.ts": bad,
      },
      { sub: "node_modules/app" },
    ),
    // From a second fresh review of the redesign (rows 22-28).
    // 22: a staged deletion breaks an import in a project nothing else
    // changed in.
    deleted: tsCase(
      "deleted",
      {
        "tsconfig.json": strict,
        "tsconfig.test.json":
          '{ "compilerOptions": { "strict": true }, "include": ["test"] }\n',
        "src/main.ts": 'import { u } from "./util";\nexport const m = u;\n',
        "src/util.ts": "export const u = 1;\n",
        "test/x.ts": fine,
      },
      {
        git: true,
        args: ["--staged"],
        after: (dir, git) => {
          git(["rm", "--quiet", "src/util.ts"]);
          writeFileSync(join(dir, "test", "x.ts"), "export const y = 2;\n");
          git(["add", "test/x.ts"]);
        },
      },
    ),
    // Codex R29: a comma or a brace inside a quoted string is not a trailing
    // comma; misreading `extends` made a strict project look like a base.
    jsoncstring: tsCase("jsoncstring", {
      "tsconfig.json":
        '{ "extends": "./tsconfig.loose,}.json", "include": ["src"] }\n',
      "tsconfig.loose,}.json":
        '{ "compilerOptions": { "strict": false, "types": [] } }\n',
      "tsconfig.loose}.json":
        '{ "compilerOptions": { "strict": true, "types": [] } }\n',
      "src/a.ts": "export function identity(value) {\n  return value;\n}\n",
    }),
    // ... nor does a // comment ended by a lone CR swallow the next key (a
    // fresh review): the strict project keeps its include.
    jsonccr: tsCase("jsonccr", {
      "tsconfig.json":
        '{ "extends": "./tsconfig.strict.json", "compilerOptions": { "strict": false } }\n',
      "tsconfig.strict.json":
        '{ "compilerOptions": { "strict": true, "types": [] }, // strict core\r  "include": ["src"]\n}\n',
      "src/a.ts": "export function identity(value) {\n  return value;\n}\n",
    }),
    // 23: tsc cannot list a project's files (it crashed): not a pass.
    nolist: tsCase(
      "nolist",
      { "pkg/tsconfig.json": strict, "pkg/src/a.ts": fine, "loose/b.ts": bad },
      {
        tsc: (real) =>
          `#!/bin/sh\ncase "$*" in *--listFilesOnly*) exit 134;; esac\nexec '${real}' "$@"\n`,
      },
    ),
    // ... and when it exits 2 saying nothing, which no config problem does
    // (Codex R22).
    nolistquiet: tsCase(
      "nolistquiet",
      { "pkg/tsconfig.json": strict, "pkg/src/a.ts": fine, "pkg/b.ts": bad },
      {
        tsc: (real) =>
          `#!/bin/sh\ncase "$*" in *--listFilesOnly*) exit 2;; esac\nexec '${real}' "$@"\n`,
      },
    ),
    // 24: the root's errors in files a nearer project owns are not
    // reported in another form when they are all it has.
    cypressclean: tsCase("cypressclean", { ...cypressFiles, "src/a.ts": fine }),
    // 25: a changed-file run does not run a stub that owns nothing.
    stubstaged: tsCase(
      "stubstaged",
      { ...p04Files, "apps/ui/src/a.ts": fine },
      {
        git: true,
        args: ["--staged"],
        after: (dir, git) => {
          writeFileSync(
            join(dir, "apps", "ui", "src", "a.ts"),
            "export const y = 2;\n",
          );
          git(["add", "apps/ui/src/a.ts"]);
        },
      },
    ),
    // 26: a run on one package: a root stub that owns a file there does not
    // report its errors in sibling packages, which have their own projects.
    subrun: tsCase(
      "subrun",
      {
        ...p04Files,
        "apps/api/tsconfig.json": strict,
        "apps/api/src/x.ts": fine,
        "apps/api/vitest.config.ts": "export default {};\n",
      },
      { git: true, sub: "apps/api" },
    ),
    // 27: tsc's listings run at most `concurrency` at a time.
    bounded: tsCase(
      "bounded",
      {
        "validate.config.json": '{ "concurrency": 2 }\n',
        ...Object.fromEntries(
          [0, 1, 2, 3, 4, 5].flatMap((n) => [
            [`pkg${n}/tsconfig.json`, strict],
            [`pkg${n}/src/a.ts`, fine],
          ]),
        ),
      },
      {
        tsc: (real, dir) =>
          `#!/bin/sh\ncase "$*" in *--listFilesOnly*) d='${dir}/node_modules/.listing'; mkdir -p "$d"; : > "$d/$$"; sleep 0.3; ls "$d" | wc -l >> '${dir}/node_modules/.listing-max'; rm -f "$d/$$";; esac\nexec '${real}' "$@"\n`,
      },
    ),
    // Codex P31: an empty, invalid .git above the project is not a
    // repository; the search for configs stops at the project root.
    badgit: tsCase(
      "badgit",
      {
        ".git/empty": "",
        "tsconfig.json": '{ "compilerOptions": { "strict": false } }\n',
        "proj/a.ts": "export function identity(value) {\n  return value;\n}\n",
      },
      { sub: "proj" },
    ),
    // 28: outside a git repository the search for configs stops at the
    // project root.
    outside: tsCase(
      "outside",
      {
        "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
        "proj/loose.ts": fine,
      },
      { sub: "proj" },
    ),
  };
  const tsExpected = {
    p01: {
      exit: 1,
      findings: ["web/a.ts:TS2322"],
      projects: ["tsconfig.json", "tsconfig.web.json"],
    },
    p02: {
      exit: 1,
      findings: ["src/a.ts:TS2322"],
      projects: ["tsconfig.app.json"],
    },
    p03: { exit: 0, findings: [], projects: ["tsconfig.build.json"] },
    p04: {
      exit: 1,
      findings: ["apps/ui/src/a.ts:TS2322"],
      projects: ["apps/ui/tsconfig.json"],
    },
    p05: { exit: 3, findings: [], projects: [] },
    p06: { exit: 3, findings: [], projects: ["tsconfig.json"] },
    dep: {
      exit: 1,
      findings: ["tsconfig.json:dependency-types"],
      projects: ["tsconfig.json"],
    },
    depapp: {
      exit: 1,
      findings: ["src/b.ts:TS2322", "tsconfig.json:dependency-types"],
      projects: ["tsconfig.json"],
    },
    partial: { exit: 3, findings: [], projects: ["pkg/tsconfig.json"] },
    nest: {
      exit: 1,
      findings: ["test/app.e2e-spec.ts:TS2322"],
      projects: ["tsconfig.build.json", "tsconfig.json"],
    },
    overlap: {
      exit: 1,
      findings: ["src/a.ts:TS7006"],
      projects: ["tsconfig.json", "tsconfig.strict.json"],
    },
    langcfg: {
      exit: 1,
      findings: ["b/y.ts:TS2322"],
      projects: ["tsconfig.b.json"],
    },
    solution: {
      exit: 3,
      findings: [],
      projects: ["packages/a/tsconfig.json"],
    },
    cypress: {
      exit: 1,
      findings: ["src/a.ts:TS2322"],
      projects: ["cypress/tsconfig.json", "tsconfig.json"],
    },
    narrow: {
      exit: 1,
      findings: ["src/a.ts:TS2322"],
      projects: ["tsconfig.json"],
    },
    pkgbase: { exit: 0, findings: [], projects: ["apps/web/tsconfig.json"] },
    undernm: {
      exit: 1,
      findings: ["node_modules/app/src/a.ts:TS2322"],
      projects: ["node_modules/app/tsconfig.json"],
    },
    deleted: {
      exit: 1,
      findings: ["src/main.ts:TS2307"],
      projects: ["tsconfig.json", "tsconfig.test.json"],
    },
    jsonccr: {
      exit: 1,
      findings: ["src/a.ts:TS7006"],
      projects: ["tsconfig.json", "tsconfig.strict.json"],
    },
    jsoncstring: {
      exit: 1,
      findings: ["src/a.ts:TS7006"],
      projects: ["tsconfig.json", "tsconfig.loose}.json"],
    },
    nolist: { exit: 3, findings: [], projects: ["pkg/tsconfig.json"] },
    nolistquiet: { exit: 3, findings: [], projects: ["pkg/tsconfig.json"] },
    cypressclean: {
      exit: 0,
      findings: [],
      projects: ["cypress/tsconfig.json", "tsconfig.json"],
    },
    stubstaged: { exit: 0, findings: [], projects: ["apps/ui/tsconfig.json"] },
    subrun: {
      exit: 0,
      findings: [],
      projects: ["apps/api/tsconfig.json", "tsconfig.json"],
    },
    bounded: {
      exit: 0,
      findings: [],
      projects: [0, 1, 2, 3, 4, 5].map((n) => `pkg${n}/tsconfig.json`),
    },
    outside: { exit: 3, findings: [], projects: [] },
    badgit: { exit: 3, findings: [], projects: [] },
  };
  for (const [name, want] of Object.entries(tsExpected)) {
    const got = tsCases[name];
    assert(
      got.exit === want.exit &&
        got.findings.join() === want.findings.join() &&
        got.projects.join() === want.projects.join(),
      `R7 ${name}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
  // A required tool that cannot cover part of its scope fails closed in every
  // profile, as a missing one does, and never reports `pass`.
  assert(
    tsCases.p05.incomplete.some((i) => i.includes("in no tsconfig project")) &&
      tsCases.p06.incomplete.some((i) => i.includes("left-pad")) &&
      tsCases.partial.incomplete.some((i) => i.includes("loose/b.ts")) &&
      tsCases.nolist.incomplete.some((i) => i.includes("could not list")) &&
      tsCases.nolistquiet.incomplete.some((i) =>
        i.includes("could not list"),
      ) &&
      tsCases.nolist.incomplete.some((i) => i.includes("loose/b.ts")) &&
      tsCases.outside.incomplete.some((i) => i.includes("loose.ts")) &&
      Math.max(
        ...readFileSync(
          join(tsRoot, "bounded", "node_modules", ".listing-max"),
          "utf8",
        )
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      ) <= 2 &&
      tsCases.solution.incomplete.some((i) =>
        i.includes("packages/b/src/y.ts"),
      ) &&
      ["p05", "p06", "partial"].every(
        (name) =>
          tsCases[name].defaultExit === 3 && tsCases[name].status === "not_run",
      ) &&
      tsCases.dep.status === "fail",
    `R7 cannot-run cases: ${JSON.stringify({ p05: tsCases.p05, p06: tsCases.p06, partial: tsCases.partial, dep: tsCases.dep })}`,
  );
  // The exported buildPlan with its documented four arguments (no scope):
  // it plans from the project's own scope, not from none (Codex R20).
  const apiPlan = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const kit = await import(process.argv[1]);
const root = process.cwd();
const { config } = await kit.resolveConfig(root);
const tasks = await kit.buildPlan(await kit.detectLanguages(root), config, root, [kit.adapterById("tsc")]);
console.log(JSON.stringify(tasks.map((t) => t.options?.project ?? null)));`,
      pathToFileURL(
        join(consumerRoot, "node_modules", "validate-kit", "dist", "index.js"),
      ).href,
    ],
    { cwd: join(tsRoot, "p01"), encoding: "utf8" },
  );
  const apiProjects = (() => {
    try {
      const real = realpathSync(join(tsRoot, "p01"));
      return JSON.parse(apiPlan.stdout)
        .map((project) => project?.slice(real.length + 1))
        .toSorted();
    } catch {
      return [];
    }
  })();
  assert(
    apiProjects.join() === "tsconfig.json,tsconfig.web.json",
    `R7 buildPlan without a scope: ${JSON.stringify(apiProjects)}; stdout ${apiPlan.stdout} stderr ${apiPlan.stderr}`,
  );
  // Planning asks the project's tsc what each project covers, so under
  // --trusted-ref the policy check runs before planning (Codex R15): a tsc
  // that restores a relaxed setting while it lists files cannot hide it.
  const planOrderRoot = join(tempRoot, "plan-order");
  mkdirSync(join(planOrderRoot, "src"), { recursive: true });
  writeFileSync(join(planOrderRoot, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(planOrderRoot, ".oxlintrc.json"),
    '{ "rules": { "no-unused-vars": "error" } }\n',
  );
  writeFileSync(join(planOrderRoot, "tsconfig.json"), strict);
  writeFileSync(join(planOrderRoot, "src", "a.ts"), fine);
  commitAll(planOrderRoot);
  writeFileSync(
    join(planOrderRoot, ".oxlintrc.json"),
    '{ "rules": { "no-unused-vars": "off" } }\n',
  );
  mkdirSync(join(planOrderRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(planOrderRoot, "node_modules", ".bin", "tsc"),
    `#!/bin/sh\ncase "$*" in *--version*) echo "Version 5.9.3"; exit 0;; esac\ncase "$*" in *--listFilesOnly*) git show HEAD:.oxlintrc.json > .oxlintrc.json; echo "$(pwd -P)/src/a.ts"; exit 0;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  const planOrderRun = parseJsonOutput(
    run(
      installedKit,
      [
        "check",
        "--only",
        "tsc",
        "policy",
        "--trusted-ref",
        "HEAD",
        "--profile",
        "ci",
        "--json",
      ],
      { cwd: planOrderRoot, allowedStatuses: [0, 1, 3, 4] },
    ),
    "plan order",
  );
  assert(
    planOrderRun.exitCode === 1 &&
      planOrderRun.findings.some(
        (f) => f.tool === "policy" && f.file.endsWith("/.oxlintrc.json"),
      ),
    `R7 plan order: a relaxed .oxlintrc.json restored while tsc listed files went unreported: exit ${planOrderRun.exitCode} ${JSON.stringify(planOrderRun.findings.map((f) => `${f.tool}:${f.file}`))}`,
  );
  // R16 (Codex P19, P19b, P19c): under --trusted-ref the settings check runs
  // whatever --only, --lang or --layer select, but never stands in for a
  // selection that matched nothing; --disable policy cannot drop it; the
  // trusted config's own `tools.policy.enabled: false` can, and says so.
  const r16Root = join(tempRoot, "r16");
  const r16Fixture = (name, config) => {
    const dir = join(r16Root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(dir, ".oxlintrc.json"),
      '{ "rules": { "no-unused-vars": "error" } }\n',
    );
    writeFileSync(join(dir, "a.js"), "const unused = 1;\n");
    writeFileSync(join(dir, "validate.config.json"), config);
    commitAll(dir);
    // The patch relaxes the rule it would fail.
    writeFileSync(
      join(dir, ".oxlintrc.json"),
      '{ "rules": { "no-unused-vars": "off" } }\n',
    );
    return dir;
  };
  const r16Dir = r16Fixture("trusted", "{}\n");
  const trustedOffDir = r16Fixture(
    "trusted-off",
    '{ "tools": { "policy": { "enabled": false } } }\n',
  );
  writeFileSync(
    join(trustedOffDir, "validate.config.ts"),
    'export default { tools: { policy: { enabled: false } }, adapters: [{ id: "stamp", layer: "security", languages: [], bin: "sh", everyRun: true, supportsFix: false, fixWriteBack: false, minVersion: "0.0.0", installHint: "none", versionArgs: ["-c", "echo 1.0.0"], parseVersion: (out) => out.trim(), buildArgs: () => ({ bin: "sh", args: ["-c", "exit 0"] }), parseOutput: (raw) => ({ findings: [], filesProcessed: 0, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }) }] };\n',
  );
  rmSync(join(trustedOffDir, "validate.config.json"));
  gitIn(trustedOffDir)(["add", "validate.config.ts", "validate.config.json"]);
  gitIn(trustedOffDir)(["commit", "--quiet", "-m", "a ts config"]);
  const r16Run = (dir, args) =>
    parseJsonOutput(
      run(
        installedKit,
        [
          "check",
          ...args,
          "--trusted-ref",
          "HEAD",
          "--profile",
          "ci",
          "--json",
        ],
        { cwd: dir, allowedStatuses: [0, 1, 2, 3, 4] },
      ),
      `r16 ${args.join(" ")}`,
    );
  const r16 = {
    onlyOxlint: r16Run(r16Dir, ["--only", "oxlint"]),
    disablePolicy: r16Run(r16Dir, ["--only", "oxlint", "--disable", "policy"]),
    onlyNothing: r16Run(r16Dir, ["--only", "eslint"]),
    langNothing: r16Run(r16Dir, ["--lang", "python"]),
    layerNothing: r16Run(r16Dir, ["--layer", "formal"]),
    onlyPolicy: r16Run(r16Dir, ["--only", "policy"]),
    // ... with a project tool that runs in every run beside it: that tool is
    // not the settings check, and the evidence must not say it ran.
    trustedOff: r16Run(trustedOffDir, ["--only", "oxlint"]),
    // ... and there, --disable policy changes nothing, so it is not refused.
    trustedOffDisable: r16Run(trustedOffDir, [
      "--only",
      "oxlint",
      "--disable",
      "policy",
    ]),
  };
  assert(
    r16.onlyOxlint.exitCode === 1 &&
      policyFound(r16.onlyOxlint) &&
      r16.disablePolicy.exitCode === 2 &&
      r16.onlyNothing.exitCode === 2 &&
      r16.langNothing.exitCode === 2 &&
      r16.layerNothing.exitCode === 2 &&
      r16.onlyPolicy.exitCode === 1 &&
      policyFound(r16.onlyPolicy) &&
      r16.trustedOff.exitCode === 0 &&
      r16.trustedOff.ranTools?.includes("stamp") &&
      r16.trustedOffDisable.exitCode === 0 &&
      r16.trustedOff.evidence?.settingsChecked === false &&
      r16.onlyOxlint.evidence?.settingsChecked === true,
    `R16: ${JSON.stringify(Object.fromEntries(Object.entries(r16).map(([k, v]) => [k, { exit: v.exitCode, policy: policyFound(v), settingsChecked: v.evidence?.settingsChecked, error: v.error?.message?.slice(0, 80) }])))}`,
  );
  // R13 (Codex P12, P12c; a fresh review): the run's config digest covers
  // every adapter field and hook that can change the verdict, nested ones
  // included, and is taken before any adapter code runs. What it cannot
  // identify (a cycle, a RegExp) is a config error before any tool runs.
  const r13Root = join(tempRoot, "r13");
  const r13Run = (name, { prelude = "", fields }) => {
    const dir = join(r13Root, name);
    mkdirSync(dir, { recursive: true });
    // The tool writes `ran` in its folder, so a refused run shows none.
    writeFileSync(
      join(dir, "validate.config.ts"),
      `${prelude}\nexport default { adapters: [{ id: "probe", layer: "security", languages: [], bin: "sh", supportsFix: false, fixWriteBack: false, minVersion: "0.0.0", installHint: "none", versionArgs: ["-c", "echo 1.0.0"], parseVersion: (out) => out.trim(), buildArgs: (ctx) => ({ bin: "sh", args: ["-c", "touch ran"] }), ${fields} }] };\n`,
    );
    const result = parseJsonOutput(
      run(installedKit, ["check", "--only", "probe", "--json"], {
        cwd: dir,
        allowedStatuses: [0, 1, 2, 3, 4],
      }),
      `r13 ${name}`,
    );
    return {
      exit: result.exitCode,
      digest: result.evidence?.configDigest,
      ran: existsSync(join(dir, "ran")),
    };
  };
  const clean =
    "parseOutput: (raw) => ({ findings: [], filesProcessed: 0, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr })";
  const mutating =
    "parseOutput(raw) { this.lastSeen = String(Date.now()) + Math.random(); return { findings: [], filesProcessed: 0, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }; }";
  // One error finding when `control` has one element, none otherwise.
  const sparseCheck =
    'parseOutput(raw) { return { findings: this.control.length === 1 ? [{ tool: "probe", layer: "security", file: "a", line: 1, col: 1, severity: "error", message: "one", fixable: false }] : [], filesProcessed: 0, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }; }';
  const r13 = {
    // P12: one field (optional) turned exit 3 into exit 0 under one digest.
    required: r13Run("required", {
      fields: `optional: false, bin: "__pressure_missing_tool__", ${clean}`,
    }),
    optional: r13Run("optional", {
      fields: `optional: true, bin: "__pressure_missing_tool__", ${clean}`,
    }),
    // A function nested in a field, and a hook.
    nestedTrue: r13Run("nested-true", {
      fields: `rules: { report: () => true }, ${clean}`,
    }),
    nestedFalse: r13Run("nested-false", {
      fields: `rules: { report: () => false }, ${clean}`,
    }),
    // P12c: a field that contains itself, and the literal text a marker
    // would write for it.
    cyclic: r13Run("cyclic", {
      prelude: "const control = {}; control.child = control;",
      fields: `control, ${clean}`,
    }),
    literal: r13Run("literal", {
      fields: `control: { child: "[cycle]" }, ${clean}`,
    }),
    // A value the digest has no faithful form for.
    regex: r13Run("regex", { fields: `match: /hello/, ${clean}` }),
    // An adapter that writes to itself while it runs: the digest is taken
    // before, so two runs of one policy have one digest.
    // Codex P12d: a hole in an array is a value; Array(1) is not [].
    sparse: r13Run("sparse", {
      fields: `control: Array(1), ${sparseCheck}`,
    }),
    empty: r13Run("empty", { fields: `control: [], ${sparseCheck}` }),
    // Codex P12f: a native getter (Map's and Set's `size` read the same)
    // has no source to identify; refused before the tool runs.
    nativeGetter: r13Run("native-getter", {
      fields: `nativeHook: Object.getOwnPropertyDescriptor(Map.prototype, "size").get, ${clean}`,
    }),
    // Codex P12e: an ordinary function that mentions "[native code]" is
    // still an ordinary function.
    nativeText: r13Run("native-text", {
      fields:
        "parseOutput(raw) { const message = '[native code]'; return { findings: [], filesProcessed: 0, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr + message.slice(0, 0) }; }",
    }),
    mutatingA: r13Run("mutating", { fields: mutating }),
    mutatingB: r13Run("mutating", { fields: mutating }),
  };
  assert(
    r13.required.exit === 3 &&
      r13.optional.exit === 0 &&
      typeof r13.required.digest === "string" &&
      r13.required.digest !== r13.optional.digest &&
      r13.nestedTrue.digest !== r13.nestedFalse.digest &&
      r13.cyclic.exit === 2 &&
      !r13.cyclic.ran &&
      r13.literal.exit === 0 &&
      r13.literal.ran &&
      r13.regex.exit === 2 &&
      !r13.regex.ran &&
      r13.sparse.exit === 1 &&
      r13.empty.exit === 0 &&
      r13.sparse.digest !== r13.empty.digest &&
      r13.nativeGetter.exit === 2 &&
      !r13.nativeGetter.ran &&
      r13.nativeText.exit === 0 &&
      r13.nativeText.ran &&
      r13.mutatingA.exit === 0 &&
      r13.mutatingA.digest === r13.mutatingB.digest,
    `R13 digest identity: ${JSON.stringify(r13)}`,
  );
  // R14 (Codex P11, P11b): the installed `validate-kit mcp` over stdio. A
  // failed run_check drops the cached findings, so list_findings and
  // get_finding answer with an error until a run succeeds; with two runs in
  // flight, only the one asked for last may publish.
  const r14Good = join(tempRoot, "r14-good");
  mkdirSync(join(r14Good, "src"), { recursive: true });
  mkdirSync(join(r14Good, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(r14Good, "src", "a.ts"), fine);
  // A slow oxlint with one finding: the concurrent case needs the good run
  // to finish after the failing one.
  writeFileSync(
    join(r14Good, "node_modules", ".bin", "oxlint"),
    `#!/bin/sh\ncase "$1" in --version) echo 'Version: 1.70.0'; exit 0;; esac\nsleep 1\ncat <<'VK_EOF'\n{"diagnostics":[{"message":"m","code":"eslint(no-debugger)","severity":"error","filename":"src/a.ts","labels":[{"span":{"line":1,"column":1}}]}]}\nVK_EOF\nexit 1\n`,
    { mode: 0o755 },
  );
  const r14Missing = join(tempRoot, "r14-does-not-exist");
  const r14 = await mcpSession(r14Good, installedKit);
  const r14Request = { path: r14Good, tools: ["oxlint"] };
  const r14First = await r14.call("run_check", r14Request);
  const r14OldId = r14First.data?.findings?.[0]?.id;
  const r14Failed = await r14.call("run_check", { path: r14Missing });
  const r14StaleList = await r14.call("list_findings", {});
  const r14StaleDetail = await r14.call("get_finding", {
    id: r14OldId ?? "none",
  });
  const r14Again = await r14.call("run_check", r14Request);
  const r14FreshList = await r14.call("list_findings", {});
  // A list for a run that is no longer the cached one is refused.
  const r14StaleRun = await r14.call("list_findings", {
    run: r14First.data?.run,
  });
  // Concurrent: the slow good run first, the failing one after it. Runs go
  // one at a time, so the one asked for last also finishes last and decides
  // what the read tools serve.
  const r14Replies = [];
  await Promise.all([
    r14.call("run_check", r14Request).then(() => r14Replies.push("good")),
    r14
      .call("run_check", { path: r14Missing })
      .then(() => r14Replies.push("failed")),
  ]);
  const r14RaceList = await r14.call("list_findings", {});
  await r14.close();
  assert(
    !r14First.isError &&
      r14First.data?.totalFindings === 1 &&
      typeof r14OldId === "string" &&
      r14Failed.isError &&
      r14StaleList.isError &&
      r14StaleDetail.isError &&
      !r14Again.isError &&
      !r14FreshList.isError &&
      r14FreshList.data?.total === 1 &&
      typeof r14First.data?.run === "number" &&
      r14StaleRun.isError &&
      r14Replies.join() === "good,failed" &&
      r14RaceList.isError,
    `R14 MCP cache: ${JSON.stringify({ r14First: r14First.data?.totalFindings, r14Failed: r14Failed.isError, r14StaleList: r14StaleList.isError, r14StaleDetail: r14StaleDetail.isError, r14Again: r14Again.isError, fresh: r14FreshList.data?.total, r14Replies, r14RaceList: r14RaceList.isError })}`,
  );

  // R15 (Codex P20): an option the CLI does not know, under --json, still
  // prints the JSON error (exit 2), as a config error does.
  const usage = run(installedKit, ["check", "--frobnicate", "--json"], {
    cwd: consumerRoot,
    allowedStatuses: [0, 1, 2, 3, 4],
  });
  let usageJson;
  try {
    usageJson = JSON.parse(usage.stdout);
  } catch {
    usageJson = undefined;
  }
  const helpUnknown = run(installedKit, ["help", "frobnicate", "--json"], {
    cwd: consumerRoot,
    allowedStatuses: [0, 1, 2],
  });
  let helpJson;
  try {
    helpJson = JSON.parse(helpUnknown.stdout);
  } catch {
    helpJson = undefined;
  }
  assert(
    helpUnknown.status === 2 &&
      helpJson?.error?.kind === "usage" &&
      !helpJson.error.message.includes("(outputHelp)"),
    `R15 help for an unknown command under --json: exit ${helpUnknown.status}, stdout ${JSON.stringify(helpUnknown.stdout)}`,
  );
  assert(
    usage.status === 2 &&
      usageJson?.exitCode === 2 &&
      usageJson?.error?.kind === "usage" &&
      usageJson.error.message.includes("frobnicate"),
    `R15 usage error under --json: exit ${usage.status}, stdout ${JSON.stringify(usage.stdout)}`,
  );
  // R8 (Codex P09b; Postiz-RE): a file goes to its nearest root only. A
  // root package and a child package each with their own markers: the
  // child's file was linted from both.
  const r8Root = join(tempRoot, "r8");
  for (const [path, text] of Object.entries({
    "package.json": '{ "name": "root", "private": true }\n',
    "tsconfig.json": strict,
    "src/a.ts": fine,
    "packages/child/package.json": '{ "name": "child" }\n',
    "packages/child/tsconfig.json": strict,
    "packages/child/src/b.ts": fine,
  })) {
    mkdirSync(dirname(join(r8Root, path)), { recursive: true });
    writeFileSync(join(r8Root, path), text);
  }
  const r8Plan = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const kit = await import(process.argv[1]);
const { relative } = await import("node:path");
const { realpathSync } = await import("node:fs");
const root = realpathSync(process.cwd());
const planned = await kit.planCheck({ cwd: root, onlyTools: ["oxlint"] });
const owners = {};
for (const task of planned.tasks)
  for (const file of task.files ?? [])
    (owners[relative(root, file)] ??= []).push(relative(root, task.cwd) || ".");
console.log(JSON.stringify(Object.fromEntries(Object.entries(owners).toSorted())));`,
      pathToFileURL(
        join(consumerRoot, "node_modules", "validate-kit", "dist", "index.js"),
      ).href,
    ],
    { cwd: r8Root, encoding: "utf8" },
  );
  const r8Owners = (() => {
    try {
      return JSON.parse(r8Plan.stdout);
    } catch {
      return undefined;
    }
  })();
  const r8List = JSON.parse(
    run(installedKit, ["list", "--only", "oxlint", "--json"], { cwd: r8Root })
      .stdout,
  ).tasks.reduce((sum, task) => sum + (task.files ?? 0), 0);
  assert(
    JSON.stringify(r8Owners) ===
      JSON.stringify({
        "packages/child/src/b.ts": ["packages/child"],
        "src/a.ts": ["."],
      }) && r8List === 2,
    `R8 nearest root: owners ${r8Plan.stdout.trim()} ${r8Plan.stderr.trim()}, list files ${r8List}`,
  );
  // R11 row 4 (the operator's decision, 2026-10-04): archive/, backups/,
  // logs/ and _superseded* folders are out of scope by default, as in the
  // code atlas; the run says what it skipped (info), and `include` brings a
  // folder back.
  const archiveRoot = join(tempRoot, "r11-archive");
  for (const path of [
    "src/a.ts",
    "archive/old.ts",
    "backups/copy.ts",
    "src/logs/trace.ts",
    "_superseded_v1/x.ts",
  ]) {
    mkdirSync(dirname(join(archiveRoot, path)), { recursive: true });
    writeFileSync(
      join(archiveRoot, path),
      path === "src/a.ts" ? fine : consoleLine,
    );
  }
  const archiveRun = (config) => {
    writeFileSync(join(archiveRoot, "validate.config.json"), config);
    return parseJsonOutput(
      run(installedKit, ["check", "--only", "ast-grep", "--json"], {
        cwd: archiveRoot,
        allowedStatuses: [0, 1],
      }),
      "r11 archive",
    );
  };
  const archiveDefault = archiveRun("{}\n");
  const archiveIncluded = archiveRun('{ "include": ["src", "archive"] }\n');
  const skippedNote = archiveDefault.findings.find(
    (f) => f.tool === "scope" && f.ruleId === "default-ignored",
  );
  assert(
    archiveDefault.exitCode === 0 &&
      archiveConsoleFiles(archiveDefault).length === 0 &&
      skippedNote?.severity === "info" &&
      /4 file/.test(skippedNote.message) &&
      archiveIncluded.exitCode === 1 &&
      archiveConsoleFiles(archiveIncluded).join() === "archive/old.ts",
    `R11 archive defaults: default ${archiveDefault.exitCode} ${JSON.stringify(archiveConsoleFiles(archiveDefault))} note ${JSON.stringify(skippedNote)}; included ${archiveIncluded.exitCode} ${JSON.stringify(archiveConsoleFiles(archiveIncluded))}`,
  );
  // R2 (the operator's decision, 2026-10-04; RH-Bundler): crate and module
  // tools (clippy, rustfmt, golangci-lint) run only where Cargo.toml or go.mod
  // is, never at a root with neither (they crashed there); files outside every
  // crate or module are named in an info note; gofmt, which reads files,
  // still checks the loose ones.
  const r2Root = join(tempRoot, "r2");
  const r2Fixture = (name, files) => {
    const dir = join(r2Root, name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const listed = JSON.parse(
      run(installedKit, ["list", "--json"], { cwd: dir }).stdout,
    );
    return {
      tasks: listed.tasks
        .filter((t) =>
          ["clippy", "rustfmt", "golangci-lint", "gofmt", "gofumpt"].includes(
            t.tool,
          ),
        )
        .map((t) => `${t.tool}@${t.cwd}:${t.files ?? "-"}`)
        .toSorted(),
      notes: (listed.notes ?? [])
        .map((n) => `${n.reason}:${n.lang ?? ""}:${n.files.length}`)
        .toSorted(),
    };
  };
  const looseRust = "fn main() {}\n";
  const looseGo = "package main\n";
  const r2 = {
    // No Cargo.toml and no go.mod anywhere.
    bare: r2Fixture("bare", {
      "evidence/x.rs": looseRust,
      "evidence/y.go": looseGo,
    }),
    // A crate and a module beside loose files.
    mixed: r2Fixture("mixed", {
      "crate/Cargo.toml":
        '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n',
      "crate/src/lib.rs": "pub fn f() {}\n",
      "mod/go.mod": "module m\n\ngo 1.22\n",
      "mod/a.go": "package m\n",
      "loose/x.rs": looseRust,
      "loose/y.go": looseGo,
    }),
  };
  assert(
    r2.bare.tasks.join() === "gofmt@.:1" &&
      r2.bare.notes.join() === "no-marker:go:1,no-marker:rust:1" &&
      r2.mixed.tasks.join() ===
        "clippy@crate:-,gofmt@.:1,gofmt@mod:1,golangci-lint@mod:-,rustfmt@crate:-" &&
      r2.mixed.notes.join() === "no-marker:go:1,no-marker:rust:1",
    `R2 loose Rust/Go: ${JSON.stringify(r2)}`,
  );
  // DV3 (dark-visitor, 2026-10-09): a tool is found from the folder its task
  // runs in. The only tsc here is frontend's own (a wrapper that answers
  // --version with 9.9.9); the root reaches a different one or none.
  const dvFixture = (name, files) => {
    const dir = join(tempRoot, name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text, { mode: 0o755 });
    }
    return dir;
  };
  const dv3Root = dvFixture("dv3", {
    "go.mod": "module dv3\n\ngo 1.22\n",
    "main.go": "package main\n\nfunc main() {}\n",
    "frontend/tsconfig.json":
      '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n',
    "frontend/src/a.ts": "export const a: number = 1;\n",
    "frontend/node_modules/.bin/tsc": `#!/bin/sh\n[ "$1" = --version ] && { echo "Version 9.9.9"; exit 0; }\nexec ${JSON.stringify(join(repoRoot, "node_modules", ".bin", "tsc"))} "$@"\n`,
  });
  const dv3Doctor = parseJsonOutput(
    run(installedKit, ["doctor", "--json"], {
      cwd: dv3Root,
      allowedStatuses: [0, 3],
    }),
    "dv3 doctor",
  ).tools;
  const dv3Tool = (id) => dv3Doctor.find((t) => t.id === id);
  const dv3Check = parseJsonOutput(
    run(installedKit, ["check", "--only", "tsc", "--json"], { cwd: dv3Root }),
    "dv3 check",
  );
  assert(
    dv3Tool("tsc")?.version === "9.9.9" &&
      dv3Tool("tsc")?.status === "ok" &&
      dv3Check.toolStatus.tsc === "pass",
    `DV3 frontend's own tsc: doctor ${JSON.stringify(dv3Tool("tsc"))}, check ${JSON.stringify(dv3Check.toolStatus)}`,
  );
  // DV14: gofmt states no minimum version and prints none: ok, no warning.
  if (hasTool("gofmt", ["-h"]))
    assert(
      dv3Tool("gofmt")?.status === "ok",
      `DV14 gofmt in doctor: ${JSON.stringify(dv3Tool("gofmt"))}`,
    );

  // DV9: languages.<lang>.tools.<id> sets the tool for that language only;
  // a tool that runs once over all its languages cannot be split.
  const dv9Root = dvFixture("dv9", {
    "a.ts": "debugger;\n",
    "b.mjs": "debugger;\n",
    "validate.config.json":
      '{ "languages": { "ts": { "tools": { "oxlint": { "enabled": false } } } } }\n',
  });
  const dv9Files = parseJsonOutput(
    run(installedKit, ["check", "--only", "oxlint", "--json"], {
      cwd: dv9Root,
      allowedStatuses: [1],
    }),
    "dv9 check",
  ).findings.map((f) => f.file.split("/dv9/")[1]);
  writeFileSync(
    join(dv9Root, "validate.config.json"),
    '{ "vulnAudit": { "enabled": true }, "languages": { "ts": { "tools": { "osv-scanner": { "enabled": false } } } } }\n',
  );
  const dv9Split = run(installedKit, ["list", "--json"], {
    cwd: dv9Root,
    allowedStatuses: [2],
  });
  // A per-language setting leaves each file at the root it had: a.ts in a
  // package with package.json but no tsconfig still runs from that package
  // (a review found it moved to the project root, where ESLint finds no
  // config and drops it).
  const dv9Roots = dvFixture("dv9-roots", {
    "pkg/package.json": '{ "name": "pkg", "private": true }\n',
    "pkg/a.ts": "debugger;\n",
    "pkg/b.js": "debugger;\n",
    "validate.config.json":
      '{ "languages": { "js": { "tools": { "oxlint": { "timeoutMs": 60000 } } } } }\n',
  });
  const dv9Tasks = parseJsonOutput(
    run(installedKit, ["list", "--json", "--only", "oxlint"], {
      cwd: dv9Roots,
    }),
    "dv9 roots",
  )
    .tasks.map((t) => `${t.cwd}:${t.files}`)
    .toSorted()
    .join();
  assert(
    dv9Files.join() === "b.mjs" &&
      dv9Tasks === "pkg:1,pkg:1" &&
      /cannot be set per language/.test(dv9Split.stdout + dv9Split.stderr),
    `DV9 per-language settings: oxlint findings in ${JSON.stringify(dv9Files)}; tasks ${dv9Tasks}; osv split: ${dv9Split.stdout}${dv9Split.stderr}`,
  );

  // DV16: tools.<id>.bin runs the project's executable, not the kit's own
  // copy: a name from PATH only, or a path from the project root. The stub
  // reports one finding the real oxlint never would.
  const stubOxlint = `#!/bin/sh\n[ "$1" = --version ] && { echo "Version: 1.99.0"; exit 0; }\necho '{"diagnostics":[{"message":"stub ran","code":"stub(ran)","severity":"warning","filename":"a.mjs","labels":[{"span":{"offset":0,"length":1,"line":1,"column":1}}]}],"number_of_files":1,"number_of_rules":1}'\nexit 1\n`;
  const dv16Root = dvFixture("dv16", {
    "a.mjs": "debugger;\n",
    "tools/oxlint": stubOxlint,
    "stub-bin/oxlint": stubOxlint,
  });
  const dv16 = (bin, extraEnv = {}) => {
    writeFileSync(
      join(dv16Root, "validate.config.json"),
      JSON.stringify({ tools: { oxlint: { bin } } }),
    );
    const result = run(installedKit, ["check", "--only", "oxlint", "--json"], {
      cwd: dv16Root,
      env: extraEnv,
      allowedStatuses: [0, 1, 2, 3],
    });
    const json = parseJsonOutput(result, `dv16 ${bin}`);
    return {
      status: result.status,
      rules: json.findings.map((f) => f.ruleId),
      problems: json.incomplete.map((i) => i.problem),
    };
  };
  const dv16Path = dv16("oxlint", {
    PATH: `${join(dv16Root, "stub-bin")}${delimiter}${process.env.PATH}`,
  });
  const dv16Relative = dv16("tools/oxlint");
  const dv16Missing = dv16("no-such-oxlint-xyz");
  writeFileSync(
    join(dv16Root, "validate.config.json"),
    '{ "tools": { "lean": { "bin": "lean" } } }\n',
  );
  const dv16Scripted = run(installedKit, ["list"], {
    cwd: dv16Root,
    allowedStatuses: [2],
  });
  assert(
    dv16Path.rules.join() === "stub(ran)" &&
      dv16Relative.rules.join() === "stub(ran)" &&
      dv16Missing.status === 3 &&
      dv16Missing.problems.some((p) => /tools\.oxlint\.bin/.test(p ?? "")) &&
      /runs its tools from a script/.test(dv16Scripted.stderr),
    `DV16 tools.oxlint.bin: ${JSON.stringify({ dv16Path, dv16Relative, dv16Missing, scripted: dv16Scripted.stderr })}`,
  );
  // DV10: --since covers what differs from the ref now, committed or not: an
  // uncommitted edit and an untracked file each fail the run.
  const dv10Root = dvFixture("dv10", { "a.ts": "export const a = 1;\n" });
  commitAll(dv10Root);
  writeFileSync(
    join(dv10Root, "a.ts"),
    "export const a = 1;\nconsole.log(a);\n",
  );
  writeFileSync(join(dv10Root, "b.ts"), "console.log(2);\nexport {};\n");
  const dv10Files = parseJsonOutput(
    run(
      installedKit,
      ["check", "--since", "HEAD", "--only", "ast-grep", "--json"],
      {
        cwd: dv10Root,
        allowedStatuses: [0, 1],
      },
    ),
    "dv10 --since",
  )
    .findings.filter((f) => f.ruleId === "ts-no-console")
    .map((f) => f.file.split("/dv10/")[1])
    .toSorted();
  assert(
    dv10Files.join() === "a.ts,b.ts",
    `DV10 --since HEAD on a dirty tree: ts-no-console in ${JSON.stringify(dv10Files)}`,
  );

  // DV25: a staged run judges the commit. A file with unstaged edits that the
  // commit does not stage (another agent's half-saved file in a shared
  // checkout) is info, not a refusal; a clean file a staged change breaks
  // still fails the commit. tsc reads every file of its project.
  const repoTsc = join(repoRoot, "node_modules", ".bin", "tsc");
  const dvStaged = dvFixture("dv-staged", {
    "tsconfig.json":
      '{ "compilerOptions": { "strict": true, "noEmit": true } }\n',
    "a.ts": "export const one = 1;\n",
    "b.ts": "export const two = 2;\n",
    "c.ts":
      'import { one } from "./a";\nexport const three: number = one + 2;\n',
    "validate.config.json": JSON.stringify({
      tools: { tsc: { bin: repoTsc } },
    }),
  });
  commitAll(dvStaged);
  const stagedGit = gitIn(dvStaged);
  const stagedRun = (label, root = dvStaged) => {
    const result = run(
      installedKit,
      ["check", root, "--staged", "--only", "tsc", "--json"],
      { cwd: tempRoot, allowedStatuses: [0, 1] },
    );
    const json = parseJsonOutput(result, label);
    return `${result.status}:${json.findings
      .filter((f) => f.tool === "tsc")
      .map((f) => `${f.severity}@${f.file.split("/").pop()}`)
      .toSorted()
      .join("+")}`;
  };
  writeFileSync(join(dvStaged, "b.ts"), 'export const two: number = "2";\n');
  writeFileSync(join(dvStaged, "a.ts"), "// one\nexport const one = 1;\n");
  stagedGit(["add", "a.ts"]);
  const otherDirty = stagedRun("dv staged: another file dirty");
  // Through a symlink to the project, the same (Go-based tools read PWD).
  const stagedLink = join(tempRoot, "dv-staged-link");
  symlinkSync(dvStaged, stagedLink);
  const throughLink = stagedRun("dv staged: through a symlink", stagedLink);
  rmSync(stagedLink);
  // A file the commit does not stage that does not parse stops tsc from
  // checking the commit: it still fails, saying why (found in review).
  writeFileSync(join(dvStaged, "d.ts"), "export const d = (\n");
  writeFileSync(join(dvStaged, "a.ts"), 'export const one: number = "1";\n');
  stagedGit(["add", "a.ts"]);
  const masked = stagedRun("dv staged: an untracked file that does not parse");
  rmSync(join(dvStaged, "d.ts"));
  writeFileSync(join(dvStaged, "a.ts"), 'export const one = "1";\n');
  stagedGit(["add", "a.ts"]);
  const breaksClean = stagedRun("dv staged: a staged change breaks c.ts");
  assert(
    otherDirty === "0:info@b.ts" &&
      throughLink === "0:info@b.ts" &&
      masked.startsWith("1:") &&
      masked.includes("error@d.ts") &&
      breaksClean.startsWith("1:") &&
      breaksClean.includes("@c.ts"),
    `DV25 staged runs: ${JSON.stringify({ otherDirty, throughLink, masked, breaksClean })}`,
  );

  // DV12: a scope of only models and proofs still has work: it plans tlc,
  // and is no "matched no source files" error beside Go outside the scope.
  const dv12Root = dvFixture("dv12", {
    "src/main.go": "package main\n\nfunc main() {}\n",
    "formal/Toggle.tla": readFileSync(
      join(repoRoot, "tests/fixtures/formal/tla/variant/Toggle.tla"),
      "utf8",
    ),
    "formal/Toggle.cfg": "INIT Init\nNEXT Next\nINVARIANT Good\n",
    "validate.config.json": '{ "include": ["formal"] }\n',
  });
  const dv12Tools = parseJsonOutput(
    run(installedKit, ["list", "--json"], { cwd: dv12Root }),
    "dv12 list",
  ).tasks.map((t) => t.tool);
  assert(
    dv12Tools.includes("tlc"),
    `DV12 formal-only scope plans tlc: ${JSON.stringify(dv12Tools)}`,
  );

  // DV11a: shell scripts reach shellcheck: one warning gates, a clean script
  // passes, and an option that breaks its JSON is a config error.
  let shellcheckCase = "shellcheck not installed: skipped";
  if (hasTool("shellcheck", ["--version"])) {
    const dv11Root = dvFixture("dv11", {
      "bin/run.sh": "#!/bin/sh\nunused=1\n",
      "clean.bash": '#!/bin/bash\necho "ok"\n',
    });
    const dv11 = parseJsonOutput(
      run(installedKit, ["check", "--only", "shellcheck", "--json"], {
        cwd: dv11Root,
        allowedStatuses: [1],
      }),
      "dv11 shellcheck",
    );
    writeFileSync(
      join(dv11Root, "validate.config.json"),
      '{ "tools": { "shellcheck": { "extraArgs": ["-a"] } } }\n',
    );
    const dv11Refused = run(installedKit, ["list"], {
      cwd: dv11Root,
      allowedStatuses: [2],
    });
    // A script that sources another gets the same findings checked alone
    // (a changed-file run) as in the full run, where the sourced file is
    // another input: no SC1091 (dark-visitor, 2026-10-09).
    const dvSource = dvFixture("dv11-source", {
      "scripts/dev/pins.sh": "#!/bin/sh\nPIN=1\n",
      "scripts/dev/doctor.sh":
        '#!/bin/sh\n# shellcheck source=scripts/dev/pins.sh\n. scripts/dev/pins.sh\necho "$PIN"\n',
    });
    commitAll(dvSource);
    writeFileSync(
      join(dvSource, "scripts/dev/doctor.sh"),
      '#!/bin/sh\n# shellcheck source=scripts/dev/pins.sh\n. scripts/dev/pins.sh\necho "$PIN" "$PIN"\n',
    );
    const sourcedAlone = parseJsonOutput(
      run(
        installedKit,
        ["check", "--changed", "--only", "shellcheck", "--json"],
        { cwd: dvSource, allowedStatuses: [0, 1] },
      ),
      "dv11 sourced script alone",
    ).findings.map((f) => f.ruleId);
    shellcheckCase = findingLines(dv11.findings, "dv11").join();
    assert(
      sourcedAlone.length === 0 &&
        shellcheckCase === "SC2034 bin/run.sh:2" &&
        dv11.findings[0]?.severity === "warning" &&
        /check-sourced/.test(dv11Refused.stderr),
      `DV11a shellcheck: ${shellcheckCase} ${dv11Refused.stderr}; a sourced script alone: ${JSON.stringify(sourcedAlone)}`,
    );
  }

  // DV11b: Biome where a Biome config reaches the files, run from that
  // config's folder although the package root is above it (spawned above its
  // root config, Biome fails); a nested config's own rules apply; prettier's
  // not-adopted note leaves out what Biome formats. The repository's own
  // pinned Biome, through tools.<id>.bin.
  const repoBiome = join(repoRoot, "node_modules", ".bin", "biome");
  const dv11bRoot = dvFixture("dv11b", {
    "package.json": '{ "name": "dv11b", "private": true }\n',
    "frontend/biome.json":
      '{ "linter": { "rules": { "recommended": true } } }\n',
    "frontend/src/a.ts": "debugger;\nexport const a = 1;\n",
    "frontend/src/b.ts": "export const b   =  1\n",
    "frontend/pkg/biome.json":
      '{ "root": false, "extends": "//", "linter": { "rules": { "suspicious": { "noDebugger": "off" } } } }\n',
    "frontend/pkg/src/p.ts": "debugger;\nexport const p = 1;\n",
    "top.ts": "export const c = 1;\n",
    "validate.config.json": JSON.stringify({
      tools: { biome: { bin: repoBiome }, "biome-format": { bin: repoBiome } },
    }),
  });
  const dv11bList = parseJsonOutput(
    run(installedKit, ["list", "--json"], { cwd: dv11bRoot }),
    "dv11b list",
  );
  const dv11bCheck = parseJsonOutput(
    run(installedKit, ["check", "--only", "biome", "biome-format", "--json"], {
      cwd: dv11bRoot,
      allowedStatuses: [1],
    }),
    "dv11b check",
  );
  const dv11b = {
    cwds: [
      ...new Set(
        dv11bList.tasks
          .filter((t) => t.tool.startsWith("biome"))
          .map((t) => t.cwd),
      ),
    ].join(),
    prettierNote: (dv11bList.notes ?? [])
      .filter((n) => n.tool === "prettier")
      .flatMap((n) => n.files)
      .map((f) => f.split("/dv11b/").pop())
      .join(),
    findings: findingLines(dv11bCheck.findings, "dv11b").join(),
  };
  // A root Biome config above the project (in the repository) reaches the
  // project's files, nested config or not (found in review: app/b.js was
  // dropped).
  const dvUpRoot = dvFixture("dv-biome-up", {
    "biome.json": '{ "linter": { "rules": { "recommended": true } } }\n',
    "app/b.js": "debugger;\n",
    "app/src/biome.json": '{ "root": false, "extends": "//" }\n',
    "app/src/deep/a.js": "debugger;\n",
    "app/validate.config.json": JSON.stringify({
      tools: { biome: { bin: repoBiome } },
    }),
  });
  gitIn(dvUpRoot)(["init", "--quiet"]);
  dv11b.aboveProject = findingLines(
    parseJsonOutput(
      run(installedKit, ["check", "--only", "biome", "--json"], {
        cwd: join(dvUpRoot, "app"),
        allowedStatuses: [1],
      }),
      "dv biome above the project",
    ).findings,
    "app",
  ).join();
  // A config named only by configPath, with no biome.json in the tree, still
  // runs Biome (a review found its files dropped).
  const dv11cRoot = dvFixture("dv11c", {
    "config/biome.json": '{ "formatter": { "indentStyle": "space" } }\n',
    "a.js": "export const b   =  1\n",
    "validate.config.json": JSON.stringify({
      tools: {
        "biome-format": { bin: repoBiome, configPath: "config/biome.json" },
      },
    }),
  });
  dv11b.configPathOnly = findingLines(
    parseJsonOutput(
      run(installedKit, ["check", "--only", "biome-format", "--json"], {
        cwd: dv11cRoot,
        allowedStatuses: [1],
      }),
      "dv11c configPath",
    ).findings,
    "dv11c",
  ).join();
  assert(
    dv11b.configPathOnly === "format a.js:1" &&
      dv11b.aboveProject ===
        "lint/suspicious/noDebugger b.js:1,lint/suspicious/noDebugger src/deep/a.js:1" &&
      dv11b.cwds === "frontend" &&
      dv11b.prettierNote === "top.ts" &&
      dv11b.findings ===
        "format frontend/src/b.ts:1,lint/suspicious/noDebugger frontend/src/a.ts:1",
    `DV11b Biome: ${JSON.stringify(dv11b)}`,
  );

  // A configured executable that is missing is a missing tool even for an
  // optional one: it was chosen, not left uninstalled (found in review).
  writeFileSync(
    join(dv16Root, "validate.config.json"),
    '{ "tools": { "semgrep": { "bin": "no-such-semgrep-xyz" } } }\n',
  );
  const dv16Optional = run(installedKit, ["check", "--only", "semgrep"], {
    cwd: dv16Root,
    allowedStatuses: [0, 3],
  }).status;
  assert(
    dv16Optional === 3,
    `DV16 a missing configured bin for an optional tool: exit ${dv16Optional}`,
  );
  // Under --trusted-ref, the settings check covers Biome's and shellcheck's
  // configs and an executable the config names by path: a patch that turns
  // them off or rewrites the wrapper is judged by the trusted policy (found
  // in review: all three passed).
  const dvPolicyRoot = dvFixture("dv-policy", {
    "a.js": "export const a = 1;\n",
    "run.sh": "#!/bin/sh\necho ok\n",
    "biome.json": '{ "linter": { "enabled": true } }\n',
    "tools/sc": '#!/bin/sh\nexec shellcheck "$@"\n',
    "validate.config.json":
      '{ "tools": { "shellcheck": { "bin": "tools/sc" } } }\n',
  });
  commitAll(dvPolicyRoot);
  writeFileSync(
    join(dvPolicyRoot, "biome.json"),
    '{ "linter": { "enabled": false } }\n',
  );
  writeFileSync(join(dvPolicyRoot, ".shellcheckrc"), "disable=all\n");
  writeFileSync(
    join(dvPolicyRoot, "tools", "sc"),
    `#!/bin/sh\necho '{"comments":[]}'\n`,
  );
  const dvPolicy = parseJsonOutput(
    run(
      installedKit,
      ["check", "--only", "policy", "--trusted-ref", "HEAD", "--json"],
      { cwd: dvPolicyRoot, allowedStatuses: [1] },
    ),
    "dv policy",
  )
    .findings.filter((f) => f.tool === "policy")
    .map((f) => f.file.split("/dv-policy/").pop())
    .toSorted()
    .join();
  assert(
    dvPolicy === ".shellcheckrc,biome.json,tools/sc",
    `trusted policy over Biome, shellcheck and a configured bin: ${dvPolicy}`,
  );

  // DV7: golangci-lint naming a file outside the module it checked (a cache
  // shared with another checkout did) is a crash, not a finding. A stub
  // stands in for golangci-lint through tools.<id>.bin.
  const strayRoot = dvFixture("dv7", {
    "go.mod": "module stray\n\ngo 1.22\n",
    "main.go": "package main\n\nfunc main() {}\n",
    "stub/golangci-lint": `#!/bin/sh\n[ "$1" = --version ] && { echo "golangci-lint has version 2.12.2"; exit 0; }\necho '{"Issues":[{"FromLinter":"errcheck","Text":"x","Pos":{"Filename":"/elsewhere/clone/main.go","Line":3,"Column":1}}],"Report":{}}'\nexit 1\n`,
    "validate.config.json":
      '{ "tools": { "golangci-lint": { "bin": "stub/golangci-lint" } } }\n',
  });
  const stray = parseJsonOutput(
    run(installedKit, ["check", "--only", "golangci-lint", "--json"], {
      cwd: strayRoot,
      allowedStatuses: [4],
    }),
    "dv7 stray issue",
  );
  assert(
    stray.findings.length === 0 &&
      stray.crashed.some((c) => c.stderr.includes("/elsewhere/clone/main.go")),
    `DV7 an issue outside the module: ${JSON.stringify(stray.crashed)}`,
  );
  // DV4-6 (dark-visitor): every issue (60 errcheck, past the default cap of
  // 50), a nested module that inherits its parent's config reported at files
  // that exist, configPath honoured, and the cache in the checkout's git
  // folder.
  let golangciCase = "golangci-lint not installed: skipped";
  if (hasTool("golangci-lint", ["--version"])) {
    const dv4Root = dvFixture("dv4", {
      "svc/.golangci.yml":
        'version: "2"\nlinters:\n  default: none\n  enable: [errcheck, ineffassign]\n',
      "only-ineff.yml":
        'version: "2"\nlinters:\n  default: none\n  enable: [ineffassign]\n',
      "svc/go.mod": "module svc\n\ngo 1.22\n",
      "svc/main.go": [
        "package main",
        "",
        'import "os"',
        "",
        "func main() {",
        ...Array.from({ length: 60 }, (_, i) => `\tos.Remove("f${i}")`),
        "\tx := 1",
        "\tx = 2",
        "\t_ = x",
        "}",
        "",
      ].join("\n"),
      "svc/tools/sub/go.mod": "module sub\n\ngo 1.22\n",
      "svc/tools/sub/main.go":
        'package main\n\nimport "os"\n\nfunc main() { os.Remove("x") }\n',
      "shared/helper.go": "package main\n\nfunc helper() {}\n",
    });
    // A file linked into the module from outside it is the module's: no
    // stray path (a review found the real path counted).
    symlinkSync(
      join(dv4Root, "shared", "helper.go"),
      join(dv4Root, "svc", "helper.go"),
    );
    commitAll(dv4Root);
    const golangciCounts = (label) => {
      const result = parseJsonOutput(
        run(installedKit, ["check", "--only", "golangci-lint", "--json"], {
          cwd: dv4Root,
          allowedStatuses: [1],
        }),
        label,
      );
      const counts = {};
      // golangci-lint's own: the loose shared/helper.go adds a scope note.
      for (const f of result.findings.filter(
        (item) => item.tool === "golangci-lint",
      )) {
        const key = `${f.ruleId} ${f.file.split("/dv4/")[1]}${existsSync(f.file) ? "" : " (missing)"}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return JSON.stringify(counts);
    };
    const all = golangciCounts("dv4 golangci");
    writeFileSync(
      join(dv4Root, "validate.config.json"),
      '{ "tools": { "golangci-lint": { "configPath": "only-ineff.yml" } } }\n',
    );
    const configured = golangciCounts("dv4 golangci configPath");
    // A project reached through a symlink keeps its own spelling: golangci-
    // lint prints real paths, which a baseline keyed by the project's
    // spelling would miss (found in review).
    const dv4Link = join(tempRoot, "dv4-link");
    symlinkSync(dv4Root, dv4Link);
    const respelled = parseJsonOutput(
      run(
        installedKit,
        ["check", dv4Link, "--only", "golangci-lint", "--json"],
        { cwd: tempRoot, allowedStatuses: [1] },
      ),
      "dv4 through a symlink",
    ).findings.filter(
      (f) => f.tool === "golangci-lint" && !f.file.startsWith(`${dv4Link}/`),
    ).length;
    rmSync(dv4Link);
    // A checkout moved elsewhere gets a cache of its own place: the old one
    // would return the old paths, every run exit 4 (found in review).
    const movedRoot = join(tempRoot, "dv4-elsewhere");
    renameSync(dv4Root, movedRoot);
    const moved = parseJsonOutput(
      run(installedKit, ["check", "--only", "golangci-lint", "--json"], {
        cwd: movedRoot,
        allowedStatuses: [1],
      }),
      "dv4 moved",
    ).findings.filter(
      (f) => f.tool === "golangci-lint" && !f.file.includes("/dv4-elsewhere/"),
    ).length;
    renameSync(movedRoot, dv4Root);
    // A root go.work that lists only one module (dark-visitor, for gopls):
    // the other module runs with GOWORK=off instead of crashing, and two
    // listed modules still resolve each other through the workspace.
    const goWork = dvFixture("dv-gowork", {
      "go.work": "go 1.22\n\nuse (\n\t./a\n\t./b\n)\n",
      "a/go.mod": "module example.com/a\n\ngo 1.22\n",
      "a/a.go": 'package a\n\nfunc Hello() string { return "hi" }\n',
      "b/go.mod":
        "module example.com/b\n\ngo 1.22\n\nrequire example.com/a v0.0.0\n",
      "b/main.go":
        'package main\n\nimport (\n\t"os"\n\n\t"example.com/a"\n)\n\nfunc main() { os.Remove(a.Hello()) }\n',
      "tools/fx/go.mod": "module fx\n\ngo 1.22\n",
      "tools/fx/main.go":
        'package main\n\nimport "os"\n\nfunc main() { os.Remove("x") }\n',
    });
    commitAll(goWork);
    const workspaceRun = parseJsonOutput(
      run(installedKit, ["check", "--only", "golangci-lint", "--json"], {
        cwd: goWork,
        allowedStatuses: [1, 4],
      }),
      "dv go.work",
    );
    const workspaceFiles = findingLines(
      workspaceRun.findings,
      "dv-gowork",
    ).join();
    golangciCase = `${all} ${configured} strays-after-move:${moved} respelled:${respelled} go.work:${workspaceFiles}`;
    assert(
      all ===
        '{"errcheck svc/main.go":60,"ineffassign svc/main.go":1,"errcheck svc/tools/sub/main.go":1}' &&
        configured === '{"ineffassign svc/main.go":1}' &&
        moved === 0 &&
        respelled === 0 &&
        workspaceRun.crashed.length === 0 &&
        workspaceFiles === "errcheck b/main.go:9,errcheck tools/fx/main.go:5" &&
        existsSync(join(dv4Root, ".git", "validate-kit", "golangci-lint")),
      `DV4-6 golangci-lint: ${golangciCase}`,
    );
  }

  // DV22 (dark-visitor, 2026-10-10): a changed-file run lints the packages
  // the change reaches (the changed ones and their in-module importers), not
  // the whole module (docs/research/lint-toolchain/golangci-changed-packages.md).
  let dv22Case = "golangci-lint not installed: skipped";
  if (hasTool("golangci-lint", ["--version"])) {
    const dv22Root = dvFixture("dv22", {
      "go.mod": "module dv22\n\ngo 1.22\n",
      "a/a.go": "package a\n\nfunc Save() error { return nil }\n",
      "b/b.go": 'package b\n\nimport "dv22/a"\n\nfunc Use() { a.Save() }\n',
      "c/c.go": "package c\n\nfunc C() int { return 1 }\n",
      "d/d.go": 'package d\n\nimport "os"\n\nfunc D() { os.Remove("x") }\n',
    });
    const dv22Git = gitIn(dv22Root);
    dv22Git(["init", "--quiet"]);
    dv22Git(["add", "-A"]);
    dv22Git(["commit", "--quiet", "-m", "base"]);
    const stagedLint = (label) =>
      findingLines(
        parseJsonOutput(
          run(
            installedKit,
            [
              "check",
              "--staged",
              "--profile",
              "dev",
              "--only",
              "golangci-lint",
              "--json",
            ],
            { cwd: dv22Root, allowedStatuses: [0, 1] },
          ),
          label,
        ).findings,
        "dv22",
      ).join();
    // c has no importers: only c is linted, so b's and d's findings are not.
    writeFileSync(
      join(dv22Root, "c", "c.go"),
      'package c\n\nimport "os"\n\nfunc C() int { os.Remove("y"); return 1 }\n',
    );
    dv22Git(["add", "c/c.go"]);
    const leaf = stagedLint("dv22 leaf");
    dv22Git(["commit", "--quiet", "-m", "c"]);
    // a is imported by b: b is linted too, and its finding is reported.
    writeFileSync(
      join(dv22Root, "a", "a.go"),
      "package a\n\n// Save saves.\nfunc Save() error { return nil }\n",
    );
    dv22Git(["add", "a/a.go"]);
    const imported = stagedLint("dv22 imported");
    const full = findingLines(
      parseJsonOutput(
        run(installedKit, ["check", "--only", "golangci-lint", "--json"], {
          cwd: dv22Root,
          allowedStatuses: [1],
        }),
        "dv22 full",
      ).findings,
      "dv22",
    ).join();
    // Deleting a package b imports: b no longer builds, and is linted.
    dv22Git(["commit", "--quiet", "-m", "a"]);
    dv22Git(["rm", "-r", "--quiet", "a"]);
    const deleted = stagedLint("dv22 deleted");
    dv22Case = `leaf:${leaf} imported:${imported} full:${full} deleted:${deleted}`;
    assert(
      dv22Case ===
        "leaf:errcheck c/c.go:5 imported:errcheck b/b.go:5 full:errcheck b/b.go:5,errcheck c/c.go:5,errcheck d/d.go:5 deleted:typecheck b/b.go:3",
      `DV22 golangci-lint changed packages: ${dv22Case}`,
    );
  }

  // DV23 (dark-visitor, 2026-10-10): five report-only tools, each run only
  // where the repository chose it (docs/research/lint-toolchain/*-cli.md),
  // each with a planted finding and a clean fixture. The npm tools are
  // installed at the versions the research recorded; gitleaks and deadcode
  // are the machine's.
  const dv23Tools = join(tempRoot, "dv23-tools");
  mkdirSync(dv23Tools);
  writeFileSync(
    join(dv23Tools, "package.json"),
    '{ "name": "dv23-tools", "private": true }\n',
  );
  run(
    "pnpm",
    ["add", "-D", "knip@6.41.0", "jscpd@5.4.1", "squawk-cli@2.68.0"],
    { cwd: dv23Tools },
  );
  const goBin = join(tempRoot, "dv23-go-bin");
  const dv23Env = {
    PATH: [
      join(dv23Tools, "node_modules", ".bin"),
      goBin,
      process.env.PATH,
    ].join(delimiter),
  };
  const dv23Check = (dir, args, label) =>
    parseJsonOutput(
      run(installedKit, ["check", ...args, "--json"], {
        cwd: dir,
        env: dv23Env,
        allowedStatuses: [0, 1],
      }),
      label,
    );
  const dv23Tasks = (dir) =>
    parseJsonOutput(
      run(installedKit, ["list", "--profile", "ci", "--json"], {
        cwd: dir,
        env: dv23Env,
      }),
      "dv23 list",
    ).tasks.map((task) => task.tool);
  const dv23 = {};
  // squawk: migrations only, down migrations and other SQL left out.
  const squawkFiles = {
    "db/migrations/001_index.sql":
      "CREATE INDEX idx_users_email ON users (email);\n",
    "db/migrations/001_index.down.sql": "DROP INDEX idx_users_email;\n",
    "db/views/report.sql": "CREATE INDEX v ON t (c);\n",
  };
  const squawkRoot = dvFixture("dv23-squawk", {
    ...squawkFiles,
    ".squawk.toml": "",
  });
  dv23.squawk = findingLines(
    dv23Check(squawkRoot, ["--only", "squawk"], "dv23 squawk").findings,
    "dv23-squawk",
  ).join();
  dv23.squawkClean = dv23Check(
    dvFixture("dv23-squawk-clean", {
      ".squawk.toml": "",
      "migrations/002_note.sql":
        "SET lock_timeout = '1s';\nSET statement_timeout = '5s';\nALTER TABLE users ADD COLUMN IF NOT EXISTS note text;\n",
    }),
    ["--only", "squawk"],
    "dv23 squawk clean",
  ).findings.length;
  // Not chosen: not planned, and the .sql files are not unrouted source.
  dv23.squawkNotChosen = dv23Tasks(
    dvFixture("dv23-squawk-off", {
      ...squawkFiles,
      "tool.py": "x = 1\n",
      // An upper-case extension of an opt-in language stops nothing.
      "db/Init.SQL": "SELECT 1;\n",
    }),
  ).includes("squawk");
  // knip: the whole project, findings in the kit's scope.
  const knipFiles = {
    "package.json":
      '{ "name": "k", "private": true, "type": "module", "main": "index.js", "dependencies": { "left-pad": "1.3.0" } }\n',
    "knip.json": "{}\n",
    "index.js": 'import { used } from "./lib.js";\nconsole.log(used);\n',
    "lib.js": "export const used = 1;\nexport const unused = 2;\n",
    "orphan.js": "export const x = 1;\n",
    "node_modules/.keep": "",
  };
  const knipRoot = dvFixture("dv23-knip", knipFiles);
  dv23.knip = findingLines(
    dv23Check(knipRoot, ["--only", "knip"], "dv23 knip").findings,
    "dv23-knip",
  ).join();
  const { "orphan.js": _orphan, ...usedFiles } = knipFiles;
  dv23.knipClean = dv23Check(
    dvFixture("dv23-knip-clean", {
      ...usedFiles,
      "package.json":
        '{ "name": "k", "private": true, "type": "module", "main": "index.js" }\n',
      "lib.js": "export const used = 1;\n",
    }),
    ["--only", "knip"],
    "dv23 knip clean",
  ).findings.length;
  // jscpd: one finding per side of a copied stretch.
  const jscpdRoot = dvFixture("dv23-jscpd", {
    ".jscpd.json": "{}\n",
    "src/a.ts": copiedBlock("first"),
    "src/b.ts": `// b\n${copiedBlock("second")}`,
  });
  const jscpdFindings = dv23Check(
    jscpdRoot,
    ["--only", "jscpd"],
    "dv23 jscpd",
  ).findings;
  dv23.jscpd = findingLines(jscpdFindings, "dv23-jscpd").join();
  dv23.jscpdMessage = jscpdFindings.some(
    (f) => f.message === "Duplicated in src/b.ts:2-17 (16 lines, 235 tokens)",
  );
  dv23.jscpdClean = dv23Check(
    dvFixture("dv23-jscpd-clean", {
      ".jscpd.json": "{}\n",
      "src/a.ts": copiedBlock("first"),
    }),
    ["--only", "jscpd"],
    "dv23 jscpd clean",
  ).findings.length;
  // gitleaks: the commit's staged files, and a full run that skips what git
  // ignores. The key is the research's fake one, assembled here.
  const fakeKey = ["AKIA", "LALEMEL33243OLIB"].join("");
  let gitleaksCase = "gitleaks not installed: skipped";
  if (hasTool("gitleaks", ["version"])) {
    const leakRoot = dvFixture("dv23-gitleaks", {
      ".gitleaksignore": "",
      ".gitignore": "build/\n",
      "src/clean.ts": "export const a = 1;\n",
    });
    const leakGit = gitIn(leakRoot);
    leakGit(["init", "--quiet"]);
    leakGit(["add", "-A"]);
    leakGit(["commit", "--quiet", "-m", "base"]);
    const leakClean = dv23Check(
      leakRoot,
      ["--only", "gitleaks"],
      "dv23 gitleaks",
    );
    mkdirSync(join(leakRoot, "build"));
    writeFileSync(join(leakRoot, "build", "out.js"), `var k = "${fakeKey}";\n`);
    writeFileSync(
      join(leakRoot, "src", "settings.ts"),
      `export const awsKey = "${fakeKey}";\n`,
    );
    // A dotfile is outside the kit's scope, and its secret still counts.
    writeFileSync(join(leakRoot, ".deploy.conf"), `AWS_KEY=${fakeKey}\n`);
    leakGit(["add", "src/settings.ts", ".deploy.conf"]);
    const staged = run(
      installedKit,
      ["check", "--staged", "--only", "gitleaks", "--json"],
      { cwd: leakRoot, env: dv23Env, allowedStatuses: [1] },
    );
    const full = dv23Check(leakRoot, ["--only", "gitleaks"], "dv23 gitleaks");
    // A pathspec commit's pre-commit: what is committed is the hook's index
    // (HEAD plus the named path), not .git/index, and gitleaks reads it.
    writeFileSync(
      join(leakRoot, "src", "pathspec.ts"),
      `export const key = "${fakeKey}";\n`,
    );
    const hookIndex = {
      GIT_INDEX_FILE: join(leakRoot, ".git", "next-index-smoke.lock"),
    };
    run("git", ["read-tree", "HEAD"], { cwd: leakRoot, env: hookIndex });
    run("git", ["add", "src/pathspec.ts"], { cwd: leakRoot, env: hookIndex });
    const pathspec = run(
      installedKit,
      ["check", "--staged", "--only", "gitleaks", "--json"],
      {
        cwd: leakRoot,
        env: { ...dv23Env, ...hookIndex },
        allowedStatuses: [0, 1],
      },
    );
    rmSync(hookIndex.GIT_INDEX_FILE);
    rmSync(join(leakRoot, "src", "pathspec.ts"));
    // Chosen only by a task step (dark-visitor, 2026-10-10): the change is
    // scanned, the secrets already committed are not, until the kit's config
    // or gitleaks' own files choose the whole tree.
    const stepRoot = dvFixture("dv23-gitleaks-step", {
      justfile: "secrets:\n\tgitleaks git --staged\n",
      "src/old.txt": `old = "${fakeKey}"\n`,
      "src/a.py": "x = 1\n",
    });
    const stepGit = gitIn(stepRoot);
    stepGit(["init", "--quiet"]);
    stepGit(["add", "-A"]);
    stepGit(["commit", "--quiet", "-m", "base"]);
    const stepFull = dv23Check(
      stepRoot,
      ["--only", "ast-grep", "gitleaks"],
      "dv23 gitleaks step full",
    ).ranTools.includes("gitleaks");
    writeFileSync(join(stepRoot, "src", "new.txt"), `n = "${fakeKey}"\n`);
    stepGit(["add", "src/new.txt"]);
    const stepStaged = findingLines(
      parseJsonOutput(
        run(
          installedKit,
          ["check", "--staged", "--only", "gitleaks", "--json"],
          { cwd: stepRoot, env: dv23Env, allowedStatuses: [1] },
        ),
        "dv23 gitleaks step staged",
      ).findings,
      "dv23-gitleaks-step",
    ).join();
    gitleaksCase = [
      `clean:${leakClean.findings.length}`,
      `staged:${findingLines(parseJsonOutput(staged, "dv23 gitleaks staged").findings, "dv23-gitleaks").join()}`,
      `full:${findingLines(full.findings, "dv23-gitleaks").join()}`,
      `pathspec:${findingLines(parseJsonOutput(pathspec, "dv23 gitleaks pathspec").findings, "dv23-gitleaks").join()}`,
      `secretPrinted:${staged.stdout.includes(fakeKey) || staged.stderr.includes(fakeKey)}`,
      `stepFull:${stepFull}`,
      `stepStaged:${stepStaged}`,
    ].join(" ");
  }
  dv23.gitleaks = gitleaksCase;
  // deadcode: under ci, a function no main reaches.
  // On Go 1.25, v0.49.0: later releases need Go 1.26 (go-deadcode.md, 6).
  let deadcodeCase = "go not installed: skipped";
  if (hasTool("go", ["version"])) {
    run("go", ["install", "golang.org/x/tools/cmd/deadcode@v0.49.0"], {
      env: { GOBIN: goBin },
    });
    const deadRoot = dvFixture("dv23-deadcode", {
      "go.mod": "module dead\n\ngo 1.22\n",
      "main.go":
        "package main\n\nfunc main() { live() }\n\nfunc live() {}\n\nfunc dead() {}\n",
      "validate.config.json":
        '{ "tools": { "deadcode": { "enabled": true } } }\n',
    });
    deadcodeCase = findingLines(
      dv23Check(
        deadRoot,
        ["--only", "deadcode", "--profile", "ci"],
        "dv23 deadcode",
      ).findings,
      "dv23-deadcode",
    ).join();
  }
  dv23.deadcode = deadcodeCase;
  assert(
    dv23.squawk ===
      "prefer-robust-stmts db/migrations/001_index.sql:1,require-concurrent-index-creation db/migrations/001_index.sql:1,require-lock-timeout db/migrations/001_index.sql:1,require-statement-timeout db/migrations/001_index.sql:1" &&
      dv23.squawkClean === 0 &&
      dv23.squawkNotChosen === false &&
      dv23.knip ===
        "dependencies package.json:1,exports lib.js:2,files orphan.js:1" &&
      dv23.knipClean === 0 &&
      dv23.jscpd === "duplicate-code src/a.ts:1,duplicate-code src/b.ts:2" &&
      dv23.jscpdMessage &&
      dv23.jscpdClean === 0 &&
      (dv23.gitleaks === "gitleaks not installed: skipped" ||
        dv23.gitleaks ===
          "clean:0 staged:aws-access-token .deploy.conf:1,aws-access-token src/settings.ts:1 full:aws-access-token .deploy.conf:1,aws-access-token src/settings.ts:1 pathspec:aws-access-token src/pathspec.ts:1 secretPrinted:false stepFull:false stepStaged:aws-access-token src/new.txt:1") &&
      (dv23.deadcode === "go not installed: skipped" ||
        dv23.deadcode === "unreachable-func main.go:7"),
    `DV23 opt-in tools: ${JSON.stringify(dv23)}`,
  );

  // R11 row 3 (the operator's decision, 2026-10-04): a program's output is
  // its product, so the print/console rules skip CLI entry files: bin/,
  // scripts/, a shebang on the first line, Python's __main__, Go's package
  // main. Library code keeps the rules.
  const cliRoot = join(tempRoot, "r11-cli");
  const cliFiles = {
    "bin/tool.js": 'console.log("out");\n',
    "scripts/report.ts": 'console.log("out");\n',
    "tools/run.js": '#!/usr/bin/env node\nconsole.log("out");\n',
    "tools/run.py": "#!/usr/bin/env python3\nprint(1)\n",
    "pkg/__main__.py": "print(1)\n",
    "pkg/cli.py":
      'def main():\n    print(1)\n\n\nif __name__ == "__main__":\n    main()\n',
    "cmd/serve/serve.go":
      'package main\n\nimport "fmt"\n\nfunc serve() { fmt.Println(1) }\n',
    "src/lib.js": 'const mark = "#!";\nconsole.log(mark);\n',
    "pkg/lib.py": "x = 1\n#!/not/a/shebang\nprint(x)\n",
    "src/scripts-util/x.ts": 'console.log("out");\n',
    "lib/main.go":
      'package lib\n\nimport "fmt"\n\nfunc f() { fmt.Println(1) }\n',
    // DV13: a JS module that imports and exports nothing is run (`node
    // li-run.mjs`); one that exports is imported.
    "backend/li-run.mjs":
      'import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n',
    "src/mod.mjs":
      'import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\nexport const x = 1;\n',
    // DV13: the repository's own ruff/bandit suppression covers eval.
    // A suppression on another line, or for the other call, does not count.
    "pkg/ev.py":
      "x = eval(s)  # noqa: S307\ny = eval(t)\nz = eval(u)\n# nosec\nw = exec(v)  # noqa: S307\na = eval(p); b = exec(q)  # noqa: S307\nexec(\n    eval(c)  # noqa\n)\n",
  };
  for (const [path, text] of Object.entries(cliFiles)) {
    mkdirSync(dirname(join(cliRoot, path)), { recursive: true });
    writeFileSync(join(cliRoot, path), text);
  }
  const cliFindings = parseJsonOutput(
    run(installedKit, ["check", "--only", "ast-grep", "--json"], {
      cwd: cliRoot,
      allowedStatuses: [0, 1],
    }),
    "r11 cli",
  ).findings;
  const cliFlagged = cliFindings
    .filter((f) => /-no-(console|print|fmt-println)$/.test(f.ruleId ?? ""))
    .map((f) => f.file.split("/r11-cli/")[1])
    .toSorted();
  assert(
    cliFlagged.join() ===
      "lib/main.go,pkg/lib.py,src/lib.js,src/mod.mjs,src/scripts-util/x.ts",
    `R11 CLI entry files: print/console findings in ${JSON.stringify(cliFlagged)}`,
  );
  const evalLines = cliFindings
    .filter((f) => f.ruleId === "py-no-eval-exec")
    .map((f) => f.line);
  assert(
    evalLines.join() === "2,3,5,6,7",
    `DV13 eval under # noqa: S307: findings at lines ${JSON.stringify(evalLines)}`,
  );
  // R11 row 2 (the operator's decision, 2026-10-04): a formatter runs only
  // where the repository adopted it; Go gets gofmt unless gofumpt is
  // configured; `enabled: true` runs a formatter anyway. Files a formatter
  // would have checked are named in a `scope/not-adopted` note.
  const fmtRoot = join(tempRoot, "r11-fmt");
  const fmtJs = { "a.js": "export const a = 1;\n" };
  const fmtGo = { "go.mod": "module m\n\ngo 1.22\n", "a.go": "package m\n" };
  const fmtCases = {
    "js-none": { ...fmtJs, "package.json": "{}\n" },
    "js-rc": { ...fmtJs, "package.json": "{}\n", ".prettierrc": "{}\n" },
    "js-key": { ...fmtJs, "package.json": '{ "prettier": {} }\n' },
    "js-dep": {
      ...fmtJs,
      "package.json": '{ "devDependencies": { "prettier": "3.9.9" } }\n',
    },
    "js-forced": {
      ...fmtJs,
      "package.json": "{}\n",
      "validate.config.json":
        '{ "tools": { "prettier": { "enabled": true } } }\n',
    },
    "py-lint": {
      "a.py": "a = 1\n",
      "pyproject.toml": "[tool.ruff]\nline-length = 100\n",
    },
    "py-fmt": {
      "a.py": "a = 1\n",
      "pyproject.toml":
        '[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\nquote-style = "double"\n',
    },
    "go-plain": fmtGo,
    "go-fumpt": {
      ...fmtGo,
      ".golangci.yml": 'version: "2"\nformatters:\n  enable:\n    - gofumpt\n',
    },
    // Named but not turned on (Codex review, round 4).
    "go-disabled": {
      ...fmtGo,
      ".golangci.yml": "linters:\n  disable:\n    - gofumpt\n",
    },
    "go-settings": {
      ...fmtGo,
      ".golangci.yml":
        'version: "2"\nformatters:\n  settings:\n    gofumpt:\n      extra-rules: true\n',
    },
    // gofumpt only in a comment inside the array (Codex review, round 5).
    "go-toml-comment": {
      ...fmtGo,
      ".golangci.toml":
        'version = "2"\n[formatters]\nenable = [\n  "gofmt", # "gofumpt" later\n]\n',
    },
    // One document, other TOML layouts (Codex review, round 6).
    "go-toml-inline": {
      ...fmtGo,
      ".golangci.toml":
        'version = "2"\nformatters = { enable = ["gofumpt"] }\n',
    },
    "go-toml-v1-all": {
      ...fmtGo,
      ".golangci.toml": "[linters]\nenable-all = true\n",
    },
    "js-yaml": {
      ...fmtJs,
      "package.yaml": "name: y\nprettier:\n  semi: false\n",
    },
  };
  const formatters = new Set([
    "prettier",
    "ruff-format",
    "gofmt",
    "gofumpt",
    "rustfmt",
  ]);
  const fmtPlans = Object.fromEntries(
    Object.entries(fmtCases).map(([name, files]) => {
      const dir = join(fmtRoot, name);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      const listed = JSON.parse(
        run(installedKit, ["list", "--json"], { cwd: dir }).stdout,
      );
      const tools =
        listed.tasks
          .map((t) => t.tool)
          .filter((tool) => formatters.has(tool))
          .toSorted()
          .join("+") || "-";
      const notes =
        (listed.notes ?? [])
          .filter((n) => n.reason === "not-adopted")
          .map((n) => `note:${n.tool}:${n.files.length}`)
          .join(",") || "no-note";
      return [name, `${tools} ${notes}`];
    }),
  );
  assert(
    JSON.stringify(fmtPlans) ===
      JSON.stringify({
        "js-none": "- note:prettier:1",
        "js-rc": "prettier no-note",
        "js-key": "prettier no-note",
        "js-dep": "prettier no-note",
        "js-forced": "prettier no-note",
        "py-lint": "- note:ruff-format:1",
        "py-fmt": "ruff-format no-note",
        "go-plain": "gofmt no-note",
        "go-fumpt": "gofumpt no-note",
        "go-disabled": "gofmt no-note",
        "go-settings": "gofmt no-note",
        "go-toml-comment": "gofmt no-note",
        "go-toml-inline": "gofumpt no-note",
        "go-toml-v1-all": "gofumpt no-note",
        "js-yaml": "prettier no-note",
      }),
    `R11 formatters only where adopted: ${JSON.stringify(fmtPlans)}`,
  );
  // R11 row 9 (the operator's decision, 2026-10-04): each finding names the
  // config the tool used, since a repository's own gate may use another.
  // ESLint 10 looks up the flat config from each file; tsc names its project.
  // This repository's ESLint runs through a wrapper; tsc is the linked one.
  const cfgRoot = join(tempRoot, "r11-config");
  const cfgFiles = {
    "package.json": '{ "name": "r" }\n',
    "eslint.config.mjs":
      'export default [{ rules: { "no-debugger": "error" } }];\n',
    "src/x.js": "debugger;\n",
    "packages/a/package.json": '{ "name": "a" }\n',
    "packages/a/eslint.config.mjs":
      'export default [{ rules: { "no-debugger": "warn" } }];\n',
    "packages/a/src/y.js": "debugger;\n",
    "tsconfig.json":
      '{ "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true }, "include": ["src/**/*.ts"] }\n',
    "src/t.ts": 'export const n: number = "s";\n',
  };
  for (const [path, text] of Object.entries(cfgFiles)) {
    mkdirSync(dirname(join(cfgRoot, path)), { recursive: true });
    writeFileSync(join(cfgRoot, path), text);
  }
  const eslintJs = join(
    dirname(
      createRequire(join(repoRoot, "package.json")).resolve(
        "eslint/package.json",
      ),
    ),
    "bin",
    "eslint.js",
  );
  mkdirSync(join(cfgRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(cfgRoot, "node_modules", ".bin", "eslint"),
    `#!/bin/sh\nexec "${process.execPath}" "${eslintJs}" "$@"\n`,
    { mode: 0o755 },
  );
  symlinkSync(tscBin, join(cfgRoot, "node_modules", ".bin", "tsc"));
  const cfgAi = join(cfgRoot, "ai.json");
  const cfgRun = parseJsonOutput(
    run(
      installedKit,
      ["check", "--only", "eslint", "tsc", "--json", "--ai-json", cfgAi],
      { cwd: cfgRoot, allowedStatuses: [1] },
    ),
    "r11 config",
  );
  const cfgJson = findingConfigs(
    cfgRun.findings,
    (p) => p.split("/r11-config/")[1],
  );
  const cfgAiFindings = findingConfigs(
    JSON.parse(readFileSync(cfgAi, "utf8")).findings,
    (p) => p,
  );
  const cfgExpected = [
    "eslint packages/a/src/y.js packages/a/eslint.config.mjs",
    "eslint src/x.js eslint.config.mjs",
    "tsc src/t.ts tsconfig.json",
  ];
  assert(
    JSON.stringify(cfgJson) === JSON.stringify(cfgExpected) &&
      JSON.stringify(cfgAiFindings) === JSON.stringify(cfgExpected),
    `R11 finding config: json ${JSON.stringify(cfgJson)} ai ${JSON.stringify(cfgAiFindings)}`,
  );
  // A config the project's own extraArgs choose is the one named (Codex
  // review, round 4).
  const altConfig = join(cfgRoot, "alt.config.mjs");
  writeFileSync(
    altConfig,
    'export default [{ rules: { "no-debugger": "error" } }];\n',
  );
  writeFileSync(
    join(cfgRoot, "validate.config.json"),
    JSON.stringify({
      tools: { eslint: { extraArgs: [`--config=${altConfig}`] } },
    }),
  );
  const cfgArgs = findingConfigs(
    parseJsonOutput(
      run(installedKit, ["check", "--only", "eslint", "--json"], {
        cwd: cfgRoot,
        allowedStatuses: [1],
      }),
      "r11 config args",
    ).findings,
    (p) => p.split("/r11-config/")[1],
  );
  assert(
    JSON.stringify(cfgArgs) ===
      JSON.stringify([
        "eslint packages/a/src/y.js alt.config.mjs",
        "eslint src/x.js alt.config.mjs",
      ]),
    `R11 finding config from extraArgs: ${JSON.stringify(cfgArgs)}`,
  );
  // ESLint's own rule: an explicit --config wins over --no-config-lookup;
  // a later --config-lookup turns the lookup back on (round 5).
  const cfgLabels = (extraArgs) => {
    writeFileSync(
      join(cfgRoot, "validate.config.json"),
      JSON.stringify({ tools: { eslint: { extraArgs } } }),
    );
    return findingConfigs(
      parseJsonOutput(
        run(installedKit, ["check", "--only", "eslint", "--json"], {
          cwd: cfgRoot,
          allowedStatuses: [1],
        }),
        "r11 config flags",
      ).findings,
      (p) => p.split("/r11-config/")[1],
    ).join();
  };
  const cfgFlags = {
    configWins: cfgLabels([`--config=${altConfig}`, "--no-config-lookup"]),
    lookupBack: cfgLabels(["--no-config-lookup", "--config-lookup"]),
  };
  assert(
    cfgFlags.configWins ===
      "eslint packages/a/src/y.js alt.config.mjs,eslint src/x.js alt.config.mjs" &&
      cfgFlags.lookupBack ===
        "eslint packages/a/src/y.js packages/a/eslint.config.mjs,eslint src/x.js eslint.config.mjs",
    `R11 finding config with lookup flags: ${JSON.stringify(cfgFlags)}`,
  );
  // R18: the engine runs the system git or none; with no git on PATH it
  // says so instead of spawning the bare name (which Windows resolves in
  // the project first). And `--quiet` with a warning limit in eslint's or
  // oxlint's extraArgs exits 1 with no finding: a config error, exit 2.
  const r18Root = join(tempRoot, "r18");
  mkdirSync(r18Root);
  writeFileSync(join(r18Root, "a.js"), "export const a = 1;\n");
  writeFileSync(join(r18Root, "eslint.config.mjs"), "export default [];\n");
  const gitMissing = run(process.execPath, [kitEntry, "check", "--changed"], {
    cwd: r18Root,
    env: { PATH: emptyBin },
    allowedStatuses: [2],
  });
  assert(
    /git is not on PATH/.test(gitMissing.stderr),
    `R18 no git: ${gitMissing.stderr.trim()}`,
  );
  const quietRun = (tool, extraArgs) => {
    writeFileSync(
      join(r18Root, "validate.config.json"),
      JSON.stringify({ tools: { [tool]: { extraArgs } } }),
    );
    const result = run(installedKit, ["check", "--only", tool], {
      cwd: r18Root,
      allowedStatuses: [0, 1, 2, 3],
    });
    return `${tool} ${extraArgs.join(" ")}: ${result.status}${result.status === 2 && /--quiet with --(max|deny)-warnings/.test(result.stderr) ? " named" : ""}`;
  };
  const quiet = [
    quietRun("eslint", ["--quiet", "--max-warnings", "0"]),
    quietRun("oxlint", ["--quiet", "--max-warnings=0"]),
    quietRun("oxlint", ["--quiet", "--deny-warnings"]),
    quietRun("oxlint", ["--quiet"]),
    quietRun("oxlint", ["--max-warnings=0"]),
    quietRun("eslint", ["--quiet", "--max-warnings=-1"]),
  ];
  assert(
    quiet.join() ===
      [
        "eslint --quiet --max-warnings 0: 2 named",
        "oxlint --quiet --max-warnings=0: 2 named",
        "oxlint --quiet --deny-warnings: 2 named",
        "oxlint --quiet: 0",
        "oxlint --max-warnings=0: 0",
        "eslint --quiet --max-warnings=-1: 0",
      ].join(),
    `R18 --quiet with a warning limit: ${JSON.stringify(quiet)}`,
  );
  // R3 (the operator's decision, 2026-10-04; RH-Bundler): oversized and
  // minified source files are out of scope by default, each kind named in an
  // info note with the key that brings it back.
  const r3Root = join(tempRoot, "r3");
  const r3Files = {
    "src/main.js": 'console.log("main");\n',
    // Hand-written, 40 KB: ordinary lines.
    "src/long.js": `${Array.from({ length: 1600 }, (_, i) => `export const v${i} = ${i};\n`).join("")}console.log("long");\n`,
    // A one-line bundle.
    "web/app.js": `var a="${"x".repeat(300_000)}";console.log(a);\n`,
    // Over 1 MiB, with ordinary lines.
    "data/table.js": `${Array.from({ length: 48_000 }, (_, i) => `export const t${i} = ${i};\n`).join("")}console.log("table");\n`,
    "vendor/lib.min.js": 'console.log("lib");\n',
    // Not JavaScript: one machine-made line.
    "gen/blob.py": `X = "${"x".repeat(12_000)}"\nprint(X)\n`,
  };
  for (const [path, text] of Object.entries(r3Files)) {
    mkdirSync(dirname(join(r3Root, path)), { recursive: true });
    writeFileSync(join(r3Root, path), text);
  }
  const r3Run = (config) => {
    writeFileSync(join(r3Root, "validate.config.json"), JSON.stringify(config));
    const result = parseJsonOutput(
      run(installedKit, ["check", "--only", "ast-grep", "--json"], {
        cwd: r3Root,
        allowedStatuses: [1],
      }),
      "r3",
    );
    return {
      flagged: [
        ...new Set(
          result.findings
            .filter((f) => f.tool === "ast-grep")
            .map((f) => f.file.split("/r3/")[1]),
        ),
      ]
        .toSorted()
        .join(),
      notes: result.findings
        .filter((f) => f.tool === "scope")
        .map(
          (f) =>
            `${f.ruleId}:${f.severity}:${(f.message.match(/not checked \(([^)]*)\)/) ?? [])[1]}`,
        )
        .toSorted(),
    };
  };
  const r3 = {
    default: r3Run({}),
    noLimit: r3Run({ maxFileBytes: 0 }),
    keepMinified: r3Run({ skipMinified: false }),
  };
  const oversizedNote = "oversized:info:data/table.js";
  // Each file with what gave it away (a hand-written file with one long
  // fixture line can then be told apart: dark-visitor, 2026-10-09).
  const minifiedNote =
    "minified:info:gen/blob.py: line 1 is over 10000 bytes, vendor/lib.min.js: a .min. name, web/app.js: line 1 is over 10000 bytes";
  assert(
    r3.default.flagged === "src/long.js,src/main.js" &&
      r3.default.notes.join() === `${minifiedNote},${oversizedNote}` &&
      r3.noLimit.flagged === "data/table.js,src/long.js,src/main.js" &&
      r3.noLimit.notes.join() === minifiedNote &&
      r3.keepMinified.flagged ===
        "gen/blob.py,src/long.js,src/main.js,vendor/lib.min.js,web/app.js" &&
      r3.keepMinified.notes.join() === oversizedNote,
    `R3 oversized and minified: ${JSON.stringify(r3)}`,
  );
  // R12 (engine-generalisation.md; P07, P08, P17 from the Codex pressure
  // review): a tool whose output changed shape is a crash (exit 4), never
  // zero findings. Each case puts a fake tool in its node_modules/.bin, which
  // the kit finds before any other.
  const r12Root = join(tempRoot, "drift");
  const r12Recorded = join(
    repoRoot,
    "docs",
    "research",
    "lint-toolchain",
    "assets",
    "exit-codes-2026-10-03",
  );
  const r12Case = (name, { bin, version, stdout, code, only, files }) => {
    const dir = join(r12Root, name);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", ".bin", bin),
      `#!/bin/sh\ncase "$1" in --version) echo '${version}'; exit 0;; esac\ncat <<'VK_EOF'\n${stdout}\nVK_EOF\nexit ${code}\n`,
      { mode: 0o755 },
    );
    for (const [path, text] of Object.entries(files ?? { "src/a.ts": fine })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const result = parseJsonOutput(
      run(installedKit, ["check", "--only", only ?? bin, "--json"], {
        cwd: dir,
        allowedStatuses: [0, 1, 3, 4],
      }),
      `drift ${name}`,
    );
    return {
      exit: result.exitCode,
      crashed: result.crashed.map((c) => `${c.id}: ${c.stderr.split("\n")[0]}`),
    };
  };
  const fakeOxlint = (name, stdout, code) =>
    r12Case(name, {
      bin: "oxlint",
      version: "Version: 1.70.0",
      stdout,
      code,
    });
  const fakeSemgrep = (name, stdout, code) =>
    r12Case(name, { bin: "semgrep", version: "1.163.0", stdout, code });
  const r12ApiFiles = {
    "openapi.json": "{}\n",
    "validate.config.json":
      '{ "apiDiff": { "enabled": true, "specs": ["openapi.json"], "baseRef": "HEAD" } }\n',
  };
  const fakeOasdiff = (name, stdout, code) => {
    const dir = join(r12Root, name);
    mkdirSync(dir, { recursive: true });
    for (const [path, text] of Object.entries(r12ApiFiles))
      writeFileSync(join(dir, path), text);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    commitAll(dir);
    return r12Case(name, {
      bin: "oasdiff",
      version: "oasdiff version 1.20.0",
      stdout,
      code,
      files: {},
    });
  };
  const r12Drift = {
    // P07: the findings container is gone or of another type.
    oxlintArray: fakeOxlint("ox-array", "[]", 0),
    oxlintFalse: fakeOxlint("ox-false", "false", 0),
    oxlintString: fakeOxlint("ox-string", '"new-schema"', 0),
    oxlintNull: fakeOxlint("ox-null", '{"diagnostics":null}', 0),
    semgrepNull: fakeSemgrep("sg-null", '{"results":null,"errors":[]}', 0),
    // P08: the exit code says findings, the output holds none.
    oxlintExitOne: fakeOxlint("ox-exit1", '{"diagnostics":[]}', 1),
    // Codex R26: no JSON at all on exit 0; every real clean run prints some.
    oxlintEmpty: fakeOxlint("ox-empty", "", 0),
    // P17: oasdiff prints an object where it prints a list of changes.
    oasdiffObject: fakeOasdiff("oas-object", "{}", 0),
    // Codex R12: a change whose `level` was renamed would read as info.
    oasdiffLevel: fakeOasdiff(
      "oas-level",
      '[{"id":"api-path-removed-without-deprecation","text":"api path removed","renamedLevel":3}]',
      0,
    ),
  };
  // The real tools' clean output, r12Recorded byte-exact, still passes.
  const r12Clean = {
    oxlint: fakeOxlint(
      "ox-clean",
      readFileSync(join(r12Recorded, "oxlint-clean.json"), "utf8").trimEnd(),
      0,
    ),
    semgrep: fakeSemgrep(
      "sg-clean",
      readFileSync(join(r12Recorded, "semgrep-clean.json"), "utf8").trimEnd(),
      0,
    ),
    oasdiff: fakeOasdiff(
      "oas-clean",
      readFileSync(join(r12Recorded, "oasdiff-clean.json"), "utf8").trimEnd(),
      0,
    ),
  };
  // ... and real findings are findings (exit 1), not a crash.
  const realFindings = fakeOxlint(
    "ox-findings",
    readFileSync(join(r12Recorded, "oxlint-findings.json"), "utf8").trimEnd(),
    1,
  );
  for (const [name, got] of Object.entries(r12Drift)) {
    assert(
      got.exit === 4 && got.crashed.length === 1,
      `R12 ${name}: exit ${got.exit}, crashed ${JSON.stringify(got.crashed)}; want exit 4 with one crash`,
    );
  }
  assert(
    realFindings.exit === 1 && realFindings.crashed.length === 0,
    `R12 real oxlint findings: exit ${realFindings.exit} ${JSON.stringify(realFindings.crashed)}`,
  );
  for (const [name, got] of Object.entries(r12Clean)) {
    assert(
      got.exit === 0,
      `R12 real clean ${name} output: exit ${got.exit} ${JSON.stringify(got.crashed)}`,
    );
  }
  // Codex R27: semgrep's modern severities (CRITICAL, HIGH, MEDIUM, LOW)
  // gate like the legacy ones; a severity it does not know is a crash.
  // DV8: the rules sit two folders down, and each id is the YAML's own
  // (semgrep would otherwise report `cfg.sub.critical`).
  let semgrepSeverities = "semgrep not installed: skipped";
  if (hasTool("semgrep", ["--version"])) {
    const dir = join(r12Root, "sg-severity");
    mkdirSync(join(dir, "cfg", "sub"), { recursive: true });
    writeFileSync(join(dir, "a.js"), "critical(1);\nmedium(1);\nlow(1);\n");
    writeFileSync(
      join(dir, "cfg", "sub", "rules.yml"),
      ["CRITICAL", "MEDIUM", "LOW"]
        .map(
          (sev) =>
            `  - id: ${sev.toLowerCase()}\n    languages: [javascript]\n    message: ${sev}\n    severity: ${sev}\n    pattern: ${sev.toLowerCase()}($X)\n`,
        )
        .join("")
        .replace(/^/, "rules:\n"),
    );
    writeFileSync(
      join(dir, "validate.config.json"),
      '{ "tools": { "semgrep": { "configPath": "cfg/sub/rules.yml" } } }\n',
    );
    const result = parseJsonOutput(
      run(installedKit, ["check", "--only", "semgrep", "--json"], {
        cwd: dir,
        allowedStatuses: [0, 1, 3, 4],
      }),
      "semgrep severities",
    );
    const got = result.findings
      .filter((f) => f.tool === "semgrep")
      .map((f) => `${f.ruleId}:${f.severity}`)
      .toSorted();
    assert(
      result.exitCode === 1 &&
        got.join() === "critical:error,low:info,medium:warning",
      `R12 semgrep severities: exit ${result.exitCode} ${JSON.stringify(got)} ${JSON.stringify(result.crashed)}`,
    );
    semgrepSeverities = got.join();
  }
  // A third review of R12: osv lists packages with no vulnerabilities (with
  // --licenses or --all-packages) without the key; that is not a changed
  // format, but null still is.
  const osvFiles = {
    "src/a.ts": fine,
    "package-lock.json": "{}\n",
    "validate.config.json": '{ "vulnAudit": { "enabled": true } }\n',
  };
  const osvNoKey = r12Case("osv-nokey", {
    bin: "osv-scanner",
    version: "osv-scanner version: 2.3.8",
    stdout: osvPackage(""),
    code: 0,
    files: osvFiles,
  });
  const osvNull = r12Case("osv-null", {
    bin: "osv-scanner",
    version: "osv-scanner version: 2.3.8",
    stdout: osvPackage(',"vulnerabilities":null'),
    code: 0,
    files: osvFiles,
  });
  assert(
    osvNoKey.exit === 0 && osvNull.exit === 4,
    `R12 osv packages without vulnerabilities: no key ${osvNoKey.exit} ${JSON.stringify(osvNoKey.crashed)}, null ${osvNull.exit}`,
  );
  // R17: oxlint says "No files found to lint" (every file it was given is
  // ignored by the project's own oxlint config; 1.86 applies ignorePatterns to
  // named files) before its JSON, exit 1. Nothing to lint is not a crash, nor
  // a finding; text in front of anything but that line still is.
  const noFiles = fakeOxlint(
    "ox-no-files",
    'No files found to lint. Please check your paths and ignore patterns.\n{ "diagnostics": [], "number_of_files": 0, "number_of_rules": 133, "threads_count": 16, "start_time": 0.003 }',
    1,
  );
  const otherText = fakeOxlint(
    "ox-other-text",
    'Something else happened.\n{ "diagnostics": [], "number_of_files": 0 }',
    1,
  );
  // R17: an osv advisory without a severity fails the run as a warning (the
  // operator's decision, 2026-10-04), not info below the gate.
  const osvNoSeverity = r12Case("osv-no-severity", {
    bin: "osv-scanner",
    version: "osv-scanner version: 2.3.8",
    stdout: osvPackage(
      ',"vulnerabilities":[{"id":"PYSEC-2026-1","summary":"s","affected":[]}]',
    ),
    code: 1,
    files: osvFiles,
  });
  assert(
    noFiles.exit === 0 &&
      noFiles.crashed.length === 0 &&
      otherText.exit === 4 &&
      osvNoSeverity.exit === 1,
    `R17: no files ${JSON.stringify(noFiles)}, other text ${JSON.stringify(otherText)}, osv without severity ${JSON.stringify(osvNoSeverity)}`,
  );
  const unknownSeverity = fakeSemgrep(
    "sg-unknown",
    '{"results":[{"check_id":"r","path":"src/a.ts","start":{"line":1,"col":1},"end":{"line":1,"col":2},"extra":{"message":"m","severity":"SEVERE"}}],"errors":[]}',
    0,
  );
  assert(
    unknownSeverity.exit === 4,
    `R12 semgrep unknown severity: exit ${unknownSeverity.exit} ${JSON.stringify(unknownSeverity.crashed)}`,
  );
  // A third review of R12: ruff exits 1 after fixing everything when asked
  // to (--exit-non-zero-on-fix, common in commit hooks), which is not a
  // crash; and a project's `fix-only` must neither hide findings nor let the
  // check rewrite files.
  let ruffFixes = "ruff not installed: skipped";
  if (hasTool("ruff", ["--version"])) {
    const fixDir = join(r12Root, "ruff-fix");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "a.py"), "import os\nimport sys\n");
    writeFileSync(
      join(fixDir, "validate.config.json"),
      '{ "tools": { "ruff": { "extraArgs": ["--exit-non-zero-on-fix"] } } }\n',
    );
    const fixed = parseJsonOutput(
      run(installedKit, ["check", "--only", "ruff", "--fix", "--json"], {
        cwd: fixDir,
        allowedStatuses: [0, 1, 3, 4],
      }),
      "ruff exit-non-zero-on-fix",
    );
    const onlyDir = join(r12Root, "ruff-fix-only");
    mkdirSync(onlyDir, { recursive: true });
    const onlySource = "import os\nprint(undefined_name)\n";
    writeFileSync(join(onlyDir, "a.py"), onlySource);
    writeFileSync(
      join(onlyDir, "pyproject.toml"),
      "[tool.ruff]\nfix-only = true\n",
    );
    const checked = parseJsonOutput(
      run(installedKit, ["check", "--only", "ruff", "--json"], {
        cwd: onlyDir,
        allowedStatuses: [0, 1, 3, 4],
      }),
      "ruff fix-only",
    );
    assert(
      fixed.exitCode === 0 &&
        readFileSync(join(fixDir, "a.py"), "utf8") === "" &&
        checked.exitCode === 1 &&
        checked.findings.some((f) => f.ruleId === "F821") &&
        readFileSync(join(onlyDir, "a.py"), "utf8") === onlySource,
      `R12 ruff: --exit-non-zero-on-fix exit ${fixed.exitCode} ${JSON.stringify(fixed.crashed)}, file ${JSON.stringify(readFileSync(join(fixDir, "a.py"), "utf8"))}; fix-only exit ${checked.exitCode} ${JSON.stringify(checked.findings.map((f) => f.ruleId))} ${JSON.stringify(checked.crashed)}, file kept ${readFileSync(join(onlyDir, "a.py"), "utf8") === onlySource}`,
    );
    ruffFixes =
      "a fix run exits 0; fix-only neither hides F821 nor rewrites the file";
  }
  // P17: the real oasdiff, the base spec read by the kit's git, not one a
  // project ships in node_modules/.bin, which `pnpm run` puts first on PATH;
  // and no temp directory left behind.
  let apiGate = "oasdiff not installed: skipped";
  if (hasTool("oasdiff", ["--version"])) {
    const dir = join(r12Root, "oas-real");
    const tmp = join(r12Root, "oas-real-tmp");
    const fakeGitDir = join(dir, "node_modules", ".bin");
    mkdirSync(fakeGitDir, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    // Over 1 MiB, past execFileSync's default output buffer.
    const description = "x".repeat(1_200_000);
    const [withItems, withoutItems] = [
      { "/items": { get: { responses: { 200: { description: "ok" } } } } },
      {},
    ].map(
      (paths) =>
        `${JSON.stringify({ openapi: "3.0.3", info: { title: "t", version: "1", description }, paths })}\n`,
    );
    writeFileSync(join(dir, "openapi.json"), withItems);
    writeFileSync(
      join(dir, "validate.config.json"),
      r12ApiFiles["validate.config.json"],
    );
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    commitAll(dir);
    writeFileSync(join(dir, "openapi.json"), withoutItems);
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    // A git that answers every read of a committed file with the work tree's
    // copy: the base would equal the head and the removal would vanish.
    writeFileSync(
      join(fakeGitDir, "git"),
      `#!/bin/sh\ncase "$1" in show|cat-file) cat openapi.json; exit 0;; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const apiRun = (env) =>
      parseJsonOutput(
        run(
          installedKit,
          ["check", "--only", "oasdiff", "--profile", "ci", "--json"],
          {
            cwd: dir,
            allowedStatuses: [0, 1, 3, 4],
            env,
          },
        ),
        "oasdiff real",
      );
    const plain = apiRun({ TMPDIR: tmp });
    const faked = apiRun({
      TMPDIR: tmp,
      PATH: `${fakeGitDir}:${process.env.PATH}`,
    });
    const [plainRemoved, fakedRemoved] = [plain, faked].map(
      (result) =>
        result.exitCode === 1 &&
        result.findings.some(
          (f) => f.tool === "oasdiff" && /removed/.test(f.ruleId ?? ""),
        ),
    );
    const left = readdirSync(tmp);
    assert(
      plainRemoved && fakedRemoved && left.length === 0,
      `R12 oasdiff: plain ${plain.exitCode}, fake git ${faked.exitCode} ${JSON.stringify(faked.findings.map((f) => f.ruleId))}, temp left ${JSON.stringify(left)}`,
    );
    apiGate = "removed path found with and without a project git; no temp left";
  }
  // 6: a trusted commit with no config, while the work tree has one.
  writeFileSync(join(namesRoot, "validate.config.ts"), "export default {};\n");
  const noConfigAtRef = namesCheck(["--trusted-ref", "HEAD"], [2]).stderr;
  assert(
    noConfigAtRef.includes("--trusted-ref 'HEAD'") &&
      noConfigAtRef.includes("has no validate config"),
    `a trusted commit without a config is exit 2, not the work tree's: ${noConfigAtRef}`,
  );

  // 19: a git or sh the project supplies (a dependency's bin, first on PATH
  // under `pnpm run`) must not answer for the real ones in a trusted run.
  const fakeBin = join(trustRoot, "node_modules", ".bin");
  mkdirSync(fakeBin, { recursive: true });
  for (const name of ["git", "sh"]) {
    writeFileSync(join(fakeBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const fakePath = { PATH: `${fakeBin}${delimiter}${process.env.PATH}` };

  // 5, 13: a commit that turns its own rule off (and empties policyFiles)
  // passes a plain run and fails under the policy of the commit before it.
  writeFileSync(join(trustRoot, "src", "ok.ts"), consoleLine);
  writeFileSync(
    join(trustRoot, "validate.config.ts"),
    trustConfig("off", ", policyFiles: []"),
  );
  trustGit([
    "commit",
    "--quiet",
    "-m",
    "relax",
    "--",
    "src/ok.ts",
    "validate.config.ts",
  ]);
  const plainRelaxed = trustCheck(["--only", "ast-grep"], [0]);
  const trustedRelaxed = trustCheck(
    ["--only", "ast-grep", "--trusted-ref", "HEAD~1", "--json"],
    [1],
    fakePath,
  );
  assert(
    plainRelaxed.status === 0 &&
      consoleFiles(trustedRelaxed).join() === "src/ok.ts",
    "a patch that relaxes its own config must fail under --trusted-ref",
  );
  // 11, 12: the tools' own settings files, edited, added untracked, deleted.
  writeFileSync(
    join(trustRoot, "tsconfig.json"),
    '{ "compilerOptions": { "strict": false } }\n',
  );
  writeFileSync(join(trustRoot, "src", ".oxlintrc.json"), '{ "rules": {} }\n');
  writeFileSync(
    join(trustRoot, pkg, "tsconfig.json"),
    '{ "compilerOptions": {} }\n',
  );
  rmSync(join(trustRoot, ".prettierrc"));
  writeFileSync(join(trustRoot, "fmt", "style.json"), '{ "semi": false }\n');
  writeFileSync(
    join(trustRoot, pkg, "rules", "no-log.yml"),
    "id: no-log\nlanguage: TypeScript\nseverity: error\nrule: { pattern: console.never($A) }\nmessage: no log\n",
  );
  const policyRun = trustCheck(
    ["--only", "policy", "--trusted-ref", "HEAD~1", "--json"],
    [1],
    fakePath,
  );
  const policyFindings = parseJsonOutput(policyRun, "policy");
  const policyChanged = policyFindings.findings
    .map((f) => `${f.ruleId} ${f.file.slice(trustReal.length + 1)}`)
    .toSorted();
  assert(
    policyChanged.join() ===
      [
        ".prettierrc",
        "fmt/style.json",
        `${pkg}/tsconfig.json`,
        "src/.oxlintrc.json",
        "tsconfig.json",
        "validate.config.ts",
      ]
        .toSorted()
        .map((file) => `changed ${file}`)
        .join(),
    `under --trusted-ref every changed settings file is an error: ${policyChanged.join()}`,
  );
  const trustedHead = trustGit(["rev-parse", "HEAD~1"]).stdout.trim();
  // 16: the report names the commit whose policy judged it.
  assert(
    policyFindings.evidence?.trustedRef === trustedHead,
    `evidence must name the trusted commit: ${JSON.stringify(policyFindings.evidence)}`,
  );
  const plainTools = JSON.parse(
    run(installedKit, ["list", "--json"], { cwd: trustRoot }).stdout,
  ).tasks.map((task) => task.tool);
  assert(
    !plainTools.includes("policy"),
    "without --trusted-ref there is no policy task",
  );
  // 20: a run limited to a language or a layer still checks the policy.
  const narrowed = [
    ["--lang", "ts"],
    ["--layer", "lint"],
  ].map((args) =>
    JSON.parse(
      run(
        installedKit,
        ["list", "--trusted-ref", "HEAD~1", "--json", ...args],
        { cwd: trustRoot },
      ).stdout,
    ).tasks.some((task) => task.tool === "policy"),
  );
  assert(
    narrowed.every(Boolean),
    `--lang and --layer must not drop the policy check: ${narrowed}`,
  );
  // 21, 22: a project below the repository root: its own settings files,
  // its sgconfig's rule files, and the settings files above it that the
  // tools also read (the root tsconfig, prettier config, ignore files); not
  // its siblings' or what only the root project's config names.
  const pkgChanged = parseJsonOutput(
    trustCheck(
      [pkg, "--only", "policy", "--trusted-ref", "HEAD~1", "--json"],
      [1],
      {
        ...fakePath,
        // 27: the runner's own git config must not narrow the comparison.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "diff.relative",
        GIT_CONFIG_VALUE_0: "true",
      },
    ),
    "policy pkg",
  )
    .findings.map((f) => f.file.slice(trustReal.length + 1))
    .toSorted();
  assert(
    pkgChanged.join() ===
      [
        ".prettierrc",
        `${pkg}/rules/no-log.yml`,
        `${pkg}/tsconfig.json`,
        "tsconfig.json",
      ]
        .toSorted()
        .join(),
    `a sub-directory project compares its own and its ancestors' settings files: ${pkgChanged.join()}`,
  );
  rmSync(join(trustRoot, "node_modules"), { recursive: true });
  trustGit([
    "checkout",
    "--quiet",
    "--",
    "tsconfig.json",
    ".prettierrc",
    `${pkg}/tsconfig.json`,
    `${pkg}/rules/no-log.yml`,
    "fmt/style.json",
  ]);
  rmSync(join(trustRoot, "src", ".oxlintrc.json"));
  // 14: one process, plain then trusted then plain: each reads its own config.
  const inProcess = run(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { runCheck } from "validate-kit";
const cwd = ${JSON.stringify(trustRoot)};
const exits = [];
for (const trustedRef of [undefined, "HEAD~1", undefined]) {
  const result = await runCheck({ cwd, onlyTools: ["ast-grep"], ...(trustedRef ? { trustedRef } : {}) });
  exits.push(result.summary.exitCode);
}
console.log(exits.join(","));`,
    ],
    { cwd: consumerRoot },
  ).stdout.trim();
  assert(
    inProcess === "0,1,0",
    `a trusted load must not leak into a later plain run: ${inProcess}`,
  );
  // 6, 15: no commit, no config at the commit, or an option smuggled as a ref.
  const refErrors = [
    ["--trusted-ref", "no-such-ref"],
    ["--trusted-ref=-x"],
    ["--trusted-ref", "HEAD~1", "--config", "other.config.ts"],
  ].map((args) => trustCheck(["--only", "ast-grep", ...args], [2]).stderr);
  assert(
    refErrors[0].includes("no-such-ref") &&
      refErrors[1].includes("may not start with '-'") &&
      refErrors[2].includes("--trusted-ref 'HEAD~1'") &&
      refErrors[2].includes("other.config.ts"),
    `a trusted ref that cannot supply a policy is exit 2 naming it: ${refErrors.join(" / ")}`,
  );

  // 23, 26: patch code that runs during the check (here a format-layer tool
  // of the trusted config running the patch's script) restores a relaxed
  // tsconfig before the policy check could read it; and a settings file
  // named in another case, which a case-insensitive file system serves.
  const orderRoot = join(tempRoot, "order");
  mkdirSync(orderRoot, { recursive: true });
  writeFileSync(
    join(orderRoot, "validate.config.ts"),
    `export default {
  extends: [],
  adapters: [{
    id: "restorer", layer: "format", languages: [], bin: "node",
    supportsFix: false, fixWriteBack: false, minVersion: "0.0.0", installHint: "node",
    buildArgs: () => ({ bin: "node", args: ["restore.mjs"] }),
    parseOutput: (raw) => ({ findings: [], filesProcessed: 1, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr }),
  }],
};\n`,
  );
  writeFileSync(join(orderRoot, "restore.mjs"), "// nothing to restore\n");
  writeFileSync(
    join(orderRoot, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true } }\n',
  );
  writeFileSync(join(orderRoot, ".OXLINTRC.json"), "{}\n");
  writeFileSync(join(orderRoot, ".editorconfig"), "root = true\n");
  commitAll(orderRoot);
  const orderGit = gitIn(orderRoot);
  writeFileSync(
    join(orderRoot, "tsconfig.json"),
    '{ "compilerOptions": { "strict": false } }\n',
  );
  writeFileSync(join(orderRoot, ".OXLINTRC.json"), '{ "rules": {} }\n');
  writeFileSync(
    join(orderRoot, "restore.mjs"),
    // 29: and relaxes a file the policy check already read.
    'import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nwriteFileSync("tsconfig.json", execFileSync("git", ["show", "HEAD~1:tsconfig.json"]));\nwriteFileSync(".editorconfig", "root = true\\nindent_size = 99\\n");\n',
  );
  orderGit([
    "commit",
    "--quiet",
    "-m",
    "relax",
    "--",
    "tsconfig.json",
    ".OXLINTRC.json",
    "restore.mjs",
  ]);
  const orderReal = realpathSync(orderRoot);
  const ordered = parseJsonOutput(
    run(
      installedKit,
      [
        "check",
        "--only",
        "restorer",
        "policy",
        "--trusted-ref",
        "HEAD~1",
        "--concurrency",
        "1",
        "--json",
      ],
      { cwd: orderRoot, allowedStatuses: [1] },
    ),
    "order",
  )
    .findings.map((f) => f.file.slice(orderReal.length + 1))
    .toSorted();
  const expectedOrdered = (
    caseInsensitiveFs
      ? [".OXLINTRC.json", ".editorconfig", "tsconfig.json"]
      : [".editorconfig", "tsconfig.json"]
  ).toSorted();
  assert(
    ordered.join() === expectedOrdered.join(),
    `the policy check must read the tree before and after the other tools (and match settings files in any case where the file system does): ${ordered.join()}`,
  );

  // 9, 10: kitVersion.
  writeFileSync(
    join(trustRoot, "validate.config.ts"),
    `export default { kitVersion: ">=99" };\n`,
  );
  const tooNew = trustCheck(["--only", "ast-grep"], [2]).stderr;
  writeFileSync(
    join(trustRoot, "validate.config.ts"),
    `export default { kitVersion: "banana" };\n`,
  );
  const badRange = trustCheck(["--only", "ast-grep"], [2]).stderr;
  assert(
    tooNew.includes(">=99") &&
      tooNew.includes(kitVersionNow) &&
      badRange.includes("kitVersion: must be a semver range"),
    `kitVersion outside the range, or not a range, is exit 2: ${tooNew} / ${badRange}`,
  );
  trustGit(["checkout", "--quiet", "--", "validate.config.ts"]);

  // 7, 8: a seeded history. c3 cannot be checked (a config error); c6 adds
  // the finding. c3 is the first revision bisect tests (the unique midpoint
  // of c1..c6): without --bisect its exit 2 reads as "bad" and is blamed.
  const bisectRoot = join(tempRoot, "bisect");
  mkdirSync(join(bisectRoot, "src"), { recursive: true });
  writeFileSync(join(bisectRoot, "validate.config.ts"), trustConfig("error"));
  writeFileSync(join(bisectRoot, "src", "a.ts"), "export const a = 0;\n");
  commitAll(bisectRoot);
  const bisectGit = gitIn(bisectRoot);
  const revisions = [bisectGit(["rev-parse", "HEAD"]).stdout.trim()];
  for (let i = 1; i <= 6; i += 1) {
    writeFileSync(
      join(bisectRoot, "validate.config.ts"),
      i === 3
        ? `export default { kitVersion: "banana" };\n`
        : trustConfig("error"),
    );
    writeFileSync(
      join(bisectRoot, "src", "a.ts"),
      i === 6 ? consoleLine : `export const a = ${i};\n`,
    );
    bisectGit([
      "commit",
      "--quiet",
      "-m",
      `c${i}`,
      "--",
      "validate.config.ts",
      "src/a.ts",
    ]);
    revisions.push(bisectGit(["rev-parse", "HEAD"]).stdout.trim());
  }
  const blamed = (extra) => {
    bisectGit(["bisect", "start", revisions[6], revisions[0]]);
    const out = bisectGit([
      "bisect",
      "run",
      installedKit,
      "check",
      "--only",
      "ast-grep",
      "--quiet",
      ...extra,
    ]).stdout;
    bisectGit(["bisect", "reset"]);
    // git 2.55 quotes the term: "is the first 'bad' commit"
    // (docs/research/git/bisect-output.md).
    return /([0-9a-f]{40}) is the first '?bad'? commit/.exec(out)?.[1];
  };
  const withBisect = blamed(["--bisect"]);
  const withoutBisect = blamed([]);
  assert(
    withBisect === revisions[6] && withoutBisect === revisions[3],
    `bisect must land on c6 with --bisect (got ${revisions.indexOf(withBisect)}) and blames c3 without it (got ${revisions.indexOf(withoutBisect)})`,
  );

  // G3.1 (engine-generalisation.md): the baseline. A security-layer tool
  // of the project's own (`leak`, an error while LEAK exists) and a tool
  // that is not installed (`ghost`) sit beside ast-grep.
  const baseRoot = join(tempRoot, "baseline");
  const baseGit = gitIn(baseRoot);
  mkdirSync(join(baseRoot, "src"), { recursive: true });
  writeFileSync(
    join(baseRoot, "validate.config.ts"),
    `import { existsSync } from "node:fs";
const tool = (id, bin, layer) => ({
  id, layer, languages: [], bin, supportsFix: false, fixWriteBack: false,
  minVersion: "0.0.0", installHint: id,
  buildArgs: () => ({ bin: "node", args: ["-e", ""] }),
  parseOutput: (raw, ctx) => ({
    findings: existsSync(ctx.cwd + "/LEAK")
      ? [{ tool: id, layer, file: ctx.cwd + "/LEAK", line: 1, col: 1, ruleId: "secret", severity: "error", message: "a secret in the tree", fixable: false }]
      : [],
    filesProcessed: 1, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr,
  }),
});
const flagged = (id, bin, layer, marker) => ({
  ...tool(id, bin, layer),
  parseOutput: (raw, ctx) => ({
    findings: existsSync(ctx.cwd + "/" + marker)
      ? [{ tool: id, layer, file: ctx.cwd + "/" + marker, line: 1, col: 1, ruleId: "bad", severity: "error", message: "flagged", fixable: false }]
      : [],
    filesProcessed: 1, fixesApplied: 0, rawExitCode: raw.exitCode, stderr: raw.stderr,
  }),
});
export default {
  severityOverrides: [{ tool: "ast-grep", ruleId: "ts-no-console", severity: "error" }],
  adapters: [
    tool("leak", "node", "security"),
    tool("ghost", "definitely-not-installed-xyz", "lint"),
    flagged("lint2", "node", "lint", "BAD"),
  ],
  // Evidence anchors a failure at that file, not the root: only the
  // layer rule keeps it from being debt.
  invariants: [{ id: "TESTS", statement: "the tests pass", check: "test ! -e FAILTEST", evidence: ["src/a.ts"] }],
};
`,
  );
  const twoLogs = "console.log(1);\nconsole.log(2);\n";
  writeFileSync(join(baseRoot, "src", "a.ts"), twoLogs);
  writeFileSync(join(baseRoot, "LEAK"), "token\n");
  commitAll(baseRoot);
  const baselinePath = join(baseRoot, "validate.baseline.json");
  const tools = ["--only", "ast-grep", "leak"];
  const baseCheck = (args = []) =>
    run(installedKit, ["check", ...tools, ...args], {
      cwd: baseRoot,
      allowedStatuses: [0, 1, 2, 3],
    });
  const baselineCmd = (args = []) =>
    run(installedKit, ["baseline", ...tools, ...args], {
      cwd: baseRoot,
      allowedStatuses: [0, 1, 2, 3, 4],
    });
  const sequence = {};
  sequence.before = baseCheck().status;
  // 6: a security error is not accepted without --include-security.
  baselineCmd();
  sequence.securityNotAccepted = baseCheck().status;
  rmSync(baselinePath);
  sequence.write = baselineCmd(["--include-security"]).status;
  sequence.after = baseCheck().status;
  const printed = baseCheck().stdout;
  sequence.securityStillPrinted =
    printed.includes("a secret in the tree") && printed.includes("[baselined]");
  // Reports tell baselined from new.
  const sarifPath = join(tempRoot, "baseline.sarif");
  const aiPath = join(tempRoot, "baseline.ai.json");
  baseCheck(["--sarif", sarifPath, "--ai-json", aiPath]);
  const sarifResults = JSON.parse(readFileSync(sarifPath, "utf8")).runs.flatMap(
    (r) => r.results,
  );
  const aiReport = JSON.parse(readFileSync(aiPath, "utf8"));
  sequence.reportsMarkDebt =
    sarifResults.length > 0 &&
    sarifResults.every(
      (r) =>
        r.baselineState === "unchanged" &&
        r.suppressions?.length === 1 &&
        r.suppressions[0].kind === "external",
    ) &&
    aiReport.newFindings === 0 &&
    aiReport.findings.every((f) => f.classification === "baselined");
  // `--ai-json -` is all stdout carries, so an agent can parse it; with
  // --json as well, both would write there, and the error is a JSON envelope.
  sequence.aiJsonStdoutAlone =
    aiReport.findings.length > 0 &&
    fingerprints(
      parseJsonOutput(baseCheck(["--ai-json", "-"]), "--ai-json -"),
    ) === fingerprints(aiReport);
  const aiBesideJson = baseCheck(["--json", "--ai-json", "-"]);
  sequence.aiJsonBesideJson = `${aiBesideJson.status}:${
    parseJsonOutput(aiBesideJson, "--json --ai-json -").error?.kind
  }`;
  // A run that stops before its report still answers in JSON.
  sequence.aiJsonErrorEnvelope = parseJsonOutput(
    baseCheck(["--ai-json", "-", "--profile", "no-such-profile"]),
    "--ai-json - with a bad profile",
  ).exitCode;
  // 13: a changed-file profile cannot write a baseline (it would drop the
  // files it did not look at).
  sequence.devProfileRefused = run(
    installedKit,
    ["baseline", ...tools, "--profile", "dev"],
    { cwd: baseRoot, allowedStatuses: [2] },
  ).status;
  // 11: a failing gate (one verdict however much fails) is never debt.
  writeFileSync(join(baseRoot, "FAILTEST"), "x\n");
  const gateBaseline = run(installedKit, ["baseline", ...tools, "inv:TESTS"], {
    cwd: baseRoot,
    allowedStatuses: [0],
  });
  sequence.gateNotDebt =
    gateBaseline.stdout.includes("cannot be debt") &&
    run(installedKit, ["check", ...tools, "inv:TESTS"], {
      cwd: baseRoot,
      allowedStatuses: [0, 1],
    }).status === 1;
  rmSync(join(baseRoot, "FAILTEST"));
  // 8: a run that could not see everything writes nothing.
  const written = readFileSync(baselinePath, "utf8");
  const incompleteRun = run(
    installedKit,
    ["baseline", "--only", "ast-grep", "ghost"],
    { cwd: baseRoot, allowedStatuses: [3] },
  );
  sequence.incomplete = incompleteRun.status;
  sequence.incompleteWroteNothing =
    readFileSync(baselinePath, "utf8") === written;
  // It says why, as `check --quiet` does: here the tool is not installed.
  sequence.incompleteSaysWhy = incompleteRun.stderr.includes(
    "ghost: not found; install:",
  );
  // 1: moved code.
  writeFileSync(join(baseRoot, "src", "a.ts"), `\n\n// moved\n${twoLogs}`);
  sequence.shifted = baseCheck().status;
  // 2: a third one hides behind nothing.
  writeFileSync(join(baseRoot, "src", "a.ts"), `${twoLogs}console.log(3);\n`);
  sequence.third = baseCheck().status;
  // 3: fixed debt: fine by default, stale under ci, lowered by `baseline`.
  writeFileSync(join(baseRoot, "src", "a.ts"), "console.log(1);\n");
  sequence.fixedDefault = baseCheck().status;
  const staleRun = baseCheck(["--profile", "ci", "--json"]);
  sequence.fixedCi = staleRun.status;
  const staleJson = parseJsonOutput(staleRun, "stale");
  sequence.staleReported =
    staleJson.findings.some(
      (f) => f.tool === "baseline" && f.ruleId === "stale",
    ) && staleJson.ranTools.includes("baseline");
  sequence.lowered = baselineCmd().status;
  sequence.loweredCount = JSON.parse(readFileSync(baselinePath, "utf8")).counts[
    "src/a.ts"
  ]["ast-grep/ts-no-console"];
  sequence.ciAfterLowering = baseCheck(["--profile", "ci"]).status;
  // 4: updating never swallows a new violation.
  writeFileSync(join(baseRoot, "src", "b.ts"), "console.log(9);\n");
  const beforeGrowth = readFileSync(baselinePath, "utf8");
  const growth = baselineCmd();
  sequence.growthRefused =
    growth.status === 1 &&
    growth.stderr.includes("src/b.ts ast-grep/ts-no-console") &&
    readFileSync(baselinePath, "utf8") === beforeGrowth;
  rmSync(join(baseRoot, "src", "b.ts"));
  // 5: after an upgrade (the recorded kit version differs), a rule the
  // baseline never saw is adopted; an old rule's growth is still refused.
  const recorded = JSON.parse(readFileSync(baselinePath, "utf8"));
  // An old rule the project was clean on is known (every active ast-grep
  // rule is recorded): not adopted, even after an upgrade.
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ ...recorded, kitVersion: "0.0.0" }, null, 2)}\n`,
  );
  writeFileSync(
    join(baseRoot, "src", "a.ts"),
    "console.log(1);\nexport const loose = (x: number) => x == 1;\n",
  );
  const knownOld = baselineCmd(["--adopt-new-rules"]);
  sequence.knownRuleRefused =
    knownOld.status === 1 && knownOld.stderr.includes("ts-no-loose-equality");
  // A rule the baseline did not know (removed from its list, as if written
  // before the rule existed).
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        ...recorded,
        kitVersion: "0.0.0",
        rules: recorded.rules.filter(
          (rule) => rule !== "ast-grep/ts-no-loose-equality",
        ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(baseRoot, "src", "a.ts"),
    "console.log(1);\nconsole.log(2);\nexport const loose = (x: number) => x == 1;\n",
  );
  const mixed = baselineCmd(["--adopt-new-rules"]);
  sequence.oldRuleGrowthRefused =
    mixed.status === 1 &&
    mixed.stderr.includes("ast-grep/ts-no-console") &&
    !mixed.stderr.includes("ts-no-loose-equality");
  writeFileSync(
    join(baseRoot, "src", "a.ts"),
    "console.log(1);\nexport const loose = (x: number) => x == 1;\n",
  );
  sequence.newRuleAdopted = baselineCmd(["--adopt-new-rules"]).status;
  sequence.afterAdoption = baseCheck().status;
  // A partial update keeps the other tools' recorded versions, and without
  // an upgrade nothing is adopted.
  const withLint2 = ["--only", "ast-grep", "leak", "lint2"];
  run(installedKit, ["baseline", ...withLint2], { cwd: baseRoot });
  baselineCmd();
  sequence.partialKeepsVersions =
    JSON.parse(readFileSync(baselinePath, "utf8")).tools.lint2 !== undefined;
  writeFileSync(join(baseRoot, "BAD"), "x\n");
  sequence.noUpgradeRefused = run(
    installedKit,
    ["baseline", ...withLint2, "--adopt-new-rules"],
    { cwd: baseRoot, allowedStatuses: [0, 1] },
  ).status;
  // A tool the baseline never ran (a new adapter, as shellcheck was for the
  // dark-visitor baseline) has only new rules: adopted with no version change.
  const beforeNewTool = readFileSync(baselinePath, "utf8");
  const knownTools = JSON.parse(beforeNewTool);
  delete knownTools.tools.lint2;
  knownTools.rules = knownTools.rules.filter(
    (rule) => !rule.startsWith("lint2/"),
  );
  writeFileSync(baselinePath, `${JSON.stringify(knownTools, null, 2)}\n`);
  sequence.newToolAdopted = run(
    installedKit,
    ["baseline", ...withLint2, "--adopt-new-rules"],
    { cwd: baseRoot, allowedStatuses: [0, 1] },
  ).status;
  // A tool the kit had that did not run when the baseline was written (not
  // installed, not planned, left out with --only) is recorded as "": its
  // later growth is refused like any other (found in review).
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ ...knownTools, tools: { ...knownTools.tools, lint2: "" } }, null, 2)}\n`,
  );
  sequence.knownToolRefused = run(
    installedKit,
    ["baseline", ...withLint2, "--adopt-new-rules"],
    { cwd: baseRoot, allowedStatuses: [0, 1] },
  ).status;
  writeFileSync(baselinePath, beforeNewTool);
  rmSync(join(baseRoot, "BAD"));
  // A tool the kit and the config no longer have (a removed invariant)
  // loses its record and its counts at the next write, and the output says
  // so (dark-visitor: "inv:frontend-biome" stayed forever).
  const withGone = JSON.parse(beforeNewTool);
  withGone.tools["inv:gone"] = "1.0.0";
  withGone.rules = [...withGone.rules, "inv:gone/x"].toSorted();
  (withGone.counts["src/a.ts"] ??= {})["inv:gone/x"] = 1;
  writeFileSync(baselinePath, `${JSON.stringify(withGone, null, 2)}\n`);
  const goneRun = baselineCmd();
  const afterGone = readFileSync(baselinePath, "utf8");
  sequence.goneDropped =
    goneRun.status === 0 &&
    goneRun.stdout.includes(
      "dropped tools the kit and config no longer have: inv:gone",
    ) &&
    !afterGone.includes("inv:gone");
  writeFileSync(baselinePath, beforeNewTool);
  // The file is as prettier would write it.
  // With the kit's own prettier, resolved through its dependencies.
  const kitRequire = createRequire(
    join(
      realpathSync(join(consumerRoot, "node_modules", "validate-kit")),
      "package.json",
    ),
  );
  const prettierPackage = kitRequire.resolve("prettier/package.json");
  const prettierBin = JSON.parse(readFileSync(prettierPackage, "utf8")).bin;
  sequence.prettierStable = run(
    "node",
    [
      join(
        dirname(prettierPackage),
        typeof prettierBin === "string" ? prettierBin : prettierBin.prettier,
      ),
      "--check",
      baselinePath,
    ],
    { cwd: baseRoot, allowedStatuses: [0, 1, 2] },
  ).status;
  // 9: a malformed baseline is exit 2 naming it.
  const good = readFileSync(baselinePath, "utf8");
  writeFileSync(baselinePath, '{ "schemaVersion": 1 }\n');
  const malformed = baseCheck();
  sequence.malformed =
    malformed.status === 2 &&
    malformed.stderr.includes("validate.baseline.json");
  writeFileSync(baselinePath, good);
  // 7: a patch that grows its own baseline is judged by the trusted one.
  baseGit(["add", "--", "validate.baseline.json", "src/a.ts"]);
  baseGit(["commit", "--quiet", "-m", "baseline"]);
  const grown = JSON.parse(good);
  grown.counts["src/a.ts"]["ast-grep/ts-no-console"] += 1;
  writeFileSync(baselinePath, `${JSON.stringify(grown, null, 2)}\n`);
  writeFileSync(
    join(baseRoot, "src", "a.ts"),
    "console.log(1);\nconsole.log(2);\nexport const loose = (x: number) => x == 1;\n",
  );
  baseGit([
    "commit",
    "--quiet",
    "-m",
    "grow",
    "--",
    "validate.baseline.json",
    "src/a.ts",
  ]);
  sequence.patchPlain = baseCheck().status;
  sequence.patchTrusted = baseCheck(["--trusted-ref", "HEAD~1"]).status;
  sequence.policyReportsBaseline = parseJsonOutput(
    run(
      installedKit,
      ["check", "--only", "policy", "--trusted-ref", "HEAD~1", "--json"],
      { cwd: baseRoot, allowedStatuses: [1] },
    ),
    "policy baseline",
  ).findings.some((f) => f.file.endsWith("/validate.baseline.json"));
  const expectedSequence = {
    before: 1,
    securityNotAccepted: 1,
    write: 0,
    after: 0,
    securityStillPrinted: true,
    reportsMarkDebt: true,
    aiJsonStdoutAlone: true,
    aiJsonBesideJson: "2:config",
    aiJsonErrorEnvelope: 2,
    devProfileRefused: 2,
    gateNotDebt: true,
    incomplete: 3,
    incompleteWroteNothing: true,
    incompleteSaysWhy: true,
    shifted: 0,
    third: 1,
    fixedDefault: 0,
    fixedCi: 1,
    staleReported: true,
    lowered: 0,
    loweredCount: 1,
    ciAfterLowering: 0,
    growthRefused: true,
    knownRuleRefused: true,
    oldRuleGrowthRefused: true,
    newRuleAdopted: 0,
    afterAdoption: 0,
    partialKeepsVersions: true,
    noUpgradeRefused: 1,
    newToolAdopted: 0,
    knownToolRefused: 1,
    goneDropped: true,
    prettierStable: 0,
    malformed: true,
    patchPlain: 0,
    patchTrusted: 1,
    policyReportsBaseline: true,
  };
  assert(
    JSON.stringify(sequence) === JSON.stringify(expectedSequence),
    `baseline sequence: ${JSON.stringify(sequence)}`,
  );
  const baselineSequence = true;

  const trust = {
    // What the relaxing commit's own policy and the trusted one report.
    relaxedConfig: {
      plainExit: plainRelaxed.status,
      trustedFindings: consoleFiles(trustedRelaxed),
    },
    policyChanged,
    pkgChanged,
    ordered,
    caseInsensitiveFs,
    inProcess,
    blamed: {
      withBisect: `c${revisions.indexOf(withBisect)}`,
      withoutBisect: `c${revisions.indexOf(withoutBisect)}`,
    },
  };

  const summary = {
    ok: true,
    formal,
    tsProjects: tsCases,
    apiGateWithProjectGit: apiGate,
    semgrepSeverities,
    shellcheckCase,
    golangciCase,
    ruffFixes,
    dv21,
    pf1,
    dv22: dv22Case,
    dv23,
    trust,
    baselineSequence,
    baseline: sequence,
    tempRoot,
    tarball: resolve(tarball),
    init: initResult.status,
    doctor: doctorResult.status,
    check: checkResult.status,
    fix: fixResult.status,
    requiredRuleIds,
    planTasks: JSON.parse(planRuns[0]).tasks.length,
    scaffoldedFilesChecked,
    hookCommandRan: hookResult.status === 1,
    impostorCommand: impostorMcp.command,
    projectLevelPlan: stagedPlan,
    changedFileRuns: {
      afterDelete: afterDelete.filter((tool) => tool.startsWith("inv:")),
      outsideScope: outsideScope.filter((tool) => tool.startsWith("inv:")),
      negatedOnly: excluded.filter((tool) => tool.startsWith("inv:")),
      subdirFindings: subdirFiles,
    },
    invariantExits: {
      holds: holds.status,
      silent: silent.status,
      missingEvidence: gone.status,
      emptyConfig: empty.status,
    },
    doctorGoOn: doctorGoOn.status,
    doctorGoOff: doctorGoOff.status,
    evidence: repoRun.evidence,
    gateExits: {
      pass: gatePass.status,
      fail: gateFail.status,
      silent: gateSilent.status,
      missing: gateMissing.status,
      throwing: isolated.status,
      slow: gateSlow.status,
      runsUnderFix: gateRunsUnderFix,
      optionalMissingDefault: optionalDefault.status,
      optionalMissingCi: optionalCi.status,
      emptyPlanCi: emptyCi.status,
      hangSeconds,
      slowSeconds,
    },
    nonTsLanguages: impostorList.languages,
    cleanedTempRoot: true,
  };

  rmSync(tempRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(
    `external package smoke failed; tempRoot preserved at ${tempRoot}`,
  );
  throw error;
}

/** An osv-scanner result with one package; `extra` adds to the package. */
function osvPackage(extra) {
  return `{"results":[{"source":{"path":"package-lock.json","type":"lockfile"},"packages":[{"package":{"name":"left-pad","version":"1.3.0","ecosystem":"npm"},"groups":[]${extra}}]}]}`;
}

/** Whether a run reported the relaxed .oxlintrc.json as a policy change. */
function policyFound(result) {
  return (result.findings ?? []).some(
    (f) => f.tool === "policy" && f.file.endsWith("/.oxlintrc.json"),
  );
}

/**
 * A JSON-RPC session with `validate-kit mcp` over stdio (one JSON message per
 * line), as an MCP client speaks it. `call` returns the tool's parsed text
 * and whether it is an error; every request fails after 60 s.
 */
async function mcpSession(cwd, bin) {
  const child = spawn(bin, ["mcp"], {
    cwd,
    env: { ...process.env, CI: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolveReply, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`mcp ${method} got no reply in 60 s`)),
        60_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveReply(message);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  return {
    call: async (name, args) => {
      const reply = await request("tools/call", { name, arguments: args });
      const text = reply.result?.content?.[0]?.text ?? "";
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { isError: reply.result?.isError === true, data };
    },
    close: () =>
      new Promise((done) => {
        child.on("exit", done);
        child.stdin.end();
      }),
  };
}

/** "tool file config" for the eslint and tsc findings, paths through `rel`. */
function findingConfigs(findings, rel) {
  return findings
    .filter((f) => f.tool === "eslint" || f.tool === "tsc")
    .map((f) => `${f.tool} ${rel(f.file)} ${f.config ? rel(f.config) : "-"}`)
    .toSorted();
}

/** The files ast-grep's ts-no-console fired in, under the r11-archive fixture. */
function archiveConsoleFiles(result) {
  return result.findings
    .filter((f) => f.ruleId === "ts-no-console")
    .map((f) => f.file.split("/r11-archive/")[1])
    .toSorted();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, CI: "1", ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const allowedStatuses = options.allowedStatuses ?? [0];
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed to start: ${result.error.message}`,
    );
  }
  if (!allowedStatuses.includes(result.status ?? 1)) {
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return result;
}

function gatesConfig(gateFailRun) {
  return [
    'import { commandGate, defineConfig } from "validate-kit";',
    "",
    "const throws = {",
    '  id: "throws", layer: "behavior", languages: [], bin: "sh",',
    '  supportsFix: false, fixWriteBack: false, minVersion: "1.0.0",',
    '  installHint: "sh", versionArgs: ["-c", "echo 1.0.0"],',
    '  buildArgs() { throw new Error("adapter blew up"); },',
    '  parseOutput() { return { findings: [], filesProcessed: 0, fixesApplied: 0, rawExitCode: 0, stderr: "" }; },',
    "};",
    "",
    "// Copies its configured options onto the task, as a real adapter would.",
    "const reads = {",
    '  ...commandGate({ id: "reads-options", run: "true" }),',
    '  expand: (seed, env) => [{ ...seed, options: env.config.tools["reads-options"]?.options }],',
    "};",
    "",
    "export default defineConfig({",
    '  extends: "strict",',
    "  adapters: [",
    '    commandGate({ id: "gate-pass", run: "echo 3 passed", expect: "passed" }),',
    `    commandGate({ id: "gate-fail", run: ${JSON.stringify(gateFailRun)}, statement: "the build must succeed" }),`,
    '    commandGate({ id: "gate-silent", run: "true", expect: "passed" }),',
    '    commandGate({ id: "gate-missing", run: "definitely-not-a-command-xyz" }),',
    '    commandGate({ id: "gate-deep", run: "echo deep", tier: "deep" }),',
    '    commandGate({ id: "gate-count", run: "echo run >> .gate-runs; echo counted", tier: "fast" }),',
    '    commandGate({ id: "gate-slow", run: "sleep 31.7; echo late", timeoutMs: 1500 }),',
    '    commandGate({ id: "gate-hang", run: "sleep 31.9; echo late", timeoutMs: 60000 }),',
    "    throws,",
    "    reads,",
    '    { ...commandGate({ id: "opt-missing", run: "true" }), bin: "definitely-missing-bin-xyz", optional: true },',
    "  ],",
    "  tools: {",
    '    "gate-hang": { timeoutMs: 1200 },',
    '    "reads-options": { options: { models: ["Lease.cfg"] } },',
    "  },",
    "});",
    "",
  ].join("\n");
}

function assertNoRegistryFetch(root, names) {
  for (const name of names) {
    assert(
      !registryFetch.test(readFileSync(join(root, name), "utf8")),
      `init scaffolded a registry fetch into ${join(root, name)}`,
    );
    scaffoldedFilesChecked += 1;
  }
}

function scaffoldedHookRun(root) {
  const hook = readFileSync(join(root, "lefthook.yml"), "utf8");
  return /^\s*run: (.+)$/m.exec(hook)?.[1];
}

/**
 * "rule path:line" per finding, sorted, with paths below the fixture copy
 * `dir` (findings carry the resolved temp path).
 */
function findingLines(findings, dir) {
  return findings
    .map((f) => `${f.ruleId} ${f.file.split(`/${dir}/`).pop()}:${f.line}`)
    .toSorted();
}

/** git in `root`, as a fixed committer, failing on an unexpected status. */
function gitIn(root) {
  return (args, allowedStatuses = [0]) =>
    run(
      "git",
      [
        "-c",
        "user.email=smoke@example.invalid",
        "-c",
        "user.name=smoke",
        ...args,
      ],
      { cwd: root, allowedStatuses },
    );
}

/** A git repository at `root` holding everything in it, as one commit. */
function commitAll(root) {
  const git = gitIn(root);
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "base"]);
}

function hasTool(bin, args) {
  return !spawnSync(bin, args, { stdio: "ignore" }).error;
}

/** sha256 over every file's path and bytes, in a stable order. */
function treeHash(root, skip = []) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const path = join(dir, entry.name);
      // git's own files change when the kit reads the revision.
      if (entry.name === ".git" || skip.includes(entry.name)) continue;
      // Directories count too: TLC empties its state directory but leaves it.
      hash.update(`${path.slice(root.length)}\0`);
      if (entry.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A pre-commit hook of the user's own, which leaves a mark when it runs. */
function oldHook(dir) {
  return `#!/bin/sh\necho ran >> ${JSON.stringify(join(dir, "old-hook-ran"))}\n`;
}

/** A function of 16 lines and 235 jscpd tokens, to copy between files. */
function copiedBlock(name) {
  const body = Array.from(
    { length: 12 },
    (_, i) => `  total += values[${i}] * weights[${i}] + offsets[${i}];`,
  ).join("\n");
  return `export function ${name}(values: number[], weights: number[], offsets: number[]): number {\n  let total = 0;\n${body}\n  return total;\n}\n`;
}

/** An AI report's findings, as one comparable string. */
function fingerprints(report) {
  return report.findings
    .map((f) => f.fingerprint)
    .toSorted()
    .join();
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not emit valid JSON: ${error.message}\n${result.stdout}`,
      { cause: error },
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
