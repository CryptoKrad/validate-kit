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
  charColumn,
  finding,
  findingsArray,
  parseJsonLine,
  relativeFiles,
  sourceLines,
} from "./base.js";

/** One line of `deadnix -o json` (1.3.1): a file that has results. */
interface FileResults {
  file?: unknown;
  results?: unknown;
}

interface Result {
  line?: unknown;
  column?: unknown;
  message?: unknown;
}

/** rnix's parse errors, as deadnix prints them in a result with no line. */
const PARSE_ERROR =
  /^(?:unexpected |error node at |argument `[^`]*` is duplicated|recursion limit exceeded)/;

/** `at 6..7`: the error's byte range in the file. */
const BYTE_RANGE = /\b(?:at|in) (\d+)\.\.\d+/;

/** The 1-based line and character column of a byte offset into `lines`. */
function at(lines: string[], byte: number): { line: number; col: number } {
  let rest = byte;
  for (const [i, text] of lines.entries()) {
    const size = Buffer.byteLength(text) + 1;
    if (rest < size)
      return { line: i + 1, col: charColumn(lines, i + 1, rest) };
    rest -= size;
  }
  return { line: Math.max(1, lines.length), col: 1 };
}

/**
 * deadnix — dead Nix code: unused `let` bindings, lambda arguments and
 * pattern names, one finding each. Opt-in (`tools.deadnix.enabled`): it has
 * no config file to adopt it by. It exits 0 for a file it cannot read or
 * parse, even with `--fail`, reporting it as a result with no line: a parse
 * error is a finding at its place (a file that does not parse hides its
 * other findings), a file it cannot read a crash. Its columns count bytes.
 * No fix: `--edit` removes code (and panicked on a lambda pattern).
 * Recorded on 1.3.1:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 9.
 */
export const deadnix: ToolAdapter = {
  id: "deadnix",
  layer: "lint",
  languages: ["nix"],
  bin: "deadnix",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.3.1",
  installHint: "cargo install --locked deadnix",
  // --fail: 1 when anything is unused.
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) => byConfigFolder(seed, env, "nix", []),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-o|--output-format|-e|--edit|-q|--quiet|-f|--fail)(=|$)/.test(arg),
    )
      ? "the kit sets deadnix's output and exit code, and never edits"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--fail",
        "-o",
        "json",
        ...ctx.extraArgs,
        "--",
        ...relativeFiles(ctx, "deadnix"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const linesOf = sourceLines();
    for (const text of raw.stdout.split("\n")) {
      if (!text.trim()) continue;
      const item = parseJsonLine<FileResults>("deadnix", text.trim());
      if (typeof item.file !== "string")
        throw new Error(
          "deadnix printed results without a file: its output format may have changed; refusing to report it.",
        );
      const file = absPosix(ctx.cwd, item.file);
      const lines = linesOf(file) ?? [];
      const results = findingsArray<Result>("deadnix", item.results);
      for (const r of results) {
        if (typeof r.message !== "string")
          throw new Error(
            "deadnix printed a result without a message: its output format may have changed; refusing to report it.",
          );
        // No line: a parse error (`unexpected TOKEN_SEMICOLON at 6..7`, a
        // byte range; `unexpected end of file` has none), or a file it
        // could not read, which is a crash: it checked nothing.
        if (typeof r.line !== "number" || typeof r.column !== "number") {
          if (!PARSE_ERROR.test(r.message))
            throw new Error(
              `deadnix could not check ${item.file}: ${r.message}`,
            );
          const byte = BYTE_RANGE.exec(r.message)?.[1];
          // An end-of-file error only when no error of the file has a place.
          if (
            byte === undefined &&
            results.some((o) => BYTE_RANGE.test(String(o.message)))
          )
            continue;
          findings.push(
            finding({
              tool: "deadnix",
              layer: "lint",
              language: "nix",
              file,
              ...(byte === undefined
                ? { line: Math.max(1, lines.length), col: 1 }
                : at(lines, Number(byte))),
              ruleId: "syntax-error",
              severity: "error",
              message: r.message,
              fixable: false,
            }),
          );
          continue;
        }
        findings.push(
          finding({
            tool: "deadnix",
            layer: "lint",
            language: "nix",
            file,
            line: r.line,
            // A 1-based byte column.
            col: charColumn(lines, r.line, r.column - 1),
            // `Unused lambda pattern: pkgs` -> unused-lambda-pattern.
            ruleId: (r.message.split(":")[0] ?? "")
              .trim()
              .toLowerCase()
              .replaceAll(/\s+/g, "-"),
            severity: "warning",
            message: `${r.message}: remove it`,
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
