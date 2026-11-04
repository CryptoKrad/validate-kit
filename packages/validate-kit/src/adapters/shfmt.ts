import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, filesIn, finding } from "./base.js";
import { formatChanged } from "./mutation.js";

/** A parse error on stderr: `file:line:col: message`. */
const PARSE = /^(.+?):(\d+):(\d+): (.*)$/;

/**
 * shfmt — shell scripts against the formatting shfmt (and the project's
 * `.editorconfig`) would write, and scripts it cannot parse at all, which
 * shellcheck may still pass. `-l` names each file that differs: one warning
 * on it, fixable (`--fix` runs `-w`); a parse error is an error at its line.
 * Where the project chose it: `tools.shfmt.enabled`, or a step that runs
 * it. Recorded on 3.14.1:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const shfmt: ToolAdapter = {
  id: "shfmt",
  layer: "format",
  languages: ["shell"],
  bin: "shfmt",
  parseVersion: (out) => /v?(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "3.0.0",
  installHint:
    "brew install shfmt  (or: go install mvdan.cc/sh/v3/cmd/shfmt@latest)",
  supportsFix: true,
  fixWriteBack: true,
  fileScoped: true,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(env.projectRoot, env.projectRoot, {
        configs: [],
        step: /(?:^|[\s;&|"'(/])shfmt(?:\s|$)/m,
      });
    return chosen ? [seed] : [];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-(?:l|w|d|f|s)$/.test(arg))
      ? "-l and -w are the kit's; -d, -f and -s change what it reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ctx.fix ? "-w" : "-l",
        ...ctx.extraArgs,
        ...filesIn(ctx, ["shell"]),
      ],
      // 1: a file differs, or a file could not be parsed or read.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      const parsed = PARSE.exec(line);
      if (!parsed) {
        // `lstat x: no such file` and the like: shfmt's own error.
        if (line.trim() !== "") throw new Error(`shfmt: ${line.trim()}`);
        continue;
      }
      findings.push(
        finding({
          tool: "shfmt",
          layer: "format",
          language: "shell",
          file: absPosix(cwd, parsed[1] ?? ""),
          line: Number(parsed[2]),
          col: Number(parsed[3]),
          ruleId: "parse",
          severity: "error",
          message: `shfmt cannot parse this script: ${parsed[4] ?? ""}`,
          fixable: false,
        }),
      );
    }
    if (!ctx.fix)
      for (const file of raw.stdout.split(/\r?\n/)) {
        if (file.trim() === "") continue;
        findings.push(
          finding({
            tool: "shfmt",
            layer: "format",
            language: "shell",
            file: absPosix(cwd, file),
            line: 1,
            col: 1,
            ruleId: "unformatted",
            severity: "warning",
            message:
              "not formatted as shfmt would write it (run shfmt -w, or `--fix`)",
            fixable: true,
          }),
        );
      }
    if (raw.exitCode === 1 && findings.length === 0 && !ctx.fix)
      throw formatChanged("shfmt", "exited 1 with no file listed and no error");
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
