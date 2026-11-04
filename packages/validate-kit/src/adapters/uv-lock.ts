import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { formatChanged } from "./mutation.js";

/** What the lock is made from, and the lock itself. */
const INPUT = /(?:^|\/)(?:pyproject\.toml|uv\.toml|uv\.lock)$/;

/** uv's one line for a lock that does not match the project (0.9.30, 0.11.23). */
const STALE = /needs to be updated, but `--check` was provided/;

/**
 * uv lock --check — uv.lock against pyproject.toml: a dependency added,
 * removed or re-pinned without `uv lock`, so `uv sync --locked` and every
 * clean install fail on it. One task per project that has both files (a
 * project without uv.lock did not choose uv), silent when the lock is
 * current; a stale lock is one error on uv.lock, fixable: `--fix` runs
 * `uv lock`. Checking resolves, so it may read the network when the cache
 * lacks a package. A changed-file run starts it only when pyproject.toml,
 * uv.toml or uv.lock of that project changed. Recorded on uv 0.11.23 and
 * 0.9.30: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const uvLock: ToolAdapter = {
  id: "uv-lock",
  layer: "lint",
  languages: ["python"],
  bin: "uv",
  parseVersion: (out) => /uv (\d+\.\d+\.\d+)/.exec(out)?.[1],
  // `--check` was run on 0.9.30; an older uv may spell it `--locked` only.
  minVersion: "0.9.0",
  installHint:
    "brew install uv  (or: curl -LsSf https://astral.sh/uv/install.sh | sh)",
  supportsFix: true,
  fixWriteBack: true,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (
      !existsSync(join(seed.cwd, "pyproject.toml")) ||
      !existsSync(join(seed.cwd, "uv.lock"))
    )
      return [];
    const cwd = toPosix(seed.cwd);
    if (
      env.changedPaths &&
      !env.changedPaths.some(
        (path) =>
          INPUT.test(toPosix(path)) &&
          isUnder(absPosix(toPosix(env.projectRoot), path), cwd),
      )
    )
      return [];
    return [seed];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(?:check|locked|frozen|check-exists)$/.test(arg),
    )
      ? "--check is the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "lock",
        ...(ctx.fix ? [] : ["--check"]),
        "--no-progress",
        "--color",
        "never",
        ...ctx.extraArgs,
      ],
      // 1: the lock needs updating; 2: no lock or no project (an error).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    if (raw.exitCode === 0) return result([]);
    if (!STALE.test(raw.stderr)) {
      const why = raw.stderr
        .split(/\r?\n/)
        .find((line) => line.startsWith("error:"));
      throw why
        ? new Error(why)
        : formatChanged("uv lock", "exited 1 without saying the lock is stale");
    }
    return result([
      finding({
        tool: "uv-lock",
        layer: "lint",
        language: "python",
        file: absPosix(toPosix(ctx.cwd), "uv.lock"),
        line: 1,
        col: 1,
        ruleId: "stale",
        severity: "error",
        message:
          "uv.lock does not match pyproject.toml (a dependency added, removed or re-pinned without re-locking; `uv sync --locked` fails on it): run uv lock",
        fixable: true,
      }),
    ]);
  },
};
