import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding, parseFindings } from "./base.js";

/** One json1 comment (docs/research/lint-toolchain/shellcheck-cli.md). */
interface ShellcheckComment {
  file: string;
  line: number;
  endLine?: number;
  column: number;
  endColumn?: number;
  level: string;
  code: number;
  message: string;
}

/**
 * shellcheck's levels to the kit's. Its `info` holds most quoting checks
 * (SC2086 unquoted expansion, SC2046), real bugs that fail shellcheck's own
 * run, so they gate as warnings; `style` is cosmetic and does not gate.
 */
const LEVELS: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  info: "warning",
  style: "info",
};

/** shellcheck — shell script linter. One process over the task's files. */
export const shellcheck: ToolAdapter = {
  id: "shellcheck",
  layer: "lint",
  languages: ["shell"],
  bin: "shellcheck",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  // The first release with -f json1.
  minVersion: "0.7.0",
  installHint: "brew install shellcheck  (or: apt install shellcheck)",
  parseVersion: (out) => /^version:\s*(\d+\.\d+\.\d+)/m.exec(out)?.[1],

  // Exit 1: findings reported, always with a comment (the filter runs first).
  findingExitCodes: [1],

  refuseArgs(extraArgs) {
    // -a prints each comment once per file it spans, half at wrong columns.
    if (extraArgs.some((arg) => arg === "-a" || arg === "--check-sourced"))
      return "--check-sourced (-a) repeats every comment once per file in shellcheck's JSON, at wrong columns";
    if (extraArgs.some((arg) => /^(-f|--format)(=|$)/.test(arg)))
      return "the kit reads shellcheck's json1 output; --format cannot change it";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Never a directory: shellcheck does not recurse (exit 2 on ".").
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("shellcheck needs the task's file list");
    // Follow `source` the same way in every run: without it a script checked
    // alone (a staged run) reports SC1091 for a file the full run passed as
    // another input, so a narrowed file set changed a file's findings
    // (dark-visitor, 2026-10-09). SCRIPTDIR resolves `. ./lib.sh` from the
    // script's folder; a `source=` directive resolves from the run's.
    const args = [
      "--format=json1",
      "--external-sources",
      "--source-path=SCRIPTDIR",
    ];
    // --rcfile needs shellcheck 0.10.0.
    if (ctx.configPath) args.push("--rcfile", ctx.configPath);
    args.push(...ctx.extraArgs, "--", ...files);
    return {
      bin: this.bin,
      args,
      okExitCodes: [0, 1],
      // Its options go before the command line, and its first -f wins.
      env: { SHELLCHECK_OPTS: "" },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items: comments } = parseFindings<ShellcheckComment>(
      "shellcheck",
      raw,
      "comments",
    );
    const findings = comments.map((c) => {
      const severity = LEVELS[c.level];
      if (
        severity === undefined ||
        typeof c.file !== "string" ||
        typeof c.line !== "number" ||
        typeof c.code !== "number"
      )
        throw new Error(
          `shellcheck output has a comment without a file, line, code or known level (${JSON.stringify(c.level)}): its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "shellcheck",
        layer: "lint",
        language: "shell",
        file: absPosix(ctx.cwd, c.file),
        line: c.line,
        col: c.column,
        ...(c.endLine !== undefined && c.endColumn !== undefined
          ? { endLine: c.endLine, endCol: c.endColumn }
          : {}),
        ruleId: `SC${c.code}`,
        severity,
        message: c.message,
        fixable: false,
        url: `https://www.shellcheck.net/wiki/SC${c.code}`,
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
