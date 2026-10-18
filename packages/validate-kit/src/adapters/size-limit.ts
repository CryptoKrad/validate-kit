import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  escapeRegex,
  finding,
  findingsArray,
  lineOf,
  parseJsonOutput,
} from "./base.js";
import { packageTasks } from "./npm-package.js";

/** size-limit's own config files; package.json's `size-limit` key is the other. */
const CONFIGS = [
  ".size-limit.json",
  ".size-limit.js",
  ".size-limit.cjs",
  ".size-limit.mjs",
  ".size-limit.ts",
];

/** One check in `--json` output: `passed` and `sizeLimit` only with a limit. */
interface Check {
  name?: unknown;
  passed?: unknown;
  size?: unknown;
  sizeLimit?: unknown;
}

/** The file that holds the package's checks. */
function configOf(dir: string): string {
  return (
    CONFIGS.map((name) => join(dir, name)).find((path) => existsSync(path)) ??
    join(dir, "package.json")
  );
}

/**
 * size-limit — the size of a package's built files against the budget its
 * config sets: each check over its limit is an error at the check in the
 * config. It measures the build output, so the package is built first. Where
 * a package chose it: a `.size-limit.*` file or a `size-limit` key in its
 * package.json, run from that package. Recorded on 14.2.0:
 * docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 1.
 */
export const sizeLimit: ToolAdapter = {
  id: "size-limit",
  layer: "behavior",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "size-limit",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "14.2.0",
  installHint: "pnpm add -D size-limit @size-limit/file",
  parseVersion: (out) => /size-limit (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],

  expand: (seed, env) =>
    packageTasks(
      seed,
      env,
      ({ dir, manifest }) =>
        Object.hasOwn(manifest, "size-limit") ||
        CONFIGS.some((name) => existsSync(join(dir, name))),
    ),

  refuseArgs: (extraArgs) =>
    extraArgs.some(
      (arg) =>
        !arg.startsWith("-") ||
        /^--(json|watch|limit|ignore-missing|save-bundle|debug)(=|$)/.test(arg),
    )
      ? "the checks and their limits are the package's size-limit config: a file, --limit or --ignore-missing replaces them, and --json, --watch, --save-bundle and --debug change what the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // 1: a check over its limit, and every failure besides.
    return {
      bin: this.bin,
      args: ["--json", ...ctx.extraArgs],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const root = parseJsonOutput<unknown>("size-limit", raw, null);
    const error = (root as { error?: unknown } | null)?.error;
    if (typeof error === "string")
      throw new Error(`size-limit failed: ${error.split("\n")[0] ?? ""}`);
    const checks = findingsArray<Check>("size-limit", root);
    const config = configOf(ctx.cwd);
    const text = existsSync(config) ? readFileSync(config, "utf8") : undefined;
    const findings = checks.flatMap((check) => {
      const { name, passed, size, sizeLimit: limit } = check;
      if (
        typeof name !== "string" ||
        (passed !== undefined && typeof passed !== "boolean")
      )
        throw new Error(
          "size-limit output has a check without a name or pass flag: its output format may have changed; refusing to report it.",
        );
      if (passed !== false) return [];
      return [
        finding({
          tool: "size-limit",
          layer: "behavior",
          file: absPosix(ctx.cwd, config),
          line: lineOf(text, new RegExp(escapeRegex(JSON.stringify(name)))),
          col: 1,
          ruleId: "size-limit",
          severity: "error",
          message: `${name} is ${String(size)} B, over its limit${typeof limit === "number" ? ` of ${String(limit)} B` : ""}: make it smaller, or raise the limit in ${basename(config)}`,
          fixable: false,
        }),
      ];
    });
    // Files that do not exist measure 0 bytes, pass, and exit 1 (js-python.md, 1).
    const missing = checks.find((check) => check.size === 0);
    if (raw.exitCode === 1 && missing)
      throw new Error(
        `size-limit found no files for the check ${String(missing.name)}: build first (it measures the built output)`,
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
