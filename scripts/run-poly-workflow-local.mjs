#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
  packageJson.packageManager ?? "",
)?.[1];

if (!pnpmVersion) {
  console.error("package.json packageManager must pin pnpm to x.y.z");
  process.exit(1);
}

const miseTools = [
  "node@22",
  `pnpm@${pnpmVersion}`,
  "rust@stable",
  "go@1.25.11",
  "python@3.12",
  "uv@0.9.30",
  "ruff@0.15.6",
  "golangci-lint@2.12.2",
  "gofumpt@0.10.0",
  "ast-grep@0.45.3",
];

const toolChecks = [
  { name: "node", command: "node", args: ["--version"], expected: /^v22\./ },
  {
    name: "pnpm",
    command: "pnpm",
    args: ["--version"],
    expected: /^10\.23\.0$/,
  },
  {
    name: "rustc",
    command: "rustc",
    args: ["--version"],
    expected: /^rustc\s+/,
  },
  {
    name: "cargo",
    command: "cargo",
    args: ["--version"],
    expected: /^cargo\s+/,
  },
  {
    name: "go",
    command: "go",
    args: ["version"],
    expected: /\bgo1\.25\.11\b/,
  },
  {
    name: "python",
    command: "python",
    args: ["--version"],
    expected: /^Python 3\.12\./,
  },
  {
    name: "uv",
    command: "uv",
    args: ["--version"],
    expected: /^uv 0\.9\.30\b/,
  },
  {
    name: "ruff",
    command: "ruff",
    args: ["--version"],
    expected: /^ruff 0\.15\.6\b/,
  },
  {
    name: "golangci-lint",
    command: "golangci-lint",
    args: ["--version"],
    expected: /\bversion 2\.12\.2\b/,
  },
  {
    name: "gofumpt",
    command: "gofumpt",
    args: ["--version"],
    expected: /^v0\.10\.0\b/,
  },
  {
    name: "ast-grep",
    command: "ast-grep",
    args: ["--version"],
    expected: /^ast-grep 0\.43\.0\b/,
  },
];

const commandSteps = [
  {
    name: "Build validate-kit",
    command: "./node_modules/.bin/tsup",
    args: [],
    cwd: join(process.cwd(), "packages/validate-kit"),
  },
  {
    name: "Polyglot behavioral test",
    command: "pnpm",
    args: [
      "--fail-if-no-match",
      "--filter",
      "validate-kit",
      "run",
      "test:polyglot",
    ],
  },
];

const results = [];

function miseArgsFor(command, args) {
  return ["exec", ...miseTools, "--", command, ...args];
}

function outputOf(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

for (const check of toolChecks) {
  const startedAt = Date.now();
  const miseArgs = miseArgsFor(check.command, check.args);
  console.log(`[poly-local] ${check.name} version: mise ${miseArgs.join(" ")}`);

  const result = spawnSync("mise", miseArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const durationMs = Date.now() - startedAt;
  const output = outputOf(result);
  const status =
    result.error || result.status !== 0 || !check.expected.test(output) ? 1 : 0;

  if (output) {
    console.log(`[poly-local] ${check.name}: ${output}`);
  }

  results.push({
    name: check.name,
    status,
    durationMs,
  });

  if (result.error) {
    console.error(
      `[poly-local] ${check.name} failed to start after ${durationMs}ms: ${result.error.message}`,
    );
    process.exitCode = 1;
    break;
  }

  if (result.status !== 0) {
    console.error(
      `[poly-local] ${check.name} exited ${result.status ?? 1} after ${durationMs}ms`,
    );
    process.exitCode = result.status ?? 1;
    break;
  }

  if (status !== 0) {
    console.error(
      `[poly-local] ${check.name} output did not match ${check.expected}: ${output}`,
    );
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  for (const step of commandSteps) {
    const startedAt = Date.now();
    const miseArgs = miseArgsFor(step.command, step.args);
    console.log(`[poly-local] ${step.name}: mise ${miseArgs.join(" ")}`);

    const result = spawnSync("mise", miseArgs, {
      cwd: step.cwd ?? process.cwd(),
      env: { ...process.env, CI: "1" },
      stdio: "inherit",
    });
    const durationMs = Date.now() - startedAt;
    const status = result.status ?? 1;

    results.push({
      name: step.name,
      status,
      durationMs,
    });

    if (result.error) {
      console.error(
        `[poly-local] ${step.name} failed to start after ${durationMs}ms: ${result.error.message}`,
      );
      process.exitCode = 1;
      break;
    }

    if (status !== 0) {
      console.error(
        `[poly-local] ${step.name} exited ${status} after ${durationMs}ms`,
      );
      process.exitCode = status;
      break;
    }
  }
}

const passed = results.filter((result) => result.status === 0).length;
const failed = results.filter((result) => result.status !== 0).length;

console.log(
  `poly-local: steps=${results.length} passed=${passed} failed=${failed} toolChecks=${toolChecks.length}`,
);
