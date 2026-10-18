import type {
  BuiltCommand,
  Finding,
  Layer,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding, listedFiles, readResult } from "./base.js";

/** `src/syntax.zig:2:15: error: expected expression, found ';'` */
const ERROR = /^(\S.*?):(\d+):(\d+): error: (.+)$/;

/** zig's own error with no place (a missing file, a bad flag): a crash. */
const UNPLACED = /^error: (.+)$/m;

const common = {
  languages: ["zig"],
  bin: "zig",
  optional: true,
  minVersion: "0.17.0",
  installHint: "brew install zig  (or: https://ziglang.org/download/)",
  versionArgs: ["version"],
} as const;

/** The `file:line:col: error:` diagnostics on stderr; notes and excerpts skipped. */
function errors(
  tool: string,
  layer: Layer,
  severity: Severity,
  raw: RawOutput,
  cwd: string,
  message: (text: string) => string = (text) => text,
): Finding[] {
  const crash = UNPLACED.exec(raw.stderr)?.[1];
  if (crash) throw new Error(`${tool} failed: ${crash}`);
  return raw.stderr.split(/\r?\n/).flatMap((line) => {
    const m = ERROR.exec(line);
    if (!m?.[1] || !m[2] || !m[3] || !m[4]) return [];
    return [
      finding({
        tool,
        layer,
        language: "zig",
        file: absPosix(cwd, m[1]),
        line: Number(m[2]),
        col: Number(m[3]),
        ruleId: layer === "format" ? "syntax-error" : "ast-check",
        severity,
        message: message(m[4]),
        fixable: false,
      }),
    ];
  });
}

/**
 * zig fmt — Zig's own formatter, the Zig default (it has no config), like
 * gofmt for Go: wherever the scope holds `.zig` or `.zon` files. Its exit 1
 * means a file differs (its path on stdout), does not parse (a diagnostic on
 * stderr: info here, since zig-ast-check, on the same files, gates on it) or
 * is missing. Recorded on 0.17.0:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 4.
 */
export const zigFmt: ToolAdapter = {
  id: "zig-fmt",
  layer: "format",
  ...common,
  supportsFix: true,
  fixWriteBack: true,

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(check|stdin)$/.test(arg))
      ? "the kit sets --check and the files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("zig fmt needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "fmt",
        ...(ctx.fix ? [] : ["--check"]),
        ...ctx.extraArgs,
        ...files,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput: (raw: RawOutput, ctx: ToolContext): RunResult =>
    readResult("zig fmt", raw, ctx, [
      ...errors(
        "zig-fmt",
        "format",
        "info",
        raw,
        ctx.cwd,
        (text) =>
          `zig fmt cannot format a file that does not parse (zig-ast-check reports it): ${text}`,
      ),
      ...listedFiles("zig-fmt", raw, ctx, {
        files: /\.z(?:ig|on)$/,
        message: "File is not zig fmt-formatted",
      }),
    ]),
};

/**
 * zig ast-check — Zig's compile errors that need no build: syntax, an
 * undeclared name, a redeclared local (no type checking). The Zig default,
 * with zig fmt; one file per run (it takes one). Recorded on 0.17.0:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 4.
 */
export const zigAstCheck: ToolAdapter = {
  id: "zig-ast-check",
  layer: "lint",
  ...common,
  supportsFix: false,
  fixWriteBack: false,

  expand: (seed: TaskSeed): TaskSeed[] =>
    (seed.files ?? []).map((file) => ({ cwd: seed.cwd, files: [file] })),

  buildArgs(ctx: ToolContext): BuiltCommand {
    const [file, ...more] = ctx.files ?? [];
    if (file === undefined || more.length > 0)
      throw new Error("zig ast-check takes exactly one file");
    return {
      bin: this.bin,
      args: ["ast-check", ...ctx.extraArgs, file],
      okExitCodes: [0, 1],
    };
  },

  parseOutput: (raw: RawOutput, ctx: ToolContext): RunResult =>
    readResult(
      "zig ast-check",
      raw,
      ctx,
      errors("zig-ast-check", "lint", "error", raw, ctx.cwd),
    ),
};
