#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  {
    name: "Build validate-kit",
    command: "pnpm --filter validate-kit run build",
  },
  {
    name: "Doctor (every tool the strict gate plans is installed)",
    command: "pnpm exec check doctor --profile ci",
  },
  {
    name: "ast-grep rule snapshot tests",
    command: "pnpm --filter validate-kit exec ast-grep test",
  },
  {
    name: "validate-kit core behavioral tests",
    command: "pnpm --fail-if-no-match --filter validate-kit run test:core",
  },
  {
    name: "External package tarball smoke",
    command: "pnpm run smoke:external-package",
  },
  {
    name: "Validate user-story ledger",
    command: "pnpm run stories:check",
  },
  {
    name: "Validate workflow definitions",
    command: "pnpm run workflow:check",
  },
  {
    name: "OpenAPI contract gate (mirrors validate.yml)",
    command: "pnpm run openapi:check",
  },
  {
    name: "Validate application and package code (hard gate)",
    command: "pnpm run check",
  },
];

const results = [];

for (const step of steps) {
  const startedAt = Date.now();
  console.log(`[validate-local] ${step.name}: ${step.command}`);
  const result = spawnSync(step.command, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    shell: true,
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  const status = result.status ?? 1;

  results.push({
    name: step.name,
    command: step.command,
    status,
    durationMs,
    allowFailure: step.allowFailure === true,
  });

  if (result.error) {
    console.error(
      `[validate-local] ${step.name} failed to start after ${durationMs}ms: ${result.error.message}`,
    );
    process.exitCode = 1;
    break;
  }

  if (status !== 0) {
    const message = `[validate-local] ${step.name} exited ${status} after ${durationMs}ms`;
    if (step.allowFailure) {
      console.error(
        `${message}; continuing because this step is informational`,
      );
      continue;
    }

    console.error(message);
    process.exitCode = status;
    break;
  }
}

const hardFailures = results.filter(
  (result) => result.status !== 0 && !result.allowFailure,
).length;
const informationalFailures = results.filter(
  (result) => result.status !== 0 && result.allowFailure,
).length;
const passed = results.filter((result) => result.status === 0).length;

console.log(
  `validate-local: steps=${results.length} passed=${passed} hardFailures=${hardFailures} informationalFailures=${informationalFailures}`,
);
