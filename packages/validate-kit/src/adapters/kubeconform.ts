import { mkdirSync } from "node:fs";
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
import { languageForFile } from "../detect/languages.js";
import {
  absPosix,
  finding,
  findingsArray,
  parseFindings,
  toolOptions,
} from "./base.js";
import { userCacheDir } from "./golangci.js";
import {
  changedAny,
  existingPaths,
  kubernetesInputs,
  within,
} from "./schemas-iac.js";

const Options = z
  .object({
    /** Manifest files and folders, relative to the project root. */
    paths: z.array(z.string().min(1)).min(1),
    /**
     * Where the JSON schemas are (`-schema-location`): a folder template
     * (`schemas/{{.ResourceKind}}{{.KindSuffix}}.json`) reads no network; a
     * URL is fetched once per schema into the user's cache.
     */
    schemaLocation: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
    ]),
  })
  .strict();

interface KubeconformTask {
  /** The scope's manifests under `paths`, relative to the project root. */
  files: string[];
  locations: string[];
}

/**
 * Where kubeconform keeps the schemas it fetched, across runs: a URL
 * `schemaLocation` reads the network once per schema, not on every push.
 */
const CACHE = join(userCacheDir(), "validate-kit", "kubeconform");

interface KubeconformResource {
  filename?: unknown;
  kind?: unknown;
  name?: unknown;
  status?: unknown;
  msg?: unknown;
  validationErrors?: unknown;
}

interface ValidationError {
  path?: unknown;
  msg?: unknown;
}

const STATUSES = new Set([
  "statusValid",
  "statusInvalid",
  "statusError",
  "statusSkipped",
]);

/**
 * kubeconform — Kubernetes manifests checked against the JSON schema of
 * their kind (`-strict`: a field the schema does not have is an error), one
 * finding per wrong field at its file (line 1: kubeconform gives JSON
 * pointers, no lines), and a resource it could not check (no schema for the
 * kind, YAML that does not parse) as an error. Opt-in only, since by
 * default it fetches schemas from GitHub: `tools.kubeconform.enabled` with
 * `options.paths` and `options.schemaLocation`. It checks the scope's
 * manifests under `paths` (YAML holding a Kubernetes object, outside Helm
 * charts, which it cannot render), never node_modules or config files.
 * Schemas it fetches from a URL location are kept in the user's cache, so
 * the network is read once per schema (the first push after adding a kind
 * fetches it): deep tier (`--profile ci`). Recorded on 0.8.0:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 7.
 */
export const kubeconform: ToolAdapter = {
  id: "kubeconform",
  layer: "lint",
  languages: ["yaml"],
  runsAt: "project-root",
  fileScoped: false,
  bin: "kubeconform",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "deep",
  minVersion: "0.8.0",
  installHint: "brew install kubeconform",
  versionArgs: ["-v"],
  // Chosen only by tools.kubeconform.enabled.
  adoptedAt: () => false,
  // 1: invalid resources, or resources it could not check (in the JSON).
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const options = toolOptions(env, "kubeconform", Options);
    const paths = existingPaths(
      env,
      "tools.kubeconform.options.paths",
      options.paths,
    );
    if (
      !changedAny(env, (p) => languageForFile(p) === "yaml" && within(p, paths))
    )
      return [];
    const { files } = kubernetesInputs(env, paths);
    if (files.length === 0) return [];
    const locations = [options.schemaLocation].flat();
    const task: KubeconformTask = { files, locations };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--?(output|summary|verbose|cache|schema-location)(=|$)/.test(arg),
    )
      ? "the kit reads kubeconform's JSON summary and sets the schema location and cache"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as KubeconformTask;
    mkdirSync(CACHE, { recursive: true });
    return {
      bin: this.bin,
      args: [
        "-output",
        "json",
        "-strict",
        "-summary",
        ...task.locations.flatMap((location) => ["-schema-location", location]),
        "-cache",
        CACHE,
        ...ctx.extraArgs,
        ...task.files,
      ],
      // 1: invalid or unchecked resources, and a bad flag (no JSON then).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items } = parseFindings<KubeconformResource>(
      "kubeconform",
      raw,
      "resources",
    );
    const findings: Finding[] = [];
    for (const r of items) {
      if (
        typeof r.filename !== "string" ||
        typeof r.status !== "string" ||
        !STATUSES.has(r.status)
      )
        throw new Error(
          `kubeconform reported a resource without a file or known status (${JSON.stringify(r.status)}): its output format may have changed; refusing to report it.`,
        );
      const file = absPosix(ctx.cwd, r.filename);
      const what = [r.kind, r.name]
        .filter(
          (part): part is string => typeof part === "string" && part !== "",
        )
        .join(" ");
      const at = (ruleId: string, message: string) =>
        finding({
          tool: "kubeconform",
          layer: "lint",
          language: "yaml",
          file,
          line: 1,
          col: 1,
          ruleId,
          severity: "error",
          message: `${what ? `${what}: ` : ""}${message}`,
          fixable: false,
        });
      if (r.status === "statusError")
        findings.push(
          at(
            "not-validated",
            `not checked: ${typeof r.msg === "string" ? r.msg : "no reason given"}`,
          ),
        );
      if (r.status !== "statusInvalid") continue;
      // Their order varies between runs (schemas-iac.md, 7).
      const errors = findingsArray<ValidationError>(
        "kubeconform",
        r.validationErrors,
      ).toSorted((a, b) => String(a.path).localeCompare(String(b.path)));
      if (errors.length === 0)
        throw new Error(
          "kubeconform reported an invalid resource without its validation errors: its output format may have changed; refusing to report it.",
        );
      for (const e of errors)
        findings.push(
          at(
            "schema",
            `${typeof e.path === "string" ? e.path : "?"}: ${typeof e.msg === "string" ? e.msg : "invalid"}`,
          ),
        );
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
