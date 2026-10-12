import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  clampSeverity,
  filesIn,
  finding,
  parseFindings,
} from "./base.js";

interface RuffIssue {
  code: string | null;
  message: string;
  filename: string;
  location: { row: number; column: number };
  end_location?: { row: number; column: number };
  fix: unknown;
  url?: string | null;
}

/**
 * Ruff category → severity. Error class: real defects and coverage-critical
 * findings — Pyflakes (F4xx-F8xx via ^F\d — NOT FBT/FIX/FURB), syntax
 * (E9xx / null code = SyntaxError), security (bandit S\d), pylint errors
 * (PLE\d). Everything else is style/maintainability → warning.
 */
function ruffSeverity(code: string | null): "error" | "warning" {
  if (!code) return "error";
  if (/^(F\d|E9\d|S\d|PLE\d)/.test(code)) return "error";
  return "warning";
}

/** ruff — Python linter (replaces flake8/isort/pylint). Reads project pyproject/ruff.toml. */
export const ruff: ToolAdapter = {
  id: "ruff",
  layer: "lint",
  languages: ["python"],
  bin: "ruff",
  supportsFix: true,
  fixWriteBack: true,
  minVersion: "0.5.0",
  installHint: "brew install ruff  (or: uv tool install ruff)",
  parseVersion: (out) => /ruff\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],

  // Exit 1: findings reported (recorded on the installed version).
  findingExitCodes: [1],

  buildArgs(ctx: ToolContext): BuiltCommand {
    // --no-cache: a check must not write .ruff_cache into the project.
    // The kit decides whether ruff fixes: a project's `fix = true` would
    // rewrite files in a check, and `fix-only` would hide every finding.
    const args = [
      "check",
      "--output-format=json",
      "--no-cache",
      "--no-fix-only",
    ];
    args.push(ctx.fix ? "--fix" : "--no-fix");
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(...ctx.extraArgs, ...filesIn(ctx, ["python"]));
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items: issues } = parseFindings<RuffIssue>("ruff", raw);
    const findings = issues.map((i) =>
      finding({
        tool: "ruff",
        layer: "lint",
        language: "python",
        file: absPosix(ctx.cwd, i.filename),
        line: i.location.row,
        col: i.location.column,
        ...(i.end_location
          ? { endLine: i.end_location.row, endCol: i.end_location.column }
          : {}),
        ...(i.code ? { ruleId: i.code } : {}),
        severity: clampSeverity(ruffSeverity(i.code)),
        message: i.message,
        fixable: i.fix !== null && i.fix !== undefined,
        ...(i.url ? { url: i.url } : {}),
      }),
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
