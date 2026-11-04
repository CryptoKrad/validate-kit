import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
import {
  absPosix,
  finding,
  findingsArray,
  scratchOf,
  toolOptions,
} from "./base.js";
import { formatChanged } from "./mutation.js";

/** One escaped mutant in the GitLab (Code Climate) log. */
interface Issue {
  check_name?: unknown;
  description?: unknown;
  location?: { path?: unknown; lines?: { begin?: unknown } };
}

interface Summary {
  stats?: { msi?: unknown; escapedCount?: unknown };
}

const Options = z
  .object({
    /** The mutation score the run must reach (Infection's --min-msi); below it the run fails. */
    minMsi: z.number().min(0).max(100).optional(),
  })
  .strict();

interface Task {
  minMsi?: number;
}

const CONFIGS = [
  "infection.json5",
  "infection.json",
  "infection.json.dist",
  ".infection.json5",
];

/**
 * Infection — PHP mutation testing: each mutant the tests let live is a
 * line no test checks. The tests must pass first (it runs PHPUnit), and PHP
 * needs a coverage driver (pcov or Xdebug). Where an infection.json5 (or
 * .json) is and the project chose it: that config, Infection in
 * require-dev, `tools.infection.enabled`, or a step. One task per Composer
 * root in the `deep` tier, the project's own vendor/bin copy found first. Each escaped mutant is a warning at its line, naming the mutator;
 * `options.minMsi` adds Infection's own threshold, whose breach is an error
 * on the config. Infection exits 0 with escaped mutants and 1 below a
 * threshold; the GitLab-format log of escaped mutants and the summary it
 * writes for the kit are read either way. Recorded on 0.35.9 with
 * pcov: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const infection: ToolAdapter = {
  id: "infection",
  layer: "mutation",
  languages: ["php"],
  bin: "infection",
  parseVersion: (out) =>
    /Infection.*?(\d+\.\d+\.\d+)/.exec(out)?.[1] ??
    /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.27.0",
  installHint:
    "composer require --dev infection/infection  (and pecl install pcov)",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 1_800_000,
  composerVendor: true,
  configFiles: CONFIGS,
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: CONFIGS,
      composer: "infection/infection",
      step: /(?:^|[\s;&|"'(/])infection(?:\s|$)/m,
    }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const task: Task = toolOptions(env, "infection", Options);
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:--logger-gitlab|--logger-summary-json|--logger-project-root-directory|--min-msi|--min-covered-msi|--no-progress)(=|$)/.test(
        arg,
      ),
    )
      ? "the loggers and --min-msi are the kit's (options.minMsi)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = (ctx.options as Task | undefined) ?? {};
    const scratch = scratchOf(ctx);
    return {
      bin: this.bin,
      args: [
        "--no-progress",
        "--no-interaction",
        `--logger-gitlab=${join(scratch, "infection.gitlab.json")}`,
        `--logger-summary-json=${join(scratch, "infection-summary.json")}`,
        `--logger-project-root-directory=${ctx.cwd}`,
        ...(ctx.configPath ? [`--configuration=${ctx.configPath}`] : []),
        ...(task.minMsi !== undefined ? [`--min-msi=${task.minMsi}`] : []),
        ...ctx.extraArgs,
      ],
      // 1: the threshold was not reached (or the tests fail, or a usage error).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const log = join(scratchOf(ctx), "infection.gitlab.json");
    const summary = join(scratchOf(ctx), "infection-summary.json");
    if (!existsSync(summary)) {
      // No summary: Infection stopped before mutating (failing tests, no
      // coverage driver, a bad option); its own message says which.
      const why =
        raw.stdout.split(/\r?\n/).find((l) => /\[ERROR\]|error:/i.test(l)) ??
        raw.stderr.trim().split("\n")[0];
      throw why
        ? new Error(`infection: ${why.trim()}`)
        : formatChanged("infection", "wrote no summary");
    }
    const issues = existsSync(log)
      ? findingsArray<Issue>("infection", JSON.parse(readFileSync(log, "utf8")))
      : [];
    const findings: Finding[] = issues.map((issue) => {
      const path = issue.location?.path;
      const line = issue.location?.lines?.begin;
      if (
        typeof issue.check_name !== "string" ||
        typeof path !== "string" ||
        typeof line !== "number"
      )
        throw formatChanged(
          "infection",
          "logged a mutant without a mutator, file or line",
        );
      return finding({
        tool: "infection",
        layer: "mutation",
        language: "php",
        file: absPosix(cwd, path),
        line,
        col: 1,
        ruleId: issue.check_name,
        severity: "warning",
        message: `a ${issue.check_name} mutant survived every test: no test fails when this line changes`,
        fixable: false,
      });
    });
    const task = (ctx.options as Task | undefined) ?? {};
    const stats = (JSON.parse(readFileSync(summary, "utf8")) as Summary).stats;
    const msi = stats?.msi;
    if (
      task.minMsi !== undefined &&
      typeof msi === "number" &&
      msi < task.minMsi
    )
      findings.push(
        finding({
          tool: "infection",
          layer: "mutation",
          language: "php",
          file: absPosix(
            cwd,
            ctx.configPath ??
              CONFIGS.find((c) => existsSync(join(ctx.cwd, c))) ??
              "composer.json",
          ),
          line: 1,
          col: 1,
          ruleId: "min-msi",
          severity: "error",
          message: `mutation score ${msi}% is below the ${task.minMsi}% the project requires`,
          fixable: false,
        }),
      );
    if (raw.exitCode === 1 && findings.length === 0)
      throw formatChanged(
        "infection",
        "exited 1 with no escaped mutant and no threshold breach in its logs",
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
