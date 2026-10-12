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

const unitNodeMatrix = ["node@22", "node@24"];
const steps = [
  ...unitNodeMatrix.flatMap((nodeRuntime) => [
    {
      name: `${nodeRuntime} api unit/API tests`,
      nodeRuntime,
      command: "pnpm --fail-if-no-match --filter api run test",
    },
    {
      name: `${nodeRuntime} web unit/component/MSW tests`,
      nodeRuntime,
      command: "pnpm --fail-if-no-match --filter web run test",
    },
  ]),
  {
    name: "node@22 api Docker integration",
    nodeRuntime: "node@22",
    command: "pnpm --fail-if-no-match --filter api run test:integration:docker",
  },
];

const results = [];

for (const step of steps) {
  const startedAt = Date.now();
  const miseArgs = [
    "exec",
    step.nodeRuntime,
    `pnpm@${pnpmVersion}`,
    "--",
    ...step.command.split(" "),
  ];

  console.log(`[test-ts-local] ${step.name}: mise ${miseArgs.join(" ")}`);
  const result = spawnSync("mise", miseArgs, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  const status = result.status ?? 1;

  results.push({
    name: step.name,
    nodeRuntime: step.nodeRuntime,
    status,
    durationMs,
  });

  if (result.error) {
    console.error(
      `[test-ts-local] ${step.name} failed to start after ${durationMs}ms: ${result.error.message}`,
    );
    process.exitCode = 1;
    break;
  }

  if (status !== 0) {
    console.error(
      `[test-ts-local] ${step.name} exited ${status} after ${durationMs}ms`,
    );
    process.exitCode = status;
    break;
  }
}

const passed = results.filter((result) => result.status === 0).length;
const failed = results.filter((result) => result.status !== 0).length;
const node22Steps = results.filter(
  (result) => result.nodeRuntime === "node@22",
);
const node24Steps = results.filter(
  (result) => result.nodeRuntime === "node@24",
);

console.log(
  `test-ts-local: steps=${results.length} passed=${passed} failed=${failed} node22=${node22Steps.length} node24=${node24Steps.length}`,
);
