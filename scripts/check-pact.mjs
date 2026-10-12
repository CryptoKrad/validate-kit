#!/usr/bin/env node
// Contract freshness: the provider must verify what the consumer expects now,
// and the committed pact must be that expectation.
//
// Ways this gate could fail open, each closed below:
// 1. The provider verifies the committed pact before the consumer regenerates
//    it, so a changed interaction is never verified (test-ts ran api before web).
//    -> regenerate first, then verify the provider against the fresh file.
// 2. Pact's writer merges into an existing file, so an interaction the consumer
//    dropped stays in the pact. -> delete the file before regenerating.
// 3. The consumer test writes nothing (skipped, renamed, wrong dir) and the
//    provider verifies an empty or missing pact. -> require the file and at
//    least one interaction.
// 4. The regenerated pact differs from the committed one and nobody notices.
//    -> compare (parsed JSON) and fail, leaving the fresh file to commit.
// 5. Something earlier in the job (the web tests) already rewrote the pact in
//    the work tree, so the "committed" copy read from disk is the new one
//    (Codex, round 3). -> read the committed pact from git (HEAD).
// Docs: docs/research/verification-continuum/gap-analysis-2026-10-04.md (C).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(label, args) {
  console.log(`check-pact: ${label}`);
  const result = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) fail(`${label} failed (exit ${result.status})`);
}

function fail(message) {
  console.error(`check-pact: ${message}`);
  process.exit(1);
}

const pactPath = "pacts/WebApp-UsersApi.json";
const shown = spawnSync("git", ["show", `HEAD:${pactPath}`], {
  cwd: repoRoot,
  encoding: "utf8",
});
const committed = shown.status === 0 ? JSON.parse(shown.stdout) : undefined;
const pactFile = join(repoRoot, pactPath);
rmSync(pactFile, { force: true });

step("consumer writes the pact", [
  "--filter",
  "web",
  "exec",
  "vitest",
  "run",
  "contract/users.consumer.pact.test.ts",
]);
if (!existsSync(pactFile)) fail(`the consumer test wrote no ${pactFile}`);
const fresh = JSON.parse(readFileSync(pactFile, "utf8"));
const interactions = fresh.interactions?.length ?? 0;
if (interactions === 0) fail("the regenerated pact has no interactions");

step("provider verifies the regenerated pact", [
  "--filter",
  "api",
  "exec",
  "vitest",
  "run",
  "test/contract/users.provider.test.ts",
]);

if (!isDeepStrictEqual(fresh, committed))
  fail(
    `${pactPath} differs from the pact committed at HEAD: the consumer's expectations changed. The regenerated file is in place; review and commit it.`,
  );
console.log(
  `check-pact: ${interactions} interaction(s) regenerated, verified by the provider, and identical to the committed pact`,
);
