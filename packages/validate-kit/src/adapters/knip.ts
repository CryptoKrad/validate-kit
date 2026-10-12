import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, finding, sarifResults } from "./base.js";

/** knip's config files, in the order it reads them (knip-cli.md, 3). */
const KNIP_CONFIGS = [
  "knip.json",
  "knip.jsonc",
  ".knip.json",
  ".knip.jsonc",
  "knip.ts",
  "knip.js",
  "knip.config.ts",
  "knip.config.js",
];

interface KnipTask {
  /** Files whose findings count (absolute, POSIX): the kit's scope. */
  scope: string[];
}

/**
 * knip — unused files, exports, types and dependencies of a JS/TS project.
 * It has no per-file mode (docs/research/lint-toolchain/knip-cli.md, 4), so
 * it runs on the whole project, in the `verify` tier.
 */
export const knip: ToolAdapter = {
  id: "knip",
  layer: "lint",
  languages: ["ts", "js"],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "knip",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  // The SARIF reporter (knip-cli.md, 7); 6.0.0 changed the JSON shape.
  minVersion: "6.30.0",
  installHint: "pnpm add -D knip",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: KNIP_CONFIGS,
      dep: "knip",
      key: "knip",
    }),

  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const task: KnipTask = { scope: [...env.scopedFiles] };
    // knip resolves every import through the installed dependencies.
    if (!existsSync(join(seed.cwd, "node_modules")))
      return [
        {
          ...seed,
          cannotRun:
            "the dependencies are not installed (no node_modules): knip resolves imports through them",
        },
      ];
    return [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    for (const arg of extraArgs) {
      if (
        /^(--reporter|--preprocessor|-u|--duration|--performance.*|--memory.*|-d|--debug|--trace.*|-w|--watch)(=|$)/.test(
          arg,
        )
      )
        return `${arg} adds text to stdout, which holds the kit's SARIF report`;
      if (
        /^(-f|--fix|--fix-type|--allow-remove-files|-F|--format)(=|$)/.test(arg)
      )
        return `${arg} edits the project; the kit only reports what knip finds`;
      if (arg === "--cache" && !extraArgs.includes("--cache-location"))
        return "--cache writes into node_modules; name a --cache-location";
      if (
        /^(--no-exit-code|--max-issues|--treat-.*-hints-as-errors|-D|--directory)(=|$)/.test(
          arg,
        )
      )
        return `${arg} changes the exit code or the root the kit reads`;
    }
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = ["--reporter", "sarif", "--no-progress"];
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(...ctx.extraArgs);
    return {
      bin: this.bin,
      args,
      // Exit 2 is a config error, whose message is on stderr.
      okExitCodes: [0, 1],
      // Otherwise jiti caches compiled configs in node_modules/.cache.
      env: { JITI_FS_CACHE: "false" },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as KnipTask;
    const scope = new Set(task.scope);
    const findings = sarifResults("knip", raw).flatMap((r) => {
      const location = r.locations?.[0]?.physicalLocation;
      const uri = location?.artifactLocation?.uri;
      if (
        typeof r.ruleId !== "string" ||
        typeof r.message?.text !== "string" ||
        typeof uri !== "string"
      )
        throw new Error(
          "knip output has a result without a rule id, message or file: its output format may have changed; refusing to report it.",
        );
      const file = absPosix(
        ctx.cwd,
        uri.split("/").map(decodeURIComponent).join("/"),
      );
      // The kit's `ignore` (fixtures, generated code) holds for knip too.
      if (!scope.has(file)) return [];
      const region = location?.region;
      return [
        finding({
          tool: "knip",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: region?.startLine ?? 1,
          col: region?.startColumn ?? 1,
          ruleId: r.ruleId.replace(/^knip\//, ""),
          severity: r.level === "warning" ? "warning" : "error",
          message: r.message.text,
          fixable: false,
        }),
      ];
    });
    return {
      findings,
      filesProcessed: task.scope.length,
      fixesApplied: 0,
      // Every issue was outside the kit's scope: clean, not a lost report.
      rawExitCode: findings.length === 0 ? 0 : raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
