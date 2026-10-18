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
  parseJsonLine,
  relativeFiles,
} from "./base.js";

/**
 * Each top-level JSON array or object in `text`, which holds several back
 * to back (`[...][...]`); a string's brackets do not count. Anything else
 * returns `text` whole, for JSON.parse to name the problem.
 */
function jsonValues(text: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (depth === 0) {
      if (!/\s/.test(c)) return [text];
    } else if (c === '"') inString = true;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) values.push(text.slice(start, i + 1));
    }
  }
  return depth === 0 ? values : [text];
}

/** One line of `--check --output-format=json` (2.6.0). */
interface Mismatched {
  file?: unknown;
  mismatches?: { original_start_line?: unknown }[];
}

/** One parse error, on stderr, in JSON mode. */
interface ParseError {
  filename?: unknown;
  location?: { start_line?: unknown; start_column?: unknown };
  message?: unknown;
}

/**
 * StyLua — the Lua (and Luau) formatter, as a check: each hunk it would
 * rewrite, at the hunk's first line, and each file it cannot parse. Where the
 * project chose it: a `stylua.toml` or `.stylua.toml`, which StyLua reads
 * only from the folder it runs in, so each file runs from its nearest one's
 * folder; or `tools.stylua.enabled` / `.configPath`. `--respect-ignores`
 * keeps `.styluaignore` working for the files the kit names. In JSON mode a
 * syntax error exits 0 with the errors on stderr: they are read, not the
 * exit code. `--fix` runs `stylua`, layout only. Recorded on 2.6.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 4.
 */
export const stylua: ToolAdapter = {
  id: "stylua",
  layer: "format",
  languages: ["lua"],
  bin: "stylua",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "2.6.0",
  installHint: "brew install stylua  (or: cargo install stylua)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) =>
    byConfigFolder(seed, env, "lua", ["stylua.toml", ".stylua.toml"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--output-format|--check|-c|--verify|--stdin-filepath|-)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets StyLua's mode and reads its JSON output"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? [] : ["--check"]),
        // Also in fix mode: a parse error then exits 0 with JSON on stderr.
        "--output-format=json",
        "--respect-ignores",
        ...(ctx.configPath ? ["--config-path", ctx.configPath] : []),
        ...ctx.extraArgs,
        "--",
        ...relativeFiles(ctx, "stylua"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    for (const text of raw.stdout.split("\n")) {
      if (!text.trim()) continue;
      const item = parseJsonLine<Mismatched>("stylua", text.trim());
      if (typeof item.file !== "string" || !Array.isArray(item.mismatches))
        throw new Error(
          "stylua reported a file without a name or mismatches: its output format may have changed; refusing to report it.",
        );
      for (const hunk of item.mismatches) {
        if (typeof hunk.original_start_line !== "number")
          throw new Error(
            "stylua reported a mismatch without a line: its output format may have changed; refusing to report it.",
          );
        findings.push(
          finding({
            tool: "stylua",
            layer: "format",
            language: "lua",
            file: absPosix(ctx.cwd, item.file),
            // 0-based.
            line: hunk.original_start_line + 1,
            col: 1,
            ruleId: "format",
            severity: "warning",
            message: "not formatted as StyLua would: run `check --fix`",
            fixable: true,
          }),
        );
      }
    }
    const stderr = raw.stderr.trim();
    if (stderr) {
      // The parse errors, one JSON array per file with nothing between
      // them; anything else is a failure.
      if (!stderr.startsWith("["))
        throw new Error(`stylua failed: ${stderr.split("\n")[0]}`);
      const errors = jsonValues(stderr).flatMap((text) =>
        findingsArray<ParseError>(
          "stylua",
          parseJsonLine<unknown>("stylua", text),
        ),
      );
      for (const e of errors) {
        if (
          typeof e.filename !== "string" ||
          typeof e.location?.start_line !== "number" ||
          typeof e.location.start_column !== "number" ||
          typeof e.message !== "string"
        )
          throw new Error(
            "stylua reported a parse error without a file, position or message: its output format may have changed; refusing to report it.",
          );
        findings.push(
          finding({
            tool: "stylua",
            layer: "format",
            language: "lua",
            file: absPosix(ctx.cwd, e.filename),
            line: e.location.start_line,
            col: e.location.start_column,
            ruleId: "syntax-error",
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
