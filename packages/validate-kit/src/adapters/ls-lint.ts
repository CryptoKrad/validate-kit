import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding, parseJsonLine } from "./base.js";

interface LsLintTask {
  /**
   * The paths whose names count (project-relative): the scope's files, or
   * the changed ones, and the folders that hold them. ls-lint walks the
   * whole tree, what git ignores included.
   */
  keep: string[];
}

/**
 * ls-lint — file and folder names against the rules in the project's
 * `.ls-lint.yml` (kebab-case, snake_case, a regex per extension): a name
 * that breaks one is an error at line 1 of the file, or on the folder. Where
 * the project chose it: a `.ls-lint.yml` at the project root (the only name
 * and place ls-lint reads), `tools.ls-lint.enabled` or
 * `tools.ls-lint.configPath`. It reads the whole tree in 0.01 s, so it runs
 * on every change; only names in the scope count (not what git ignores or
 * the config's `ignore`), and in a changed-file run only the changed files
 * and their folders. Recorded on
 * 2.3.1: docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 6.
 */
export const lsLint: ToolAdapter = {
  id: "ls-lint",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "ls-lint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "2.3.1",
  installHint: "brew install ls-lint  (or: pnpm add -D @ls-lint/ls-lint)",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, { configs: [".ls-lint.yml"] });
    if (!chosen) return [];
    const top = toPosix(root);
    const changed = env.changedPaths && new Set(env.changedPaths.map(toPosix));
    const files = env.scopedFiles
      .map((file) => posix.relative(top, file))
      .filter((path) => !changed || changed.has(path));
    if (files.length === 0) return [];
    const keep = new Set(files);
    for (const file of files)
      for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir))
        keep.add(dir);
    const task: LsLintTask = { keep: [...keep] };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^-{1,2}(error-output-format|warn|debug|workdir)(=|$)/.test(arg),
    )
      ? "the kit reads ls-lint's JSON on stderr and its exit code, from the project root"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "-error-output-format",
        "json",
        ...(ctx.configPath ? ["-config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A config without an `ls` mapping checks nothing, and passes.
    const config = ctx.configPath ?? join(ctx.cwd, ".ls-lint.yml");
    if (existsSync(config)) {
      const ls = (
        parse(readFileSync(config, "utf8")) as { ls?: unknown } | null
      )?.ls;
      if (typeof ls !== "object" || ls === null || Array.isArray(ls))
        throw new Error(
          `ls-lint's config ${config} has no \`ls\` mapping of rules, so it checks no name`,
        );
    }
    const json = raw.stderr
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("{"));
    // A missing config exits 1 too, with a log line and no JSON.
    if (json === undefined) {
      if (raw.exitCode === 0)
        return {
          findings: [],
          filesProcessed: 0,
          fixesApplied: 0,
          rawExitCode: 0,
          stderr: raw.stderr,
        };
      const first = raw.stderr.trim().split(/\r?\n/)[0];
      throw new Error(`ls-lint could not run${first ? `: ${first}` : ""}`);
    }
    const failed = parseJsonLine<unknown>("ls-lint", json.trim());
    // Exit 1 means a name broke a rule: checked before the scope drops any
    // (the runner's own check would see none).
    if (
      typeof failed !== "object" ||
      failed === null ||
      Array.isArray(failed) ||
      (raw.exitCode === 1) !== Object.keys(failed).length > 0
    )
      throw new Error(
        `ls-lint exited ${raw.exitCode} with a report that is not an object of the paths that failed: its output format may have changed; refusing to report it.`,
      );
    const keep = new Set((ctx.options as LsLintTask | undefined)?.keep);
    const findings: Finding[] = [];
    for (const [path, byRule] of Object.entries(failed)) {
      const rules =
        typeof byRule === "object" && byRule !== null
          ? Object.entries(byRule as Record<string, unknown>)
          : [];
      if (
        rules.length === 0 ||
        !rules.every(
          ([, names]) =>
            Array.isArray(names) &&
            names.every((name) => typeof name === "string"),
        )
      )
        throw new Error(
          `ls-lint reported ${path} without the rules it broke: its output format may have changed; refusing to report it.`,
        );
      if (!keep.has(toPosix(path))) continue;
      const file = absPosix(ctx.cwd, path);
      for (const [kind, names] of rules) {
        const list = (names as string[]).join(", ");
        findings.push(
          finding({
            tool: "ls-lint",
            layer: "lint",
            language: languageForFile(file),
            file,
            line: 1,
            col: 1,
            ruleId: list,
            severity: "error",
            message: `${kind === ".dir" ? "the folder name" : `the ${kind} file name`} breaks .ls-lint.yml (${list}): rename it, or add it to the config's ignore list`,
            fixable: false,
          }),
        );
      }
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
