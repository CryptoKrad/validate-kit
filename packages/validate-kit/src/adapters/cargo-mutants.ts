import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { findingsArray, scratchOf } from "./base.js";
import {
  failureLine,
  formatChanged,
  type MutationTask,
  MUTATION_TOOL,
  mutantFinding,
  mutationResult,
  planMutation,
  position,
  scopedFile,
} from "./mutation.js";

/** One entry of `mutants.out/outcomes.json`'s `outcomes`. */
interface Outcome {
  /** "Baseline", or { Mutant: ... }. */
  scenario?: unknown;
  summary?: unknown;
}

interface Mutant {
  name?: unknown;
  file?: unknown;
  span?: { start?: unknown; end?: unknown };
}

/**
 * cargo-mutants — mutation testing for Rust: it copies the crate (or
 * workspace) to a temporary folder, replaces function bodies and operators
 * one at a time and runs the tests. A mutant no test fails is a test that
 * passes without checking that behaviour. Where `.cargo/mutants.toml` is (or
 * `tools.cargo-mutants.enabled`), the `deep` tier. Recorded on 27.1.0:
 * docs/research/lint-toolchain/mutation-testing/cargo-mutants-full.md.
 */
export const cargoMutants: ToolAdapter = {
  id: "cargo-mutants",
  layer: "mutation",
  ...MUTATION_TOOL,
  languages: ["rust"],
  bin: "cargo-mutants",
  // A cargo subcommand: called by name it needs cargo's `mutants` first.
  versionArgs: ["mutants", "--version"],
  minVersion: "27.0.0",
  parseVersion: (out) => /cargo-mutants (\d+\.\d+\.\d+)/.exec(out)?.[1],
  rootedAtMarker: true,
  installHint:
    "brew install cargo-mutants  (or: cargo install --locked cargo-mutants)",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [join(".cargo", "mutants.toml")],
      step: /(?:^|[\s;&|"'(/])cargo[ -]mutants(?:\s|$)/m,
    }),
  expand: (seed, env) => planMutation(seed, env, ["rust"]),

  refuseArgs: (extraArgs) =>
    extraArgs.includes("--in-place")
      ? "--in-place mutates the project's own files"
      : extraArgs.some((arg) =>
            /^(-o|--output|--list|--list-files|--json)(=|$)/.test(arg),
          )
        ? "the kit sets where the outcomes go and reads them after a run"
        : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as MutationTask;
    return {
      bin: this.bin,
      args: [
        "mutants",
        "--colors",
        "never",
        "--no-times",
        "--output",
        scratchOf(ctx),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...(task.targets ?? []).flatMap((path) => ["--file", path]),
        ...ctx.extraArgs,
      ],
      // 0 all caught, 2 some missed, 3 some timed out; 4 is a baseline whose
      // tests already fail, said in so many words below.
      okExitCodes: [0, 2, 3, 4],
      // A timeout stops the builds and test runs it started too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 4)
      throw new Error(
        "cargo-mutants: the tests fail before any mutation (exit 4); fix them first",
      );
    const report = join(scratchOf(ctx), "mutants.out", "outcomes.json");
    if (!existsSync(report))
      throw new Error(
        `cargo-mutants wrote no outcomes.json (exit ${raw.exitCode}): ${failureLine(raw, /^Error:/)}`,
      );
    const outcomes = findingsArray<Outcome>(
      "cargo-mutants",
      JSON.parse(readFileSync(report, "utf8")),
      "outcomes",
    );
    const inScope = scopedFile(ctx);
    const findings: Finding[] = [];
    let missed = 0;
    for (const outcome of outcomes) {
      if (outcome.summary !== "MissedMutant") continue;
      missed += 1;
      const mutant = (outcome.scenario as { Mutant?: Mutant } | null)?.Mutant;
      const start = position(mutant?.span?.start);
      if (
        typeof mutant?.file !== "string" ||
        typeof mutant.name !== "string" ||
        !start
      )
        throw formatChanged(
          "cargo-mutants",
          "reported a missed mutant without a file, position or name",
        );
      const file = inScope(mutant.file);
      if (!file) continue;
      const end = position(mutant.span?.end);
      findings.push(
        mutantFinding({
          tool: "cargo-mutants",
          language: "rust",
          file,
          line: start.line,
          col: start.column,
          ...(end ? { endLine: end.line, endCol: end.column } : {}),
          kind: "survived",
          // `src/lib.rs:8:5: replace discount -> f64 with 0.0`
          mutation: mutant.name.replace(/^.*?:\d+:\d+: /, ""),
        }),
      );
    }
    // Exit 2 means a mutant was missed: an outcomes file without one is not
    // the run that exited.
    if (raw.exitCode === 2 && missed === 0)
      throw formatChanged(
        "cargo-mutants",
        "exited 2 (mutants missed) but its outcomes.json has no MissedMutant",
      );
    return mutationResult(raw, ctx, findings);
  },
};
