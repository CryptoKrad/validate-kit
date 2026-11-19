import fc from "fast-check";

// How many cases each property runs, for every test file. fast-check's docs:
// "The recommended way to share settings across runners is to use
// `configureGlobal`", from a Vitest setup file. The preflight sets
// FC_NUM_RUNS for its longer search before a push (scripts/verify-clean.sh);
// without it a property runs fast-check's 100 cases.
const runs = Number(process.env["FC_NUM_RUNS"] ?? "");
if (Number.isInteger(runs) && runs > 0) fc.configureGlobal({ numRuns: runs });
