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
import { firstConfig } from "../detect/adoption.js";
import { absPosix, finding, listedFiles, readResult } from "./base.js";

interface ScalafmtTask {
  /** The `.scalafmt.conf`, absolute. */
  config: string;
}

/** `<abs path>:2: error: [dialect scala3] `identifier` expected but `=` found` */
const PARSE_ERROR = /^(\S.*?):(\d+): error: (.+)$/;

/** Coursier fetching the scalafmt version a config pins (c-zig-jvm.md, 9). */
const DOWNLOAD = /^Download(?:ing https?:\/\/|ed \d+ missing file)/m;

/**
 * scalafmt — Scala formatting by the project's `.scalafmt.conf` (at or
 * above the Scala root, or `tools.scalafmt.configPath`); it has no style
 * without one. Checked with `--list`: `--test` exits 0 on a file that does
 * not parse, `--list` exits 2 and prints the parse error (exit 1: files
 * differ, 3: both); its paths are URI-encoded. The project's excludeFilters
 * hold for the files the kit names. Verify tier: it runs the scalafmt
 * version the config pins, and downloads that version on first use
 * (network, ~3 s; COURSIER_MODE=offline does not stop it), which the run
 * then reports as info; the CLI's own version runs offline. Recorded on
 * 3.11.5: docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 9.
 */
export const scalafmt: ToolAdapter = {
  id: "scalafmt",
  layer: "format",
  languages: ["scala"],
  bin: "scalafmt",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  tier: "verify",
  minVersion: "3.11.5",
  installHint: "coursier install scalafmt  (coursier: brew install coursier)",
  parseVersion: (out) => /scalafmt (\d+\.\d+\.\d+)/.exec(out)?.[1],
  masks: (f) => f.ruleId === "syntax-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const config =
      env.toolConfig.configPath ??
      firstConfig(seed.cwd, env.projectRoot, [".scalafmt.conf"]);
    if (!seed.files?.length) return [];
    if (config === undefined)
      return env.toolConfig.enabled === true
        ? [
            {
              ...seed,
              cannotRun:
                "no .scalafmt.conf here or above, and no tools.scalafmt.configPath: scalafmt needs one (with `version` and `runner.dialect`)",
            },
          ]
        : [];
    const task: ScalafmtTask = { config };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--test|--check|--list|-l|--stdout|--stdin|--mode|--diff|--diff-branch|--config|-c|--config-str)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets scalafmt's config, its files and how it reports them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    // No paths would format the whole project.
    if (files.length === 0)
      throw new Error("scalafmt needs the task's file list");
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? [] : ["--list"]),
        "--non-interactive",
        "--respect-project-filters",
        "--config",
        (ctx.options as ScalafmtTask).config,
        ...ctx.extraArgs,
        ...files,
      ],
      // A bitmask: 1 files differ, 2 a parse error. 4 is a bad flag, 8 an
      // unexpected error (a missing file), 16 a missing config or version.
      okExitCodes: [0, 1, 2, 3],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      const m = PARSE_ERROR.exec(line);
      if (!m?.[1] || !m[2] || !m[3]) continue;
      findings.push(
        finding({
          tool: "scalafmt",
          layer: "format",
          language: "scala",
          file: absPosix(ctx.cwd, m[1]),
          line: Number(m[2]),
          col: 1,
          ruleId: "syntax-error",
          severity: "error",
          message: m[3],
          fixable: false,
        }),
      );
    }
    findings.push(
      ...listedFiles("scalafmt", raw, ctx, {
        files: /\.(?:scala|sc|sbt)$/,
        message: "File is not scalafmt-formatted",
        // `src/my%20dir/B%20C.scala`
        path: decodeURIComponent,
      }),
    );
    const result = readResult("scalafmt", raw, ctx, findings);
    if (DOWNLOAD.test(raw.stderr))
      result.findings.push(
        finding({
          tool: "scalafmt",
          layer: "format",
          file: (ctx.options as ScalafmtTask).config,
          line: 1,
          col: 1,
          ruleId: "download",
          severity: "info",
          message:
            "scalafmt downloaded the version this config pins (network, first use only); later runs read the coursier cache",
          fixable: false,
        }),
      );
    return result;
  },
};
