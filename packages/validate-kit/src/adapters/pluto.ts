import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseAllDocuments } from "yaml";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import {
  finding,
  findingsArray,
  fromRealCwd,
  parseJsonOutput,
  toolOptions,
} from "./base.js";
import {
  changedAny,
  existingPaths,
  kubernetesInputs,
  stage,
  stagedDir,
  within,
} from "./schemas-iac.js";

const Options = z
  .object({
    /** Folders to search, relative to the project root. Default ".". */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /**
     * The Kubernetes version the manifests must run on. Default v1.33.0:
     * pluto's own default, v1.25.0, called APIs removed since "deprecated".
     */
    targetVersion: z
      .string()
      .regex(/^v\d+\.\d+\.\d+$/, "a version such as v1.33.0")
      .optional(),
  })
  .strict();

const DEFAULT_TARGET = "v1.33.0";

interface PlutoItem {
  name?: unknown;
  filePath?: unknown;
  api?: {
    version?: unknown;
    kind?: unknown;
    "deprecated-in"?: unknown;
    "removed-in"?: unknown;
    "replacement-api"?: unknown;
    "replacement-available-in"?: unknown;
  };
  deprecated?: unknown;
  removed?: unknown;
  replacementAvailable?: unknown;
}

/** A field pluto printed, when it printed one. */
const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

interface PlutoTask {
  /** The manifests to read, relative to the project root. */
  files: string[];
  target: string;
}

/**
 * The manifests that are not valid YAML, which pluto skips without a word:
 * one error each, where the YAML parser stopped.
 */
function unparsed(ctx: ToolContext, files: readonly string[]): Finding[] {
  return files.flatMap((path) => {
    let docs;
    try {
      docs = parseAllDocuments(readFileSync(join(ctx.cwd, path), "utf8"));
    } catch {
      return [];
    }
    const error = (Array.isArray(docs) ? docs : [docs])
      .flatMap((doc) => doc.errors)
      .at(0);
    if (!error) return [];
    const at = error.linePos?.[0];
    return [
      finding({
        tool: "pluto",
        layer: "lint",
        language: "yaml",
        file: posix.join(toPosix(ctx.cwd), path),
        line: at?.line ?? 1,
        col: at?.col ?? 1,
        ruleId: "parse",
        severity: "error",
        message: `not valid YAML, so pluto skipped it: ${error.message.split("\n")[0] ?? "a YAML error"}`,
        fixable: false,
      }),
    ];
  });
}

/**
 * pluto — Kubernetes manifests on an API version that is deprecated (a
 * warning) or removed (an error) in the target Kubernetes version
 * (`tools.pluto.options.targetVersion`, default v1.33.0), with the
 * replacement and when it became available. Each at its file, line 1
 * (pluto gives no line). A manifest that is not valid YAML, which pluto
 * skips without a word, is an error at the line the YAML parser stopped.
 * Opt-in only: `tools.pluto.enabled`, on the scope's manifests under
 * `options.paths` (default the project), copied to a scratch folder: pluto
 * walks a whole folder (67 s on this repository's tree). No network.
 * Recorded on 5.24.4:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 9.
 */
export const pluto: ToolAdapter = {
  id: "pluto",
  layer: "lint",
  languages: ["yaml"],
  runsAt: "project-root",
  fileScoped: false,
  bin: "pluto",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "5.24.4",
  installHint: "brew install pluto",
  versionArgs: ["version"],
  parseVersion: (out) => /Version:(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // Chosen only by tools.pluto.enabled.
  adoptedAt: () => false,

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const options = toolOptions(env, "pluto", Options);
    const paths = existingPaths(
      env,
      "tools.pluto.options.paths",
      options.paths ?? ["."],
    );
    if (
      !changedAny(env, (p) => languageForFile(p) === "yaml" && within(p, paths))
    )
      return [];
    const { files } = kubernetesInputs(env, paths);
    if (files.length === 0) return [];
    const task: PlutoTask = {
      files,
      target: options.targetVersion ?? DEFAULT_TARGET,
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-o|--output|-d|--directory|-r|--only-show-removed|--ignore-deprecations|--ignore-removals|--ignore-unavailable-replacements|-t|--target-versions)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads pluto's JSON of every item it finds, in the files it names, for options.targetVersion"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as PlutoTask;
    return {
      bin: this.bin,
      // From the copy, with `-d .`: given an absolute `-d`, pluto 5.24.4
      // prints its working folder, then `/`, then that path.
      cwd: stage(ctx, task.files),
      args: [
        "detect-files",
        "-d",
        ".",
        "-o",
        "json",
        "-t",
        `k8s=${task.target}`,
        ...ctx.extraArgs,
      ],
      // 2: deprecated; 3: removed; 4: no replacement in the target; 1: a
      // failure (a missing folder, a bad flag).
      okExitCodes: [0, 2, 3, 4],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const root = parseJsonOutput<unknown>("pluto", raw, undefined);
    if (
      root === null ||
      typeof root !== "object" ||
      !("target-versions" in root)
    )
      throw new Error(
        "pluto output has no target-versions: its output format may have changed; refusing to report zero findings.",
      );
    // A clean run has no items key.
    const items = findingsArray<PlutoItem>("pluto", root, "items", {
      absentIsNone: true,
    });
    if (raw.exitCode !== 0 && items.length === 0)
      throw new Error(
        `pluto exited ${raw.exitCode}, which means it found deprecated APIs, but its output holds none: its output format may have changed; refusing to report it.`,
      );
    const task = ctx.options as PlutoTask;
    const staged = stagedDir(ctx);
    const kitPath = fromRealCwd(staged);
    const findings: Finding[] = unparsed(ctx, task.files);
    for (const item of items) {
      const api = item.api;
      if (
        typeof item.filePath !== "string" ||
        typeof api?.version !== "string" ||
        typeof api.kind !== "string" ||
        typeof item.removed !== "boolean"
      )
        throw new Error(
          "pluto reported an item without a file, API version, kind or removed flag: its output format may have changed; refusing to report it.",
        );
      const path = posix.relative(staged, kitPath(item.filePath));
      const name = text(item.name);
      const replacement = text(api["replacement-api"]);
      const since = text(api["replacement-available-in"]);
      const status = item.removed
        ? `removed in Kubernetes ${text(api["removed-in"]) ?? task.target}`
        : `deprecated since Kubernetes ${text(api["deprecated-in"]) ?? task.target}`;
      const move =
        replacement === undefined
          ? ""
          : item.replacementAvailable === true
            ? `: move to ${replacement}${since ? ` (available since ${since})` : ""}`
            : since
              ? `: its replacement ${replacement} is available only from ${since}, after ${task.target}`
              : `: move to ${replacement} (pluto does not know when it became available)`;
      findings.push(
        finding({
          tool: "pluto",
          layer: "lint",
          language: "yaml",
          file: posix.join(toPosix(ctx.cwd), path),
          line: 1,
          col: 1,
          ruleId: item.removed ? "removed" : "deprecated",
          severity: item.removed ? "error" : "warning",
          message: `${api.kind}${name ? ` ${name}` : ""} uses ${api.version}, ${status}${move}`,
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed: task.files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
