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
import { absPosix, finding, parseJsonLine } from "./base.js";
import {
  cargoAdopted,
  cargoEnv,
  cargoPlace,
  type CargoPlace,
  chosenCrates,
  everyMember,
  selectsPackages,
} from "./cargo.js";
import { failureLine } from "./mutation.js";

interface CargoLine {
  reason?: unknown;
  message?: {
    level?: unknown;
    message?: unknown;
    code?: { code?: unknown } | null;
    spans?: {
      file_name?: unknown;
      line_start?: unknown;
      line_end?: unknown;
      column_start?: unknown;
      column_end?: unknown;
      is_primary?: unknown;
    }[];
  };
}

interface HackTask extends CargoPlace {
  /** The members that chose it themselves, by `-p`; else every crate the run covers. */
  packages?: string[];
}

/** `info: running `cargo check ... --features b,c` on hackfix (2/7)` */
const RUNNING = /^info: running `cargo ([^`]*)` on (\S+) \(\d+\/\d+\)$/;

/** What one combination's command line turns on. */
function combination(command: string, crate: string): string {
  const features = /--features (\S+)/.exec(command)?.[1];
  return `${crate} with ${features ? `features ${features}` : command.includes("--no-default-features") ? "no features" : "default features"}`;
}

/**
 * cargo-hack — every combination of a crate's features up to two at a time
 * (`cargo hack check --feature-powerset --depth 2`): code under one feature
 * that uses an item only another feature builds compiles in the default
 * build and fails for a user who turns on that feature alone. Each compile
 * error is an error at its span, naming the combinations it fails in; a
 * combination that fails before compiling (a build script, a dependency)
 * is a crash, since it was not checked. Where the Cargo.toml has
 * `[package.metadata.cargo-hack]` or `[workspace.metadata.cargo-hack]` (the
 * whole workspace), a member's own table (that member), or
 * `tools.cargo-hack.enabled`, the `deep` tier: each combination is a full
 * `cargo check`, which fetches dependencies not yet downloaded. The
 * project's own `--depth` or `--each-feature` replaces the kit's. Recorded
 * on 0.6.45: docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 1.
 */
export const cargoHack: ToolAdapter = {
  id: "cargo-hack",
  layer: "lint",
  languages: ["rust"],
  // A cargo subcommand: called by name it needs cargo's `hack` first.
  bin: "cargo-hack",
  versionArgs: ["hack", "--version"],
  parseVersion: (out) => /cargo-hack (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.6.45",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 900_000,
  installHint:
    "brew install cargo-hack  (or: cargo install --locked cargo-hack)",
  adoptedAt: (root) => cargoAdopted(root, "cargo-hack"),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // Enabled: every crate the run covers.
    const chosen =
      env.toolConfig.enabled === true
        ? []
        : chosenCrates(seed.cwd, "cargo-hack");
    const task: HackTask = {
      ...cargoPlace(seed.cwd),
      ...(chosen !== "all" && chosen.length > 0 ? { packages: chosen } : {}),
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(message-format|keep-going)(=|$)/.test(arg))
      ? "--message-format and --keep-going are the kit's: it reads every combination's JSON"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as HackTask;
    const mode = ctx.extraArgs.some((arg) =>
      /^--(feature-powerset|each-feature)$/.test(arg),
    )
      ? []
      : [
          "--feature-powerset",
          ...(ctx.extraArgs.some((arg) => /^--depth(=|$)/.test(arg))
            ? []
            : ["--depth", "2"]),
        ];
    const select =
      task.packages && !selectsPackages(ctx.extraArgs)
        ? task.packages.flatMap((name) => ["-p", name])
        : everyMember(ctx);
    return {
      bin: this.bin,
      args: [
        "hack",
        "check",
        ...select,
        ...mode,
        // Without it the run stops at the first combination that fails.
        "--keep-going",
        "--message-format=json",
        ...ctx.extraArgs,
      ],
      env: cargoEnv(ctx),
      // 1: any combination failed, or cargo-hack itself did.
      okExitCodes: [0, 1],
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as HackTask;
    // stderr: each combination from its `info: running` line to the next.
    const runs: { combo: string; lines: string[] }[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      const m = RUNNING.exec(line.trim());
      if (m?.[1] && m[2])
        runs.push({ combo: combination(m[1], m[2]), lines: [] });
      else runs.at(-1)?.lines.push(line);
    }
    // A failed combination that did not get as far as compiling was not
    // checked: a build script that panics, a dependency that does not
    // resolve, a flag cargo refuses.
    const unchecked = runs.find(
      (run) =>
        run.lines.some((l) => l.startsWith("error: process didn't exit")) &&
        !run.lines.some((l) => l.startsWith("error: could not compile")),
    );
    if (unchecked)
      throw new Error(
        `cargo-hack: ${unchecked.combo} failed before compiling, so it was not checked: ${unchecked.lines.find((l) => /^error: (?!process didn't exit)/.test(l)) ?? "no error line"}`,
      );
    // stdout holds each combination's JSON, ending in build-finished: the
    // n-th block is the n-th combination.
    const lines = raw.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => parseJsonLine<CargoLine>("cargo-hack", line.trim()));
    const blocks = lines.filter((l) => l.reason === "build-finished").length;
    const paired = blocks === runs.length;
    const errors = new Map<string, { at: Finding; combos: string[] }>();
    let block = 0;
    for (const line of lines) {
      if (line.reason === "build-finished") block += 1;
      const msg = line.message;
      if (line.reason !== "compiler-message" || msg?.level !== "error")
        continue;
      const span = msg.spans?.find((s) => s.is_primary === true);
      // "aborting due to ..." and the --explain note have no span.
      if (
        typeof span?.file_name !== "string" ||
        typeof msg.message !== "string"
      )
        continue;
      const at = finding({
        tool: "cargo-hack",
        layer: "lint",
        language: "rust",
        // rustc names files from the workspace root, whichever member runs.
        file: absPosix(task.workspaceRoot, span.file_name),
        line: Number(span.line_start),
        col: Number(span.column_start),
        endLine: Number(span.line_end),
        endCol: Number(span.column_end),
        ...(typeof msg.code?.code === "string"
          ? { ruleId: msg.code.code }
          : {}),
        severity: "error",
        message: msg.message,
        fixable: false,
      });
      const key = `${at.file}\0${at.line}\0${at.col}\0${at.message}`;
      const seen = errors.get(key) ?? { at, combos: [] };
      const combo = paired ? runs[block]?.combo : undefined;
      if (combo && !seen.combos.includes(combo)) seen.combos.push(combo);
      errors.set(key, seen);
    }
    const findings: Finding[] = [];
    for (const { at, combos: where } of errors.values()) {
      at.message = `${at.message} (fails to build: ${where.length > 0 ? where.join("; ") : "a feature combination cargo-hack lists as failed"}): gate the code on every feature it uses`;
      findings.push(at);
    }
    if (raw.exitCode !== 0 && findings.length === 0)
      throw new Error(
        `cargo-hack failed: ${failureLine(raw, /^error: (?!process didn't exit|failed to run \d+ command)/)}`,
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
