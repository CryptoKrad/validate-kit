import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { upTo } from "../detect/adoption.js";
import {
  byConfigFolder,
  finding,
  fromRealCwd,
  parseFindings,
  relativeFiles,
} from "./base.js";

const CONFIG = ".swiftlint.yml";

/** One violation of `--reporter json` (0.65.1). */
interface Violation {
  character?: unknown;
  file?: unknown;
  line?: unknown;
  reason?: unknown;
  rule_id?: unknown;
  severity?: unknown;
}

/**
 * Why SwiftLint could not read the config at `path`, or one it names
 * (`parent_config`, `child_config`), if it could not: it does not parse, is
 * not a mapping, or does not exist. A URL is refused unread: SwiftLint
 * would fetch it over the network and cache it in the project.
 */
function unreadable(path: string, seen: Set<string>): string | undefined {
  if (seen.has(path)) return undefined;
  seen.add(path);
  let config: unknown;
  try {
    config = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : "";
    return existsSync(path)
      ? `${path} does not parse (${why ?? ""})`
      : `${path} does not exist`;
  }
  if (config === null || config === undefined) return undefined;
  if (typeof config !== "object" || Array.isArray(config))
    return `${path} is not a mapping`;
  for (const key of ["parent_config", "child_config"]) {
    const named = (config as Record<string, unknown>)[key];
    if (named === undefined) continue;
    if (typeof named !== "string") return `${path}: ${key} is not a path`;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(named))
      return `${path}: ${key} is a URL, which SwiftLint would fetch over the network`;
    const problem = unreadable(resolve(dirname(path), named), seen);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * SwiftLint — Swift lint rules (naming, force unwraps, colon spacing...), at
 * the severity the project's config gives each. Where the project chose it:
 * a `.swiftlint.yml` at or above the file, run from the highest one (SwiftLint
 * merges the nested ones below it itself), or `tools.swiftlint.enabled` /
 * `.configPath`. `--force-exclude` keeps the config's `excluded` paths out
 * although the kit names them. Never `--fix`: its corrections rewrite code.
 * A config SwiftLint cannot read (a missing `--config`, YAML that does not
 * parse, a missing parent) makes it hang past `kill -9`, so every config a
 * task reads is parsed first and a bad one means the task cannot run; a
 * remote `parent_config` is refused the same way (network). The kit's
 * config refuses a configPath that does not exist, extraArgs cannot name
 * one, and the run has a timeout. Recorded on 0.65.1:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 2.
 */
export const swiftlint: ToolAdapter = {
  id: "swiftlint",
  layer: "lint",
  languages: ["swift"],
  bin: "swiftlint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.65.1",
  installHint: "brew install swiftlint",
  versionArgs: ["version"],
  timeoutMs: 120_000,
  // 2: a violation of severity error.
  findingExitCodes: [2],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const { configPath } = env.toolConfig;
    const tasks = byConfigFolder(seed, env, "swift", [CONFIG], {
      highest: true,
    });
    for (const task of tasks) {
      // Every config this run reads: the named one, the one it runs from
      // and the nested ones down to each file.
      const configs = new Set(
        [
          ...(configPath ? [configPath] : []),
          ...(task.files ?? []).flatMap((file) =>
            upTo(dirname(file), task.cwd).map((dir) => join(dir, CONFIG)),
          ),
        ].filter((path) => existsSync(path)),
      );
      const seen = new Set<string>();
      const problem = [...configs]
        .map((path) => unreadable(path, seen))
        .find(Boolean);
      if (problem)
        task.cannotRun = `${problem}: SwiftLint never exits on a config it cannot read, so it is not run`;
    }
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(reporter|output|config|fix|autocorrect|format|use-stdin|use-script-input-files|use-script-input-file-lists|working-directory|write-baseline|benchmark|check-for-updates|progress)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets SwiftLint's report, its files and its config (tools.swiftlint.configPath, checked to exist); it never fixes, writes into the project or checks for updates"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "lint",
        "--reporter",
        "json",
        "--quiet",
        "--force-exclude",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "swiftlint"),
      ],
      okExitCodes: [0, 1, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Every named file is in the config's `excluded` (--force-exclude).
    if (raw.exitCode === 1) {
      if (!raw.stderr.includes("No lintable files found at paths"))
        throw new Error(
          `swiftlint failed: ${raw.stderr.trim().split("\n")[0] ?? ""}`,
        );
      return {
        findings: [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: 0,
        stderr: raw.stderr,
      };
    }
    const { items } = parseFindings<Violation>("swiftlint", raw);
    // Absolute, and the real path when the kit named it relative.
    const fileOf = fromRealCwd(ctx.cwd);
    const findings = items.map((v) => {
      if (
        typeof v.file !== "string" ||
        typeof v.line !== "number" ||
        typeof v.rule_id !== "string" ||
        typeof v.reason !== "string" ||
        (v.severity !== "Error" && v.severity !== "Warning")
      )
        throw new Error(
          `swiftlint reported a violation without a file, line, rule, reason or known severity (${JSON.stringify(v.severity)}): its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "swiftlint",
        layer: "lint",
        language: "swift",
        file: fileOf(v.file),
        line: v.line,
        // null for a violation of the whole line or file.
        col: typeof v.character === "number" ? v.character : 1,
        ruleId: v.rule_id,
        severity: v.severity === "Error" ? "error" : "warning",
        message: v.reason,
        fixable: false,
        url: `https://realm.github.io/SwiftLint/${v.rule_id}.html`,
      });
    });
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
