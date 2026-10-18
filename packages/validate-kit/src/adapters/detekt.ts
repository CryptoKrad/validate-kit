import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { firstConfig } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { finding, sarifResults, scratchOf } from "./base.js";

/** Where a project keeps its detekt config, which detekt never looks for. */
const CONFIGS = ["detekt.yml", "detekt-config.yml", "config/detekt/detekt.yml"];

interface DetektTask {
  /** The project's config, absolute; none under `tools.detekt.enabled` alone. */
  config?: string;
}

const LEVELS: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  note: "info",
  none: "info",
};

const REPORT = "detekt.sarif";

/**
 * Does detekt run for the Kotlin root `dir`: a detekt config at or above it,
 * or `tools.detekt.enabled` / `configPath`, and not turned off? ktlint asks:
 * detekt passes a file that does not parse, so ktlint checks that where
 * detekt runs.
 */
export function detektRuns(dir: string, env: PlanEnv): boolean {
  const own = {
    ...env.config.tools.detekt,
    ...env.config.languages.kotlin.tools?.detekt,
  };
  return (
    own.enabled !== false &&
    (own.enabled === true ||
      own.configPath !== undefined ||
      firstConfig(dir, env.projectRoot, CONFIGS) !== undefined)
  );
}

/**
 * detekt — Kotlin static analysis: complexity, empty blocks, error-prone
 * and style rules, its defaults with the project's config over them
 * (`--build-upon-default-config`; `--config` alone would replace them).
 * Where a `detekt.yml`, `detekt-config.yml` or `config/detekt/detekt.yml` is
 * at or above the Kotlin root, or `tools.detekt.enabled` / `configPath`.
 * Findings within the config's `build.maxIssues` pass detekt's run, so they
 * are info. detekt 1.23.8 skips a file that does not parse without a word
 * (exit 0, an empty report), so where detekt runs ktlint checks that each
 * file parses (`detektRuns`). No report at all is a crash; a file whose path
 * has a comma cannot be named (detekt splits `--input` at commas). Verify
 * tier: a JVM per run. Recorded on 1.23.8:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 8.
 */
export const detekt: ToolAdapter = {
  id: "detekt",
  layer: "lint",
  languages: ["kotlin"],
  bin: "detekt",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "1.23.8",
  installHint:
    "brew install detekt ktlint  (ktlint checks that each file parses: detekt does not)",
  // 2: findings over the config's limit.
  findingExitCodes: [2],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const config =
      env.toolConfig.configPath ??
      firstConfig(seed.cwd, env.projectRoot, CONFIGS);
    const files = seed.files ?? [];
    if (
      (config === undefined && env.toolConfig.enabled !== true) ||
      files.length === 0
    )
      return [];
    const task: DetektTask = config === undefined ? {} : { config };
    const named = files.filter((file) => !file.includes(","));
    const unnamed = files.filter((file) => file.includes(","));
    return [
      ...(named.length > 0 ? [{ ...seed, files: named, options: task }] : []),
      ...(unnamed.length > 0
        ? [
            {
              ...seed,
              files: unnamed,
              cannotRun: `detekt splits --input at commas, so it cannot be given ${unnamed.join(", ")}`,
            },
          ]
        : []),
    ];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--input|-i|--report|-r|--base-path|-bp|--config|-c|--generate-config|-gc|--create-baseline|-cb)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets detekt's files, its config and its report"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("detekt needs the task's file list");
    const { config } = ctx.options as DetektTask;
    return {
      bin: this.bin,
      args: [
        "--input",
        files.join(","),
        ...(config ? ["--config", config, "--build-upon-default-config"] : []),
        "--report",
        `sarif:${join(scratchOf(ctx), REPORT)}`,
        ...ctx.extraArgs,
      ],
      // 1: a missing input or config path, or a bad flag.
      okExitCodes: [0, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const report = join(scratchOf(ctx), REPORT);
    if (!existsSync(report))
      throw new Error(
        `detekt exited ${raw.exitCode} and wrote no report: ${raw.stderr.trim().split("\n")[0] ?? "it printed nothing"}`,
      );
    const results = sarifResults("detekt", {
      ...raw,
      stdout: readFileSync(report, "utf8"),
    });
    const findings: Finding[] = results.map((r) => {
      const location = r.locations?.[0]?.physicalLocation;
      const uri = location?.artifactLocation?.uri;
      const region = location?.region;
      const level = typeof r.level === "string" ? LEVELS[r.level] : undefined;
      if (
        typeof r.ruleId !== "string" ||
        typeof r.message?.text !== "string" ||
        typeof uri !== "string" ||
        !uri.startsWith("file:") ||
        typeof region?.startLine !== "number" ||
        level === undefined
      )
        throw new Error(
          "detekt's SARIF has a result without a rule, message, file URI, line or known level: its output format may have changed; refusing to report it.",
        );
      return finding({
        tool: "detekt",
        layer: "lint",
        language: "kotlin",
        file: toPosix(fileURLToPath(uri)),
        line: region.startLine,
        col: region.startColumn,
        endLine: region.endLine,
        endCol: region.endColumn,
        // `detekt.empty-blocks.EmptyFunctionBlock`: the console's name.
        ruleId: r.ruleId.split(".").at(-1) ?? r.ruleId,
        // Exit 0: within the config's maxIssues, so detekt's run passed.
        severity: raw.exitCode === 0 ? "info" : level,
        message: r.message.text,
        fixable: false,
      });
    });
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
