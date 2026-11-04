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

/** What changes what tidy would write: Go source and the module files. */
const INPUT = /\.go$|(?:^|\/)go\.(?:mod|sum|work)$/;

/** `diff current/go.mod tidy/go.mod`: the file tidy would rewrite. */
const HEADER = /^diff current\/(go\.(?:mod|sum)) tidy\//;

/**
 * go mod tidy -diff — go.mod and go.sum against the imports: a require for a
 * module nothing imports, or an import whose module is not required (it
 * builds here from the module cache and fails in CI's `-mod=readonly`). The
 * usual leftover of an agent that added or removed an import. One task per
 * module (the go.mod root), silent when tidy would change nothing; the diff
 * it prints is one error per file tidy would rewrite, fixable: `--fix` runs
 * `go mod tidy`. A changed-file run starts it only when a Go file or a
 * module file of that module changed. Recorded on go1.26.6 (`-diff` arrived
 * in Go 1.23): docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const goModTidy: ToolAdapter = {
  id: "go-mod-tidy",
  layer: "lint",
  languages: ["go"],
  bin: "go",
  versionArgs: ["version"],
  parseVersion: (out) => /go(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1],
  minVersion: "1.23.0",
  installHint: "ships with Go 1.23 or later: https://go.dev/dl/",
  supportsFix: true,
  fixWriteBack: true,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (!existsSync(join(seed.cwd, "go.mod"))) return [];
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
    extraArgs.some((arg) => /^-(?:diff|e)$/.test(arg))
      ? "-diff is the kit's (and -e would hide a module it cannot resolve)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["mod", "tidy", ...(ctx.fix ? [] : ["-diff"]), ...ctx.extraArgs],
      // 1: the diff is not empty, or tidy failed (`go:` on stderr).
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
    const files = raw.stdout
      .split(/\r?\n/)
      .map((line) => HEADER.exec(line)?.[1])
      .filter((file): file is string => file !== undefined);
    if (files.length === 0) {
      // Exit 1 and no diff: tidy could not finish (a module it cannot find
      // or download, a go.mod it cannot parse). That is not a finding.
      const why = raw.stderr
        .split(/\r?\n/)
        .find((line) => line.startsWith("go:"));
      throw why
        ? new Error(why)
        : formatChanged("go mod tidy", "exited 1 with no diff and no error");
    }
    return result(
      files.map((file) =>
        finding({
          tool: "go-mod-tidy",
          layer: "lint",
          language: "go",
          file: absPosix(toPosix(ctx.cwd), file),
          line: 1,
          col: 1,
          ruleId: "untidy",
          severity: "error",
          message: `${file} is not what \`go mod tidy\` would write: a require nothing imports, or an import whose module is not required (CI's -mod=readonly fails on it); run go mod tidy`,
          fixable: true,
        }),
      ),
    );
  },
};
