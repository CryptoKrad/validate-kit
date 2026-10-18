import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";
import { bufAdopted, bufPaths, NONE_TARGETED } from "./buf.js";
import { hunkStarts } from "./schemas-iac.js";

/**
 * buf format — Protobuf files not in buf's canonical layout, one finding per
 * changed block, from `buf format -d --exit-code` (a unified diff, exit
 * 100); `--fix` rewrites them (`buf format -w`, layout only). Where buf
 * lint runs: a `buf.yaml` or `buf.work.yaml`. Recorded on 1.73.0:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 1.
 */
export const bufFormat: ToolAdapter = {
  id: "buf-format",
  layer: "format",
  languages: ["proto"],
  bin: "buf",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.73.0",
  installHint: "brew install buf",
  adoptedAt: bufAdopted,
  findingExitCodes: [100],

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-d|--diff|-w|--write|--exit-code|-o|--output|--path)(=|$)/.test(arg),
    )
      ? "the kit sets the diff, the write, the exit code and the files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "format",
        ...(ctx.fix ? ["-w"] : ["-d", "--exit-code"]),
        ...ctx.extraArgs,
        ...bufPaths(ctx),
      ],
      okExitCodes: [0, 1, 100],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // 1: a failure, or every file given is outside buf's modules.
    if (raw.exitCode === 1 && !raw.stderr.trimStart().startsWith(NONE_TARGETED))
      throw new Error(
        `buf format failed: ${raw.stderr.trim().split("\n")[0] ?? "no message"}`,
      );
    const findings = ctx.fix
      ? []
      : hunkStarts(raw.stdout, "").map(({ file, line }) =>
          finding({
            tool: "buf-format",
            layer: "format",
            language: "proto",
            file: absPosix(ctx.cwd, file),
            line,
            col: 1,
            severity: "warning",
            message:
              "not in buf's canonical format: run `buf format -w` (or `check --fix`)",
            fixable: true,
          }),
        );
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode === 1 ? 0 : raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
