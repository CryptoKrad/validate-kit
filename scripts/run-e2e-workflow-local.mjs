#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
  packageJson.packageManager ?? "",
)?.[1];

if (!pnpmVersion) {
  console.error("package.json packageManager must pin pnpm to x.y.z");
  process.exit(1);
}

const reportDir = "apps/web/playwright-report";
const reportIndex = `${reportDir}/index.html`;
const miseTools = ["node@22", `pnpm@${pnpmVersion}`];
const checks = [
  {
    name: "node",
    command: "node",
    args: ["--version"],
    expected: /^v22\./,
  },
  {
    name: "pnpm",
    command: "pnpm",
    args: ["--version"],
    expected: new RegExp(`^${pnpmVersion.replaceAll(".", "\\.")}$`),
  },
];
const steps = [
  {
    name: "Playwright Chromium browser install",
    command: "pnpm",
    args: [
      "--fail-if-no-match",
      "--filter",
      "web",
      "exec",
      "playwright",
      "install",
      "chromium",
    ],
  },
  {
    name: "E2E + visual with report generation",
    command: "pnpm",
    args: ["--fail-if-no-match", "--filter", "web", "run", "e2e"],
  },
];

const results = [];

function miseArgsFor(command, args) {
  return ["exec", ...miseTools, "--", command, ...args];
}

for (const check of checks) {
  const miseArgs = miseArgsFor(check.command, check.args);
  console.log(`[e2e-local] ${check.name} version: mise ${miseArgs.join(" ")}`);
  const result = spawnSync("mise", miseArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (result.error) {
    console.error(
      `[e2e-local] ${check.name} failed to start: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[e2e-local] ${check.name} exited ${result.status}`);
    if (output) console.error(output);
    process.exit(result.status ?? 1);
  }
  if (!check.expected.test(output)) {
    console.error(
      `[e2e-local] ${check.name} version mismatch: expected ${check.expected}, got ${output}`,
    );
    process.exit(1);
  }

  console.log(`[e2e-local] ${check.name}: ${output}`);
}

rmSync(reportDir, { recursive: true, force: true });

for (const step of steps) {
  const startedAt = Date.now();
  const miseArgs = miseArgsFor(step.command, step.args);
  console.log(`[e2e-local] ${step.name}: mise ${miseArgs.join(" ")}`);
  const result = spawnSync("mise", miseArgs, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  const status = result.status ?? 1;

  results.push({ name: step.name, status, durationMs });

  if (result.error) {
    console.error(
      `[e2e-local] ${step.name} failed to start after ${durationMs}ms: ${result.error.message}`,
    );
    process.exitCode = 1;
    break;
  }

  if (status !== 0) {
    console.error(
      `[e2e-local] ${step.name} exited ${status} after ${durationMs}ms`,
    );
    process.exitCode = status;
    break;
  }
}

if (!process.exitCode) {
  if (!existsSync(reportIndex)) {
    console.error(
      `[e2e-local] missing Playwright HTML report artifact: ${reportIndex}`,
    );
    process.exitCode = 1;
    results.push({ name: "Playwright report artifact", status: 1 });
  } else {
    console.log(`[e2e-local] Playwright HTML report artifact: ${reportIndex}`);
    results.push({ name: "Playwright report artifact", status: 0 });
  }
}

const passed = results.filter((result) => result.status === 0).length;
const failed = results.filter((result) => result.status !== 0).length;

console.log(
  `e2e-local: steps=${results.length} passed=${passed} failed=${failed} toolChecks=${checks.length} report=${reportIndex}`,
);
