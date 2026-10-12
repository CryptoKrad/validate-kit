import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";

/** rustfmt (via cargo fmt) — Rust formatter. Crate-scoped. */
export const rustfmt: ToolAdapter = {
  id: "rustfmt",
  layer: "format",
  languages: ["rust"],
  bin: "cargo",
  supportsFix: true,
  fixWriteBack: true,
  fileScoped: false,
  rootedAtMarker: true,
  minVersion: "1.0.0",
  installHint: "rustup component add rustfmt",
  versionArgs: ["fmt", "--version"],
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = ["fmt"];
    if (!ctx.fix) args.push("--check");
    if (ctx.extraArgs.length > 0) args.push("--", ...ctx.extraArgs);
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings = [];
    const seen = new Set<string>();
    const text = `${raw.stdout}\n${raw.stderr}`;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const m =
        /^Diff in (.+?) at line (\d+):?/.exec(trimmed) ??
        /^Diff in (.+):(\d+):?/.exec(trimmed);
      if (m?.[1] && m[2]) {
        const file = absPosix(ctx.cwd, m[1]);
        const key = `${file}:${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(
          finding({
            tool: "rustfmt",
            layer: "format",
            language: "rust",
            file,
            line: Number(m[2]),
            col: 1,
            severity: "warning",
            message: "Code is not rustfmt-formatted",
            fixable: true,
          }),
        );
      }
    }
    if (findings.length === 0 && raw.exitCode !== 0 && !raw.spawnError) {
      const firstLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      throw new Error(
        `rustfmt failed without diff output${firstLine ? `: ${firstLine}` : ""}`,
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
