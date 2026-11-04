import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
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
import { absPosix, finding } from "./base.js";
import { formatChanged } from "./mutation.js";

/** Its own config names (README: `.ecrc` is the legacy one). */
const CONFIGS = [".editorconfig-checker.json", ".ecrc"];

/** `-format gcc`: `file:line:col: error: message`. */
const GCC = /^(.+?):(\d+):(\d+): (error|warning): (.*)$/;

/** A rule id from the message, since the tool prints none. */
const RULES: [RegExp, string][] = [
  [/final newline|line endings/, "final-newline"],
  [/trailing whitespace/, "trailing-whitespace"],
  [/indent style/, "indent-style"],
  [/indent size|indentation/, "indent-size"],
  [/line length|too long/, "max-line-length"],
];

interface Task {
  /** The kit's `ignore` globs: the tool walks every tracked file. */
  ignore: string[];
  /** A changed run: only these files (relative, POSIX) are the run's. */
  only?: string[];
}

/**
 * editorconfig-checker — every file against the project's `.editorconfig`:
 * tabs where it says spaces, trailing whitespace, a missing final newline,
 * CRLF, a line over the limit, in the files no formatter owns (a Makefile,
 * a Dockerfile, a template). The kit already treats `.editorconfig` as a
 * policy file; this enforces it. Where the project chose it: its config,
 * `tools.editorconfig-checker.enabled`, or a step that runs it, and only
 * where an `.editorconfig` is. It reads the tracked files itself (it skips
 * what git ignores); the kit's `ignore` and a changed run's files are
 * applied to its report. Recorded on 4.0.2:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const editorconfigChecker: ToolAdapter = {
  id: "editorconfig-checker",
  layer: "format",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "editorconfig-checker",
  parseVersion: (out) => /v?(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "3.0.0",
  installHint:
    "brew install editorconfig-checker  (or: go install github.com/editorconfig-checker/editorconfig-checker/v3/cmd/editorconfig-checker@latest)",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    if (!existsSync(join(root, ".editorconfig"))) return [];
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: CONFIGS,
        step: /(?:^|[\s;&|"'(/])(?:editorconfig-checker|ec)(?:\s|$)/m,
      });
    if (!chosen) return [];
    const task: Task = {
      ignore: [...env.config.ignore],
      ...(env.changedPaths ? { only: env.changedPaths.map(toPosix) } : {}),
    };
    if (task.only && task.only.length === 0) return [];
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-(?:format|fix|dry-run)(=|$)/.test(arg))
      ? "-format is the kit's; -fix rewrites files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "-format",
        "gcc",
        "-no-color",
        ...(ctx.configPath ? ["-config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      // 1: findings, or a file it could not read; 2: a bad option.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const task = ctx.options as Task | undefined;
    const ignored =
      task && task.ignore.length > 0
        ? picomatch(task.ignore, { dot: true })
        : () => false;
    const only = task?.only ? new Set(task.only) : undefined;
    const findings: Finding[] = [];
    let parsed = 0;
    for (const line of raw.stdout.split(/\r?\n/)) {
      const m = GCC.exec(line);
      if (!m) {
        if (/^resolving .*: /.test(line))
          throw new Error(`editorconfig-checker: ${line}`);
        continue;
      }
      parsed += 1;
      const rel = posix.normalize(toPosix(m[1] ?? ""));
      if (ignored(rel) || (only && !only.has(rel))) continue;
      const message = m[5] ?? "";
      findings.push(
        finding({
          tool: "editorconfig-checker",
          layer: "format",
          file: absPosix(cwd, rel),
          // 0 is the whole file (the final newline).
          line: Math.max(1, Number(m[2])),
          col: Math.max(1, Number(m[3])),
          ruleId:
            RULES.find(([key]) => key.test(message))?.[1] ?? "editorconfig",
          severity: m[4] === "warning" ? "warning" : "error",
          message: `${message} (.editorconfig)`,
          fixable: false,
        }),
      );
    }
    if (raw.exitCode === 1 && parsed === 0)
      throw formatChanged(
        "editorconfig-checker",
        "exited 1 with no gcc-format line",
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
