#!/usr/bin/env node
// Windows end-to-end check for R18 (docs/architecture/engine-generalisation.md):
// the engine runs the system git, found through PATHEXT, and never a git the
// project puts in its own folder, which Windows would otherwise run first.
// Runs the built kit (packages/validate-kit/dist) against a temp repository.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    passed: results.length - failed.length,
    failed: failed.length,
  }),
);
process.exit(failed.length === 0 ? 0 : 1);
