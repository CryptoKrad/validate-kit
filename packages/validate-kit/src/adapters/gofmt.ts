import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { gofumptAdopted } from "../detect/adoption.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, filesIn, finding } from "./base.js";

/**
 * gofmt — Go's own formatter, the Go default; gofumpt replaces it where a
 * repository configured gofumpt (docs/research/formatters/adoption-signals.md).
 */
export const gofmt: ToolAdapter = {
  id: "gofmt",
  layer: "format",
  languages: ["go"],
  bin: "gofmt",
  supportsFix: true,
  fixWriteBack: true,
  installHint: "ships with Go: https://go.dev/dl/",
  // gofmt prints no version of its own: any gofmt is accepted.
  minVersion: "0.0.0",
  // gofmt has no version flag; -h prints its usage (exit 0, or 2 on older Go).
  versionArgs: ["-h"],
  versionExitCodes: [0, 2],
  adoptedAt: (root, projectRoot) => !gofumptAdopted(root, projectRoot),

  buildArgs(ctx: ToolContext): BuiltCommand {
    // `-l` lists the files that differ and exits 0; a syntax error is exit 2
    // on stderr, which the runner reports as a crash. Never with `-d`: go1.26
    // exits 1 for `-d` with differences.
    return {
      bin: this.bin,
      args: [ctx.fix ? "-w" : "-l", ...ctx.extraArgs, ...filesIn(ctx, ["go"])],
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings = [];
    for (const line of raw.stdout.split("\n")) {
      const file = line.trim();
      if (languageForFile(file) !== "go") continue;
      findings.push(
        finding({
          tool: "gofmt",
          layer: "format",
          language: "go",
          file: absPosix(ctx.cwd, file),
          line: 1,
          col: 1,
          severity: "warning",
          message: "File is not gofmt-formatted",
          fixable: true,
        }),
      );
    }
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
