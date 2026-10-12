import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { ruffFormatAdopted } from "../detect/adoption.js";
import { absPosix, filesIn, finding } from "./base.js";

/** ruff format — Python formatter (Black-compatible). */
export const ruffFormat: ToolAdapter = {
  id: "ruff-format",
  layer: "format",
  languages: ["python"],
  bin: "ruff",
  supportsFix: true,
  fixWriteBack: true,
  minVersion: "0.5.0",
  installHint: "brew install ruff  (or: uv tool install ruff)",
  parseVersion: (out) => /ruff\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: ruffFormatAdopted,
  adoptHint:
    "Add a [tool.ruff.format] table (or [format] in ruff.toml), run `ruff format` in a hook or CI step, or set `tools.ruff-format.enabled: true`.",

  buildArgs(ctx: ToolContext): BuiltCommand {
    // --no-cache: a check must not write .ruff_cache into the project.
    const args = ["format", "--no-cache"];
    if (!ctx.fix) args.push("--check");
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(...ctx.extraArgs, ...filesIn(ctx, ["python"]));
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings = [];
    for (const line of raw.stdout.split("\n")) {
      const m = /^Would reformat:\s+(.+)$/.exec(line.trim());
      if (m?.[1]) {
        findings.push(
          finding({
            tool: "ruff-format",
            layer: "format",
            language: "python",
            file: absPosix(ctx.cwd, m[1]),
            line: 1,
            col: 1,
            severity: "warning",
            message: "File is not ruff-formatted",
            fixable: true,
          }),
        );
      }
    }
    if (raw.exitCode !== 0 && findings.length === 0) {
      const firstLine = `${raw.stdout}\n${raw.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      throw new Error(
        `ruff-format failed without file-level reformat output${firstLine ? `: ${firstLine}` : ""}`,
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
