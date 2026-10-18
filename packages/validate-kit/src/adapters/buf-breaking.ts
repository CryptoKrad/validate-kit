import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
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
import { gitSync, mainBase } from "../detect/git.js";
import { toPosix } from "../detect/languages.js";
import { finding } from "./base.js";
import { bufAdopted, bufConfigIn, bufFindings, depsMissing } from "./buf.js";
import { NOTHING } from "./native.js";
import { NO_BASE } from "./schemas-iac.js";

interface BreakingTask {
  /** The module to compare, relative to where buf runs ("." for all of it). */
  module: string;
  /** buf's `--against` input: the repository at the base, at that module. */
  against?: string;
  /** Why nothing is compared, when nothing is. */
  skip?: string;
}

/**
 * The module folders a v2 `buf.yaml` in `dir` lists, or "." for a v1
 * module or a v2 one without `modules:`. buf compares a workspace image by
 * image and fails ("input contained 2 images, whereas against contained 1")
 * when a module was added since the base, so each is compared on its own.
 */
function modulesIn(dir: string): string[] {
  let config: unknown;
  try {
    config = parseYaml(readFileSync(join(dir, "buf.yaml"), "utf8"));
  } catch {
    return ["."];
  }
  const modules = (config as { modules?: { path?: unknown }[] } | null)
    ?.modules;
  const paths = Array.isArray(modules)
    ? modules
        .map((m) => m.path)
        .filter((path): path is string => typeof path === "string")
    : [];
  return paths.length === 0 ? ["."] : paths.map((p) => posix.normalize(p));
}

/**
 * buf breaking — a change to the Protobuf API that breaks its clients (a
 * file, field, message or enum value deleted, a type or number changed),
 * by the `breaking:` rules of the project's `buf.yaml`, against the main
 * branch at its merge base with HEAD (origin's default branch, or the
 * trusted ref), one module at a time. buf clones that commit from the local
 * repository: no network (a module whose `deps` are not cached is not run).
 * Where buf lint runs, in the deep tier (`--profile ci`); with no main
 * branch, or for a module the main branch does not have yet, an info
 * finding says nothing was compared. Recorded on 1.73.0:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 1.
 */
export const bufBreaking: ToolAdapter = {
  id: "buf-breaking",
  layer: "lint",
  languages: ["proto"],
  bin: "buf",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "deep",
  // A deleted file breaks clients too: it reads the whole module.
  fileScoped: false,
  minVersion: "1.73.0",
  installHint: "brew install buf",
  adoptedAt: bufAdopted,
  findingExitCodes: [100],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const cannotRun = depsMissing(seed.cwd);
    if (cannotRun) return [{ ...seed, cannotRun }];
    const base = mainBase(env.projectRoot, env.trusted?.commit);
    const top = gitSync(seed.cwd, ["rev-parse", "--show-toplevel"])?.trim();
    const prefix = (
      gitSync(seed.cwd, ["rev-parse", "--show-prefix"]) ?? ""
    ).trim();
    return modulesIn(seed.cwd).map((module) => {
      const subdir = posix.join(prefix, module).replace(/\/$/, "");
      const task: BreakingTask = !base
        ? { module, skip: NO_BASE }
        : // A module the main branch does not have yet has no clients to break.
          gitSync(seed.cwd, [
              "cat-file",
              "-e",
              `${base}:./${module === "." ? "" : module}`,
            ]) === undefined
          ? {
              module,
              skip: `${module === "." ? "this module" : `module ${module}`} is not on the main branch (${base.slice(0, 12)}) yet: nothing to compare`,
            }
          : {
              module,
              against: `${toPosix(top ?? seed.cwd)}/.git#ref=${base}${subdir && subdir !== "." ? `,subdir=${subdir}` : ""}`,
            };
      // A whole-module tool's seed is its folder alone.
      return { cwd: seed.cwd, options: task };
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(error-format|against)(=|$)/.test(arg))
      ? "the kit reads buf's JSON lines and sets what it compares against"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as BreakingTask;
    if (!task.against) return NOTHING;
    return {
      bin: this.bin,
      args: [
        "breaking",
        ...(task.module === "." ? [] : [task.module]),
        "--against",
        task.against,
        "--error-format=json",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      // 1: a failure (a ref git cannot clone, a bad config), on stderr.
      okExitCodes: [0, 100],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as BreakingTask;
    const findings = task.skip
      ? [
          finding({
            tool: "buf-breaking",
            layer: "lint",
            file: bufConfigIn(ctx.cwd),
            line: 1,
            col: 1,
            ruleId: "not-compared",
            severity: "info",
            message: task.skip,
            fixable: false,
          }),
        ]
      : bufFindings("buf-breaking", raw, ctx);
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
