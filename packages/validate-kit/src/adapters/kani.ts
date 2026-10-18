import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, findingsArray, finding, scratchOf } from "./base.js";
import { cargoEnv, cargoPlace, type CargoPlace, everyMember } from "./cargo.js";
import { failureLine, formatChanged } from "./mutation.js";

/**
 * A proof harness: `#[kani::proof]`, `#[cfg_attr(kani, kani::proof)]`, or
 * one for a function contract.
 */
const HARNESS = /\bkani::proof(?:_for_contract)?\b/;

interface KaniCheck {
  status?: unknown;
  description?: unknown;
  function?: unknown;
  category?: unknown;
  /** line and column are strings. */
  location?: { file?: unknown; line?: unknown; column?: unknown };
}

interface KaniResult {
  harness_id?: unknown;
  status?: unknown;
  checks?: KaniCheck[];
}

interface KaniReport {
  harness_metadata?: {
    pretty_name?: unknown;
    source?: { file?: unknown; start_line?: unknown };
  }[];
  verification_results?: {
    summary?: { total_harnesses?: unknown; executed?: unknown };
    results?: unknown;
  };
}

function hasHarness(file: string): boolean {
  try {
    return HARNESS.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Kani — bounded model checking of Rust: each `#[kani::proof]` harness is
 * checked for every input it allows (`kani::any()`), so an overflow, a
 * panic or a failed assertion that no test input reaches is found with the
 * input that does. Each failed check is an error where it fails. Where a
 * crate in scope has a harness or `tools.kani.enabled` is true (false turns
 * it off), every member at a workspace root, the `deep` tier: a real proof
 * takes minutes, and the build fetches dependencies not yet downloaded.
 * Kani exits 0 with no harness, and with
 * `-q` even when one fails, so the kit reads its JSON report, never the exit
 * code alone. Recorded on 0.68.0 (CBMC 6.11.0):
 * docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 3.
 */
export const kani: ToolAdapter = {
  id: "kani",
  layer: "formal",
  languages: ["rust"],
  // rustup's cargo runs Kani's own nightly; cargo-kani is found beside it.
  bin: "cargo",
  versionArgs: ["kani", "--version"],
  parseVersion: (out) => /Kani Rust Verifier (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.68.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 1_800_000,
  installHint: "cargo install --locked kani-verifier && cargo kani setup",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = toPosix(seed.cwd);
    const chosen =
      env.toolConfig.enabled === true ||
      env.scopedFiles.some(
        (file) =>
          file.endsWith(".rs") && isUnder(file, root) && hasHarness(file),
      );
    if (!chosen) return [];
    const task: CargoPlace = cargoPlace(seed.cwd);
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(export-json|concrete-playback)(=|$)/.test(arg))
      ? "--export-json is the kit's (it reads the report), and --concrete-playback writes into the source"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "kani",
        "--output-format",
        "terse",
        ...everyMember(ctx),
        ...ctx.extraArgs,
        "-Z",
        "unstable-options",
        "--export-json",
        join(scratchOf(ctx), "kani.json"),
      ],
      env: cargoEnv(ctx),
      // 1: a harness failed, or the crate did not build.
      okExitCodes: [0, 1],
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Kani names files from the workspace root, whichever member runs.
    const cwd = (ctx.options as CargoPlace).workspaceRoot;
    const path = join(scratchOf(ctx), "kani.json");
    // A crate that does not build writes no report.
    if (!existsSync(path))
      throw new Error(
        `kani wrote no report (exit ${raw.exitCode}): ${failureLine(raw, /^error/)}`,
      );
    const report = JSON.parse(readFileSync(path, "utf8")) as KaniReport;
    const results = findingsArray<KaniResult>(
      "kani",
      report.verification_results,
      "results",
    );
    const total = report.verification_results?.summary?.total_harnesses;
    const executed = report.verification_results?.summary?.executed;
    if (typeof total !== "number" || typeof executed !== "number")
      throw formatChanged("kani", "wrote a report without a harness count");
    if (total === 0)
      throw new Error(
        "kani verified no harness: it checked nothing (is the harness under a cfg Kani does not set?)",
      );
    /** Where a harness is: its own source, when a check has no place in the crate. */
    const harnessAt = (id: string) => {
      const source = report.harness_metadata?.find(
        (h) => h.pretty_name === id,
      )?.source;
      return typeof source?.file === "string"
        ? {
            file: absPosix(cwd, source.file),
            line: Number(source.start_line),
            col: 1,
          }
        : { file: absPosix(ctx.cwd, "Cargo.toml"), line: 1, col: 1 };
    };
    const findings: Finding[] = [];
    for (const result of results) {
      if (result.status === "Success") continue;
      const id = String(result.harness_id);
      const failed = (result.checks ?? []).filter(
        (c) => c.status === "Failure",
      );
      for (const check of failed) {
        const loc = check.location;
        const file =
          typeof loc?.file === "string" ? absPosix(cwd, loc.file) : undefined;
        // A check inside the standard library is placed at the harness.
        const place =
          file && isUnder(file, cwd)
            ? { file, line: Number(loc?.line), col: Number(loc?.column) }
            : harnessAt(id);
        findings.push(
          finding({
            tool: "kani",
            layer: "formal",
            language: "rust",
            ...place,
            ruleId:
              typeof check.category === "string" ? check.category : "check",
            severity: "error",
            message: `${String(check.description)}${typeof check.function === "string" ? ` in ${check.function}` : ""}: harness ${id} reaches it for some input`,
            fixable: false,
          }),
        );
      }
      if (failed.length === 0)
        findings.push(
          finding({
            tool: "kani",
            layer: "formal",
            language: "rust",
            ...harnessAt(id),
            ruleId: "harness",
            severity: "error",
            message: `harness ${id} did not verify (${String(result.status)})`,
            fixable: false,
          }),
        );
    }
    if (findings.length === 0 && (executed < total || raw.exitCode !== 0))
      throw new Error(
        `kani verified ${executed} of ${total} harnesses and reported no failure (exit ${raw.exitCode}): ${failureLine(raw, /^error/)}`,
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
