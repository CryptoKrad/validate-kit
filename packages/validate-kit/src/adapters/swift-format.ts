import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  byConfigFolder,
  charColumn,
  finding,
  fromRealCwd,
  relativeFiles,
  sourceLines,
} from "./base.js";

/**
 * `Sources/Bad.swift:1:6: error: [Spacing] remove 2 spaces`; the column
 * counts bytes.
 */
const LINE = /^(.+?):(\d+):(\d+): (error|warning|note): (?:\[(\w+)\] )?(.*)$/;

/**
 * The rules `swift-format format` does not rewrite (its linter-only
 * rules); it fixes every other finding. The first eleven stayed after
 * `format --in-place` on a file that broke them (2026-10-18).
 */
const LINT_ONLY = new Set([
  "AllPublicDeclarationsHaveDocumentation",
  "AlwaysUseLowerCamelCase",
  "IdentifiersMustBeASCII",
  "NeverForceUnwrap",
  "NeverUseForceTry",
  "NeverUseImplicitlyUnwrappedOptionals",
  "NoBlockComments",
  "NoLeadingUnderscores",
  "NoPlaygroundLiterals",
  "ReplaceForEachWithForLoop",
  "TypeNamesShouldBeCapitalized",
  "AmbiguousTrailingClosureOverload",
  "AvoidRetroactiveConformances",
  "BeginDocumentationCommentWithOneLineSummary",
  "DontRepeatTypeInStaticProperties",
  "OnlyOneTrailingClosureArgument",
  "UseLetInEveryBoundCaseVariable",
  "UseSynthesizedInitializer",
  "ValidateDocumentationComments",
]);

/**
 * swift-format — Swift's formatter, run as its linter: layout the formatter
 * would change ([Spacing], [Indentation]) and its lint rules
 * ([DoNotUseSemicolons]...), one finding per place. Where the project chose
 * it: a `.swift-format` at or above the file (swift-format looks up from each
 * file), `tools.swift-format.enabled` or `.configPath`. Only files that
 * exist: it passes a missing path silently. A parse error's path is the real
 * one (/private/tmp for /tmp), and columns count bytes. `--fix` runs
 * `swift-format format --in-place`, which fixes all but its linter-only
 * rules. Recorded on 604.0.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 1.
 */
export const swiftFormat: ToolAdapter = {
  id: "swift-format",
  layer: "format",
  languages: ["swift"],
  bin: "swift-format",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "604.0.0",
  installHint: "brew install swift-format  (or: Xcode's `swift format`)",
  // --strict: any finding exits 1, as does a file that does not parse.
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) => byConfigFolder(seed, env, "swift", [".swift-format"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--color-diagnostics|--assume-filename|-r|--recursive|-)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit names the files and reads swift-format's plain diagnostics"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? ["format", "--in-place"] : ["lint", "--strict"]),
        "--no-color-diagnostics",
        ...(ctx.configPath ? ["--configuration", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "swift-format"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const fileOf = fromRealCwd(ctx.cwd);
    const linesOf = sourceLines();
    for (const text of raw.stderr.split(/\r?\n/)) {
      const line = text.trim();
      if (!line) continue;
      const m = LINE.exec(line);
      // `<unknown>: error: Unable to read configuration`, a usage error.
      if (!m?.[1] || !m[6]) throw new Error(`swift-format failed: ${line}`);
      if (m[4] === "note") continue;
      const rule = m[5];
      const file = fileOf(m[1]);
      const at = Number(m[2]);
      findings.push(
        finding({
          tool: "swift-format",
          layer: "format",
          language: "swift",
          file,
          line: at,
          col: charColumn(linesOf(file), at, Number(m[3]) - 1),
          ruleId: rule ?? "syntax-error",
          // --strict makes every finding an error; only a parse error is one.
          severity: rule === undefined ? "error" : "warning",
          message: m[6],
          fixable: rule !== undefined && !LINT_ONLY.has(rule),
        }),
      );
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
