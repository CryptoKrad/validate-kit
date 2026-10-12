#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
  packageJson.packageManager ?? "",
)?.[1];

if (!pnpmVersion) {
  console.error("package.json packageManager must pin pnpm to x.y.z");
  process.exit(1);
}

const securityWorkflowText = readFileSync(
  ".github/workflows/security.yml",
  "utf8",
);
const semgrepVersion = /SEMGREP_VERSION:\s*["']?(\d+\.\d+\.\d+)["']?/.exec(
  securityWorkflowText,
)?.[1];

if (!semgrepVersion) {
  console.error(
    ".github/workflows/security.yml must pin SEMGREP_VERSION to x.y.z",
  );
  process.exit(1);
}

const miseTools = [
  "python@3.12",
  `semgrep@${semgrepVersion}`,
  "node@22",
  `pnpm@${pnpmVersion}`,
];

const toolChecks = [
  {
    name: "python",
    command: "python",
    args: ["--version"],
    expected: /^Python 3\.12\./,
  },
  {
    name: "semgrep",
    command: "semgrep",
    args: ["--version"],
    expected: new RegExp(`^${semgrepVersion.replaceAll(".", "\\.")}\\b`),
  },
  { name: "node", command: "node", args: ["--version"], expected: /^v22\./ },
  {
    name: "pnpm",
    command: "pnpm",
    args: ["--version"],
    expected: new RegExp(`^${pnpmVersion.replaceAll(".", "\\.")}$`),
  },
];

const commandSteps = [
  {
    name: "Semgrep custom rules (gate)",
    command: "semgrep",
    args: [
      "--config",
      "packages/validate-kit/semgrep/custom.yml",
      "--error",
      "--disable-version-check",
      ".",
    ],
  },
  {
    name: "pnpm audit (high+)",
    command: "pnpm",
    args: ["audit", "--audit-level=high"],
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
  console.log(
    `[security-local] ${check.name} version: mise ${miseArgs.join(" ")}`,
  );

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
    console.log(`[security-local] ${check.name}: ${output}`);
  }

  results.push({
    name: check.name,
    status,
    durationMs,
  });

  if (result.error) {
    console.error(
      `[security-local] ${check.name} failed to start after ${durationMs}ms: ${result.error.message}`,
    );
    process.exitCode = 1;
    break;
  }

  if (result.status !== 0) {
    console.error(
      `[security-local] ${check.name} exited ${result.status ?? 1} after ${durationMs}ms`,
    );
    process.exitCode = result.status ?? 1;
    break;
  }

  if (status !== 0) {
    console.error(
      `[security-local] ${check.name} output did not match ${check.expected}: ${output}`,
    );
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  for (const step of commandSteps) {
    const startedAt = Date.now();
    const miseArgs = miseArgsFor(step.command, step.args);
    console.log(`[security-local] ${step.name}: mise ${miseArgs.join(" ")}`);

    const result = spawnSync("mise", miseArgs, {
      cwd: process.cwd(),
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
        `[security-local] ${step.name} failed to start after ${durationMs}ms: ${result.error.message}`,
      );
      process.exitCode = 1;
      break;
    }

    if (status !== 0) {
      console.error(
        `[security-local] ${step.name} exited ${status} after ${durationMs}ms`,
      );
      process.exitCode = status;
      break;
    }
  }
}

const passed = results.filter((result) => result.status === 0).length;
const failed = results.filter((result) => result.status !== 0).length;

console.log(
  `security-local: steps=${results.length} passed=${passed} failed=${failed} toolChecks=${toolChecks.length}`,
);
