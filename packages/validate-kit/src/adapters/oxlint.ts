import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import {
  filesIn,
  absPosix,
  clampSeverity,
  finding,
  parseFindings,
  quietWithWarningLimit,
} from "./base.js";

const NO_FILES = "No files found to lint.";

interface OxLabel {
  span?: { line?: number; column?: number };
}
interface OxDiagnostic {
  message: string;
  code?: string;
  severity?: string;
  url?: string;
  filename: string;
  labels?: OxLabel[];
}

/** oxlint — very fast JS/TS linter (oxc). The broad JS/TS lint layer. */
export const oxlint: ToolAdapter = {
  id: "oxlint",
  layer: "lint",
  languages: ["ts", "js"],
  bin: "oxlint",
  supportsFix: true,
  fixWriteBack: true,
  minVersion: "0.9.0",
  installHint: "pnpm add -D oxlint",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  // Exit 1: findings reported (recorded on the installed version).
  findingExitCodes: [1],

  refuseArgs: (extraArgs) =>
    quietWithWarningLimit(extraArgs, ["--max-warnings", "--deny-warnings"]),

  buildArgs(ctx: ToolContext): BuiltCommand {
    // oxlint does not skip node_modules by default when no ignore file is present;
    // scanning a fresh repo's node_modules would crawl thousands of files. Always
    // exclude the heavy dirs (harmless when an explicit file list is passed).
    const args = [
      "-f",
      "json",
      "--ignore-pattern",
      "**/node_modules/**",
      "--ignore-pattern",
      "**/dist/**",
      "--ignore-pattern",
      "**/.next/**",
      "--ignore-pattern",
      "**/target/**",
      "--ignore-pattern",
      "**/next-env.d.ts",
    ];
    if (ctx.fix) args.push("--fix");
    if (ctx.configPath) args.push("-c", ctx.configPath);
    args.push(...ctx.extraArgs, ...filesIn(ctx, ["ts", "js"]));
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Every file it was given is ignored by the project's own oxlint config
    // (1.86 applies ignorePatterns to named files): it prints this line before
    // its JSON and exits 1. Nothing to lint is neither a crash nor a finding
    // (docs/research/lint-toolchain/exit-codes-and-json-shapes.md).
    const nothingToLint = raw.stdout.startsWith(NO_FILES);
    const output = nothingToLint
      ? { ...raw, stdout: raw.stdout.slice(raw.stdout.indexOf("\n") + 1) }
      : raw;
    const { root, items: diagnostics } = parseFindings<OxDiagnostic>(
      "oxlint",
      output,
      "diagnostics",
    );
    const nothingLinted =
      nothingToLint &&
      diagnostics.length === 0 &&
      (root as { number_of_files?: unknown }).number_of_files === 0;
    const findings = diagnostics.map((d) => {
      const file = absPosix(ctx.cwd, d.filename);
      // labels[0] IS the diagnostic anchor in oxlint's miette-style JSON —
      // there is no primary flag (verified empirically on oxlint 1.x); later
      // labels are secondary annotations.
      const span = d.labels?.[0]?.span;
      const lang = languageForFile(file);
      return finding({
        tool: "oxlint",
        layer: "lint",
        language: lang,
        file,
        line: span?.line ?? 1,
        col: span?.column ?? 1,
        ...(d.code ? { ruleId: d.code } : {}),
        severity: clampSeverity(d.severity),
        message: d.message,
        // oxlint's JSON carries no per-diagnostic fix data (verified on 1.x:
        // no `fix` field in `-f json`), so per-finding fixability is unknown;
        // the fix pass keys off adapter.supportsFix, not this flag.
        fixable: false,
        ...(d.url ? { url: d.url } : {}),
      });
    });
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: nothingLinted ? 0 : raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
