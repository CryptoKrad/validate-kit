import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import { gofumptAdopted } from "../detect/adoption.js";
import {
  absPosix,
  crlfCheckoutFinding,
  crlfCheckouts,
  filesIn,
  finding,
} from "./base.js";

/** gofumpt — stricter gofmt. Lists (or rewrites) files that need formatting. */
export const gofumpt: ToolAdapter = {
  id: "gofumpt",
  layer: "format",
  languages: ["go"],
  bin: "gofumpt",
  supportsFix: true,
  fixWriteBack: true,
  minVersion: "0.5.0",
  installHint: "brew install gofumpt  (or: go install mvdan.cc/gofumpt@latest)",
  parseVersion: (out) => /v?(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // Only where configured; gofmt checks the rest.
  adoptedAt: gofumptAdopted,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = [
      ctx.fix ? "-w" : "-l",
      ...ctx.extraArgs,
      ...filesIn(ctx, ["go"]),
    ];
    // okExitCodes deliberately [0]-only: gofumpt -l lists files on stdout and
    // exits 0 even when reformatting is needed; ANY non-zero is infrastructure
    // failure -> runner crash. Do NOT widen to [0,1] without adding the
    // exit!=0-with-empty-output self-throw the other formatters carry.
    return { bin: this.bin, args, okExitCodes: [0] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const listed = raw.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((file) => languageForFile(file) === "go")
      .map((file) => absPosix(ctx.cwd, file));
    // gofumpt is gofmt's printer with stricter rules: it writes LF too, so a
    // CRLF checkout is listed whatever its formatting (base.ts, crlfCheckouts).
    const crlf = crlfCheckouts(ctx.cwd, listed);
    const findings = listed.map((file) =>
      crlf.has(file)
        ? crlfCheckoutFinding("gofumpt", file)
        : finding({
            tool: "gofumpt",
            layer: "format",
            language: "go",
            file,
            line: 1,
            col: 1,
            severity: "warning",
            message: "File is not gofumpt-formatted",
            fixable: true,
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
