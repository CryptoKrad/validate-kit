import { readFileSync, writeFileSync } from "node:fs";
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
import { toolAdopted, upTo } from "../detect/adoption.js";
import {
  absPosix,
  finding,
  findingsArray,
  parseFindings,
  scratchOf,
} from "./base.js";
import { detektRuns } from "./detekt.js";

/** One file of `--reporter=json` (c-zig-jvm.md, 7). */
interface KtlintFile {
  file?: unknown;
  errors?: unknown;
}

interface KtlintError {
  line?: unknown;
  column?: unknown;
  message?: unknown;
  rule?: unknown;
}

/** A `ktlint_` setting in an `.editorconfig` at or above `root`. */
function editorconfigNamesKtlint(root: string, top: string): boolean {
  return upTo(root, top).some((dir) => {
    try {
      return /^\s*ktlint_/m.test(
        readFileSync(join(dir, ".editorconfig"), "utf8"),
      );
    } catch {
      return false;
    }
  });
}

interface KtlintTask {
  /**
   * Only whether each file parses (every rule off), for detekt, which
   * passes a file that does not; set where ktlint itself is not chosen.
   */
  parseOnly: boolean;
}

/**
 * ktlint — Kotlin lint and formatting to the Kotlin coding conventions
 * (wildcard imports, spacing, indentation); `--fix` runs its `--format`,
 * which fixes the formatting rules and leaves the rest reported. It runs with
 * no config at all, so only where the project chose it: a `ktlint_` setting
 * in an `.editorconfig`, `tools.ktlint.enabled`, or a step that runs it.
 * Where detekt runs and ktlint is not chosen, it runs with every rule off,
 * reporting only the files that do not parse (detekt passes them). A file
 * that does not parse is an error. Recorded on 1.8.0:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 7.
 */
export const ktlint: ToolAdapter = {
  id: "ktlint",
  layer: "lint",
  languages: ["kotlin"],
  bin: "ktlint",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.8.0",
  installHint: "brew install ktlint",
  parseVersion: (out) => /ktlint version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (!seed.files?.length) return [];
    const chosen =
      env.toolConfig.enabled === true ||
      editorconfigNamesKtlint(seed.cwd, env.projectRoot) ||
      toolAdopted(seed.cwd, env.projectRoot, {
        configs: [],
        step: /(?:^|[\s;&|"'(/])ktlint(?:\s|$)/m,
      });
    if (!chosen && !detektRuns(seed.cwd, env)) return [];
    const task: KtlintTask = { parseOnly: !chosen };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--reporter|--relative|--log-level|-l|--format|-F|--stdin|--patterns-from-stdin|--limit)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets ktlint's report, its files and when it rewrites them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Never no files: ktlint then lints every .kt and .kts under its folder.
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("ktlint needs the task's file list");
    const { parseOnly } = ctx.options as KtlintTask;
    // The fallback .editorconfig: used for a setting no .editorconfig of the
    // project's makes, and a project that sets ktlint_ is not parse-only.
    const off = join(scratchOf(ctx), "parse-only.editorconfig");
    if (parseOnly)
      writeFileSync(off, "[*.{kt,kts}]\nktlint_standard = disabled\n");
    return {
      bin: this.bin,
      // Its log lines go to stdout, before the JSON, unless turned off.
      args: [
        "--relative",
        "--reporter=json",
        "--log-level=none",
        ...(parseOnly ? [`--editorconfig=${off}`] : []),
        ...(ctx.fix && !parseOnly ? ["--format"] : []),
        ...ctx.extraArgs,
        ...files,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items: files } = parseFindings<KtlintFile>("ktlint", raw);
    const findings: Finding[] = [];
    for (const f of files) {
      for (const e of findingsArray<KtlintError>("ktlint", f, "errors")) {
        if (
          typeof f.file !== "string" ||
          typeof e.line !== "number" ||
          typeof e.column !== "number" ||
          typeof e.message !== "string" ||
          typeof e.rule !== "string"
        )
          throw new Error(
            "ktlint reported an error without a file, position, message or rule: its output format may have changed; refusing to report it.",
          );
        findings.push(
          finding({
            tool: "ktlint",
            layer: "lint",
            language: "kotlin",
            file: absPosix(ctx.cwd, f.file),
            line: e.line,
            col: e.column,
            // `Not a valid Kotlin file (3:12 expecting ')')` has no rule.
            ruleId: e.rule || "syntax-error",
            severity: "error",
            message: e.message,
            fixable: false,
          }),
        );
      }
    }
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
