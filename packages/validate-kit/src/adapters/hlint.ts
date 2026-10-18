import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  byConfigFolder,
  finding,
  parseFindings,
  relativeFiles,
} from "./base.js";

/** One idea of `hlint --json` (3.10). */
interface Idea {
  severity?: unknown;
  hint?: unknown;
  file?: unknown;
  startLine?: unknown;
  startColumn?: unknown;
  to?: unknown;
  note?: unknown;
}

const SEVERITY: Record<string, Severity> = {
  Error: "error",
  Warning: "warning",
  // A suggestion is style: shown, not gating.
  Suggestion: "info",
};

/**
 * hlint — Haskell's linter: code that has a simpler or safer form (eta
 * reduction, redundant `if`, a lambda that is a function), with the
 * replacement. A file that does not parse is an error. Where the project
 * chose it: a `.hlint.yaml`, which hlint reads from the folder it runs in
 * and above, so each file runs from its nearest one's folder; or
 * `tools.hlint.enabled` / `.configPath`. No fix: `--refactor` needs the
 * separate apply-refact tool. Recorded on 3.10:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 6.
 */
export const hlint: ToolAdapter = {
  id: "hlint",
  layer: "lint",
  languages: ["haskell"],
  bin: "hlint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "3.10.0",
  installHint: "brew install hlint  (or: cabal install hlint)",
  parseVersion: (out) => /HLint v(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1],
  // 1: any idea, also a parse error (it is one of them).
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "parse-error",

  expand: (seed, env) => byConfigFolder(seed, env, "haskell", [".hlint.yaml"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--json|--sarif|--cc|--refactor|--refactor-options|-r|--report|-g|--git|-d|--default|--generate-config|-f|--find|--no-exit-code)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit names the files and reads hlint's JSON output and exit code"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--json",
        ...(ctx.configPath ? [`--hint=${ctx.configPath}`] : []),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "hlint"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A missing file or a bad flag: exit 1, nothing on stdout, a line on
    // stderr (parseFindings throws with it).
    const { items } = parseFindings<Idea>("hlint", raw);
    const findings = items.map((idea) => {
      const severity =
        typeof idea.severity === "string" ? SEVERITY[idea.severity] : undefined;
      if (
        severity === undefined ||
        typeof idea.hint !== "string" ||
        typeof idea.file !== "string" ||
        typeof idea.startLine !== "number" ||
        typeof idea.startColumn !== "number"
      )
        throw new Error(
          `hlint reported an idea without a hint, file, position or known severity (${JSON.stringify(idea.severity)}): its output format may have changed; refusing to report it.`,
        );
      const parse = idea.hint.startsWith("Parse error");
      const notes = Array.isArray(idea.note)
        ? idea.note.filter((n): n is string => typeof n === "string")
        : [];
      return finding({
        tool: "hlint",
        layer: "lint",
        language: "haskell",
        file: absPosix(ctx.cwd, idea.file),
        line: idea.startLine,
        col: idea.startColumn,
        ruleId: parse ? "parse-error" : idea.hint,
        severity,
        message: [
          idea.hint,
          typeof idea.to === "string" && idea.to ? `: use \`${idea.to}\`` : "",
          notes.length > 0 ? ` (${notes.join("; ")})` : "",
        ].join(""),
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
