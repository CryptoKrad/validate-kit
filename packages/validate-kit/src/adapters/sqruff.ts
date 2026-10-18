import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  byConfigFolder,
  finding,
  findingsArray,
  parseJsonOutput,
} from "./base.js";
import { relativeFiles } from "./schemas-iac.js";

/** One sqruff JSON diagnostic (schemas-iac.md, 2). */
interface SqruffDiagnostic {
  range?: { start?: { line?: unknown; character?: unknown } };
  message?: unknown;
  severity?: unknown;
  code?: unknown;
}

/**
 * sqruff — SQL layout and style (spacing, indentation, capitalisation,
 * aliasing, as the project's `.sqruff` selects them) in the dialect it
 * names, and SQL that does not parse. Only where a `.sqruff` is at or above
 * the file: sqruff reads its config from the working directory only, so it
 * runs from the folder of each file's nearest `.sqruff`, on the task's
 * `.sql` files below it. Never fixed by `--fix`: past the
 * default spacing rule, `sqruff fix` rewrites SQL (`JOIN` to `INNER JOIN`,
 * `UNION` to `UNION DISTINCT`, which not every dialect accepts). Recorded on
 * 0.41.0: docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 2.
 */
export const sqruff: ToolAdapter = {
  id: "sqruff",
  layer: "lint",
  languages: ["sql"],
  bin: "sqruff",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.41.0",
  installHint: "brew install sqruff  (or: cargo install sqruff)",
  parseVersion: (out) => /sqruff (\d+\.\d+\.\d+)/.exec(out)?.[1],
  expand: (seed, env) => byConfigFolder(seed, env, "sql", [".sqruff"]),
  // 1: violations; 101: a panic (a missing path, a bad dialect in .sqruff).
  findingExitCodes: [1],
  // A file that does not parse gets no rule findings.
  masks: (f) => f.ruleId === "parse",

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-f|--format|--stdin-filename)(=|$)/.test(arg))
      ? "the kit reads sqruff's JSON report of the files it passes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = relativeFiles(ctx);
    // No paths and sqruff lints nothing; "-" would read stdin.
    if (files.length === 0)
      throw new Error("sqruff needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "lint",
        "-f",
        "json",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        "--",
        ...files,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const root = parseJsonOutput<unknown>("sqruff", raw, undefined);
    if (root === null || typeof root !== "object" || Array.isArray(root))
      throw new Error(
        "sqruff output is not one object keyed by file: its output format may have changed; refusing to report zero findings.",
      );
    const findings: Finding[] = [];
    for (const [path, value] of Object.entries(root)) {
      for (const d of findingsArray<SqruffDiagnostic>("sqruff", value)) {
        const start = d.range?.start;
        if (
          typeof start?.line !== "number" ||
          typeof start.character !== "number" ||
          typeof d.message !== "string" ||
          (d.code !== null && typeof d.code !== "string") ||
          (d.severity !== "Warning" && d.severity !== "Error")
        )
          throw new Error(
            `sqruff output has a diagnostic without a position, message, code or known severity (${JSON.stringify(d.severity)}): its output format may have changed; refusing to report it.`,
          );
        // A parse error has no rule code.
        const code = typeof d.code === "string" ? d.code : undefined;
        const parse = code === undefined;
        findings.push(
          finding({
            tool: "sqruff",
            layer: "lint",
            language: "sql",
            file: absPosix(ctx.cwd, path),
            line: start.line,
            col: start.character,
            ruleId: code ?? "parse",
            severity: parse || d.severity === "Error" ? "error" : "warning",
            message: parse
              ? `${d.message} (the file does not parse in the dialect .sqruff names)`
              : d.message,
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
