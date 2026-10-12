#!/usr/bin/env node
// Gate the committed OpenAPI contract spec (apps/api/openapi.json):
//  (a) it must be CURRENT with packages/contracts (re-emit must equal committed),
//      so the published API surface can never silently drift from the Zod source
//      of truth — and every API change shows up as a reviewable spec diff; and
//  (b) when oasdiff + a base spec are available (CI), the change vs the base ref
//      must NOT be BREAKING (cross-commit API safety). Best-effort locally.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPEC = "apps/api/openapi.json";

function emit() {
  return execFileSync("pnpm", ["exec", "tsx", "scripts/emit-openapi.ts"], {
    encoding: "utf8",
  });
}

// (a) baseline-current — hard gate.
const committed = readFileSync(SPEC, "utf8");
const fresh = emit();
if (fresh !== committed) {
  console.error(
    `check-openapi: ${SPEC} is STALE vs packages/contracts — run 'pnpm run openapi:emit' and commit the regenerated spec.`,
  );
  process.exit(1);
}
console.log(
  `check-openapi: ${SPEC} is current with the shared contract schemas.`,
);

// (b) cross-commit breaking gate — runs where oasdiff + a base spec exist.
const hasOasdiff =
  spawnSync("oasdiff", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasOasdiff) {
  // In CI the breaking gate is mandatory: a missing binary (install step
  // refactored away, PATH not persisted via $GITHUB_PATH) must fail loud,
  // never silently delete the gate. Best-effort skip is for local runs only.
  if (process.env.CI) {
    console.error(
      "check-openapi: oasdiff not on PATH in CI — the cross-commit breaking gate cannot run (go install github.com/oasdiff/oasdiff@<pinned>).",
    );
    process.exit(1);
  }
  console.log(
    "check-openapi: oasdiff not on PATH — skipping cross-commit breaking gate (install: brew install oasdiff).",
  );
  process.exit(0);
}

// Distinguish "base ref unavailable" (CI fetch failure — the gate CANNOT run,
// fail loud) from "ref exists but the spec file doesn't" (genuine first
// introduction — the only legitimate skip).
const refExists = (ref) =>
  spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    stdio: "ignore",
  }).status === 0;
// The commit the spec is compared with. CI passes the event's base (the pull
// request's base, or the commit before a push): on a push to main,
// origin/main is the tested commit itself, so nothing would be compared
// (Codex review, round 3). A push that creates the branch has no base
// (all zeros).
const explicitBase = /^0*$/.test(process.env.OPENAPI_BASE_REF ?? "")
  ? undefined
  : process.env.OPENAPI_BASE_REF;
const candidates = explicitBase ? [explicitBase] : ["origin/main", "main"];
const baseRefName = candidates.find(refExists);
if (!baseRefName) {
  if (process.env.CI || explicitBase) {
    console.error(
      `check-openapi: ${explicitBase ?? "origin/main"} is unavailable (base fetch failed?) — cannot run the breaking gate; refusing to pass.`,
    );
    process.exit(1);
  }
  console.log(
    "check-openapi: no origin/main ref locally — skipping breaking gate.",
  );
  process.exit(0);
}
const baseRef = candidates.find(
  (ref) =>
    spawnSync("git", ["cat-file", "-e", `${ref}:${SPEC}`], {
      stdio: "ignore",
    }).status === 0,
);
if (!baseRef) {
  console.log(
    `check-openapi: ${baseRefName} exists but has no ${SPEC} — skipping breaking gate (first introduction of the spec).`,
  );
  process.exit(0);
}

const base = execFileSync("git", ["show", `${baseRef}:${SPEC}`], {
  encoding: "utf8",
});
const tmp = mkdtempSync(join(tmpdir(), "openapi-gate-"));
writeFileSync(join(tmp, "base.json"), base);
writeFileSync(join(tmp, "head.json"), fresh);
// --fail-on ERR: without it oasdiff exits 0 even when it lists breaking
// changes (docs/research/lint-toolchain/exit-codes-and-json-shapes.md), and
// this gate never failed (found 2026-10-04 by a planted removed path).
const result = spawnSync(
  "oasdiff",
  [
    "breaking",
    "--fail-on",
    "ERR",
    join(tmp, "base.json"),
    join(tmp, "head.json"),
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  console.error(
    `check-openapi: BREAKING API change vs ${baseRef}. Make it backward-compatible or version the contract.`,
  );
  process.exit(1);
}
console.log(`check-openapi: no breaking API changes vs ${baseRef}.`);
