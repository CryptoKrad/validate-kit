#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPrefix = "validate-kit-external-smoke-";

const before = listExternalSmokeTempRoots();
const result = spawnSync("pnpm", ["run", "smoke:external-package"], {
  cwd: process.cwd(),
  env: { ...process.env, CI: "1" },
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.error) {
  throw new Error(
    `pnpm run smoke:external-package failed to start: ${result.error.message}`,
  );
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const summary = parseSmokeSummary(result.stdout ?? "");
if (summary.cleanedTempRoot !== true) {
  throw new Error("external smoke did not report cleanedTempRoot true");
}
if (!summary.tempRoot || typeof summary.tempRoot !== "string") {
  throw new Error("external smoke did not report tempRoot");
}
if (existsSync(summary.tempRoot)) {
  throw new Error(`external smoke tempRoot still exists: ${summary.tempRoot}`);
}

const after = listExternalSmokeTempRoots();
if (before.length !== after.length) {
  throw new Error(
    `external smoke temp-dir count changed from ${before.length} to ${after.length}`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tempRoot: summary.tempRoot,
      cleanedTempRoot: summary.cleanedTempRoot,
      tempRootsBefore: before.length,
      tempRootsAfter: after.length,
    },
    null,
    2,
  ),
);

function listExternalSmokeTempRoots() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(tempPrefix))
    .map((entry) => join(tmpdir(), entry.name))
    .toSorted();
}

function parseSmokeSummary(stdout) {
  const match = /\{\s*"ok"\s*:\s*true[\s\S]*\}\s*$/.exec(stdout.trim());
  if (!match) {
    throw new Error(`external smoke did not emit a success JSON summary`);
  }

  try {
    return JSON.parse(match[0]);
  } catch (error) {
    throw new Error(`external smoke success summary was not valid JSON`, {
      cause: error,
    });
  }
}
