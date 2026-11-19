#!/usr/bin/env node
// Windows end-to-end checks, on the built kit (packages/validate-kit/dist):
// - R18 (docs/architecture/engine-generalisation.md): the engine runs the
//   system git, found through PATHEXT, and never a git the project puts in
//   its own folder, which Windows would otherwise run first;
// - doctor prints install lines a Windows machine can run;
// - a project installs the packed kit and runs `init`, and what init wrote
//   works: the MCP entry starts and the pre-commit hook stops a finding.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  console.error("smoke-windows: runs on Windows only");
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kitEntry = join(repoRoot, "packages/validate-kit/bin/validate-kit.mjs");
// The runner's own temp: %TEMP% there is an 8.3 short path (RUNNER~1).
const root = mkdtempSync(
  join(process.env["RUNNER_TEMP"] ?? tmpdir(), "vk-windows-"),
);
const marker = join(root, "project-git-ran.txt");
const results = [];

function run(command, args, env = {}) {
  // Windows keeps one PATH under any spelling (Path, PATH): drop the
  // inherited one when this call sets its own.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !(key.toUpperCase() === "PATH" && "PATH" in env),
    ),
  );
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...inherited, CI: "1", ...env },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
}

try {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "smoke@example.invalid"],
    ["config", "user.name", "smoke"],
  ])
    run("git", args);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  run("git", ["add", "a.js"]);
  run("git", ["commit", "-q", "-m", "base"]);
  // A changed file with an oxlint finding: seen only if git computed the
  // changed-file scope.
  writeFileSync(join(root, "a.js"), "export const a = 1;\ndebugger;\n");
  // The project's own git, untracked: each writes the marker when run.
  for (const name of ["git.bat", "git.cmd"])
    writeFileSync(
      join(root, name),
      `@echo off\r\necho ran> "%~dp0project-git-ran.txt"\r\nexit /b 0\r\n`,
    );

  const changed = run(process.execPath, [
    kitEntry,
    "check",
    "--changed",
    "--only",
    "oxlint",
    "--json",
  ]);
  let findings = [];
  try {
    findings = JSON.parse(changed.stdout).findings ?? [];
  } catch {
    /* reported below */
  }
  check(
    "the system git computes the changed files (a.js has its oxlint finding)",
    changed.status === 1 &&
      findings.some((f) => f.tool === "oxlint" && f.file.endsWith("a.js")),
    `exit ${changed.status}; stderr ${changed.stderr.trim().slice(0, 400)}; stdout ${changed.stdout.slice(0, 400)}`,
  );
  check(
    "the project's git.bat / git.cmd never ran",
    !existsSync(marker),
    "marker written",
  );

  // No git on PATH, only node: the kit says so (exit 2) and does not fall
  // back to the name, which Windows would resolve in the project first.
  const noGit = run(
    process.execPath,
    [kitEntry, "check", "--changed", "--only", "oxlint"],
    { PATH: dirname(process.execPath) },
  );
  check(
    "no git on PATH: exit 2, git is not on PATH",
    noGit.status === 2 && /git is not on PATH/.test(noGit.stderr),
    `exit ${noGit.status}; stderr ${noGit.stderr.trim().slice(0, 400)}`,
  );
  check(
    "no git on PATH: the project's git still never ran",
    !existsSync(marker),
    "marker written",
  );

  // A git.cmd in a PATH entry spelled NODE_MODULES (Windows ignores case) is
  // a project's, not the system git (Codex review, round 3).
  const shadow = join(root, "NODE_MODULES", ".bin");
  mkdirSync(shadow, { recursive: true });
  writeFileSync(
    join(shadow, "git.cmd"),
    `@echo off\r\necho ran> "${marker}"\r\nexit /b 0\r\n`,
  );
  const shadowed = run(
    process.execPath,
    [kitEntry, "check", "--changed", "--only", "oxlint"],
    { PATH: `${shadow};${process.env.PATH ?? process.env.Path ?? ""}` },
  );
  check(
    "a NODE_MODULES PATH entry is not the system git",
    shadowed.status === 1 && !existsSync(marker),
    `exit ${shadowed.status}; marker ${existsSync(marker)}; stderr ${shadowed.stderr.trim().slice(0, 300)}`,
  );

  // The install line doctor prints is one a Windows machine can run: the
  // adapters write Homebrew's, and the registry turns each into Scoop's or
  // the tool's own way (packages/validate-kit/src/core/windows-install.ts).
  const doctor = run(process.execPath, [kitEntry, "doctor", "--json"]);
  let tools = [];
  try {
    tools = JSON.parse(doctor.stdout).tools ?? [];
  } catch {
    /* reported below */
  }
  const notWindows = tools
    .filter((tool) =>
      /\bbrew\b|Homebrew|\bapt install\b/.test(tool.installHint),
    )
    .map((tool) => `${tool.id}: ${tool.installHint}`);
  check(
    "doctor names no Homebrew or apt line on Windows",
    tools.length > 100 && notWindows.length === 0,
    `${tools.length} tools; ${notWindows.slice(0, 5).join(" | ")}; stderr ${doctor.stderr.trim().slice(0, 300)}`,
  );
  const shellcheck = tools.find((tool) => tool.id === "shellcheck");
  check(
    "doctor's line for shellcheck is Scoop's",
    shellcheck?.installHint === "scoop install shellcheck",
    String(shellcheck?.installHint),
  );

  await projectSetup(join(root, "project"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** What a command ended with, for a failed check. */
function said(result) {
  return `exit ${result.status}; stdout ${result.stdout.trim().slice(-500)}; stderr ${result.stderr.trim().slice(-500)}`;
}

/**
 * A project sets itself up as the README says: the packed kit as a dev
 * dependency, `init`, `doctor`. Then what init wrote is used: the MCP entry
 * is started by the MCP SDK's own client, and a commit goes through the hook.
 */
async function projectSetup(project) {
  mkdirSync(project, { recursive: true });
  const at = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: project,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      ...options,
    });
    if (result.error) throw result.error;
    return result;
  };
  // pnpm is pnpm.cmd here, which Node starts only through a shell.
  const pnpm = (args, cwd = project) => at("pnpm", args, { cwd, shell: true });

  const packed = pnpm(
    ["--filter", "validate-kit", "pack", "--pack-destination", root],
    repoRoot,
  );
  const tarball = readdirSync(root).find((name) => name.endsWith(".tgz"));
  check("the kit packs", tarball !== undefined, said(packed));
  if (tarball === undefined) return;

  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "smoke@example.invalid"],
    ["config", "user.name", "smoke"],
  ])
    at("git", args);
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "project", private: true, type: "module" })}\n`,
  );
  writeFileSync(join(project, ".gitignore"), "node_modules\n");
  const added = pnpm([
    "add",
    "-D",
    "--allow-build=@ast-grep/cli",
    join(root, tarball),
    "lefthook",
  ]);
  check("the project installs the packed kit", added.status === 0, said(added));

  const init = pnpm(["exec", "validate-kit", "init"]);
  const written = [
    "lefthook.yml",
    ".mcp.json",
    ".claude/settings.json",
    ".git/hooks/pre-commit",
    ".git/hooks/pre-push",
  ].filter((file) => !existsSync(join(project, file)));
  check(
    "init writes the config, the MCP entry, the Claude Code hooks and the git hooks",
    init.status === 0 &&
      written.length === 0 &&
      readdirSync(project).some((name) => name.startsWith("validate.config.")),
    `missing ${written.join(", ")}; ${said(init)}`,
  );
  check(
    "init finds the project's own kit (no 'not on PATH' warning)",
    !/is not on PATH/.test(init.stderr),
    init.stderr.trim().slice(0, 300),
  );

  const projectDoctor = pnpm(["exec", "validate-kit", "doctor"]);
  check(
    "doctor in the project: every tool it needs is here",
    projectDoctor.status === 0,
    said(projectDoctor),
  );

  // The MCP entry as init wrote it, started as an MCP client starts it.
  let toolNames = [];
  let mcpError = "";
  try {
    const entry = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"))
      .mcpServers["Tester.MCP"];
    const sdk = join(
      repoRoot,
      "packages/validate-kit/node_modules/@modelcontextprotocol/sdk/dist/esm/client",
    );
    const { Client } = await import(pathToFileURL(join(sdk, "index.js")).href);
    const { StdioClientTransport } = await import(
      pathToFileURL(join(sdk, "stdio.js")).href
    );
    const client = new Client({ name: "smoke-windows", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: project,
      }),
    );
    toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();
  } catch (err) {
    mcpError = String(err);
  }
  check(
    "the MCP entry init wrote starts, and lists its tools",
    toolNames.length > 0,
    mcpError,
  );

  // The pre-commit hook: a staged finding stops the commit, a clean file
  // does not.
  writeFileSync(join(project, "bad.js"), "export const a = 1;\ndebugger;\n");
  at("git", ["add", "bad.js"]);
  const refused = at("git", ["commit", "-q", "-m", "a finding"]);
  check(
    "the pre-commit hook stops a commit with a finding",
    refused.status !== 0 && /bad\.js/.test(refused.stdout + refused.stderr),
    said(refused),
  );
  writeFileSync(join(project, "bad.js"), "export const a = 1;\n");
  at("git", ["add", "bad.js"]);
  const passed = at("git", ["commit", "-q", "-m", "clean"]);
  check(
    "the pre-commit hook passes a clean commit",
    passed.status === 0,
    said(passed),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    passed: results.length - failed.length,
    failed: failed.length,
  }),
);
process.exit(failed.length === 0 ? 0 : 1);
