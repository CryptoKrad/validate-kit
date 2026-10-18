import { existsSync } from "node:fs";
import { join, posix } from "node:path";
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
import { finding, fromRealCwd, parseJsonOutput, toolOptions } from "./base.js";
import {
  changedAny,
  existingPaths,
  kubernetesInputs,
  within,
} from "./schemas-iac.js";

const Options = z
  .object({
    /** Files and folders to lint, relative to the project root. Default ".". */
    paths: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** kube-linter's config names, read from where it runs only (schemas-iac.md, 8). */
const CONFIGS = [".kube-linter.yaml", ".kube-linter.yml"];

/** What kube-linter reports for a file or chart it could not read. */
const LOAD_FAILED = "failed-to-load-object";

interface KubeLinterReport {
  Diagnostic?: { Message?: unknown };
  Check?: unknown;
  Remediation?: unknown;
  Object?: {
    Metadata?: { FilePath?: unknown };
    K8sObject?: {
      Namespace?: unknown;
      Name?: unknown;
      GroupVersionKind?: { Kind?: unknown };
    };
  };
}

interface KubeLinterTask {
  /** The manifests and chart folders to lint, relative to the project root. */
  inputs: string[];
  /** The scope's YAML files under `paths`, relative to the project root. */
  scope: string[];
}

/**
 * Where a file or chart kube-linter could not read went wrong, or nothing
 * for a YAML file that holds no Kubernetes object (a config file), which
 * `--fail-on-invalid-resource` reports too.
 */
function loadFailure(
  path: string,
  message: string,
): { path: string; line: number; col: number; ruleId: string } | undefined {
  if (message.includes("Object 'Kind' is missing")) return undefined;
  // `failed to render: template: app/templates/cm.yaml:4:18: …`, at the chart.
  const render =
    /^failed to render: template: [^/]+\/([^:]+):(\d+):(\d+):/.exec(message);
  if (render?.[1])
    return {
      path: posix.join(path, render[1]),
      line: Number(render[2]),
      col: Number(render[3]),
      ruleId: "render",
    };
  if (message.startsWith("failed to render:"))
    return {
      path: posix.join(path, "Chart.yaml"),
      line: 1,
      col: 1,
      ruleId: "render",
    };
  const yaml = /^failed to decode: yaml: line (\d+):/.exec(message);
  return {
    path,
    line: yaml ? Number(yaml[1]) : 1,
    col: 1,
    ruleId: yaml ? "parse" : "load",
  };
}

/**
 * kube-linter — Kubernetes manifests and Helm charts against best
 * practices: a privileged container, one that may run as root or escalate
 * privileges, a writable root file system, the `latest` image tag, no CPU
 * or memory requests. Each at its file, line 1 (kube-linter gives no line),
 * as an error, naming the object. A chart that does not render, or a
 * manifest that does not parse, is an error at its line too
 * (`--fail-on-invalid-resource`; without it kube-linter skipped the chart
 * and passed). Where the project root holds a `.kube-linter.yaml` or
 * `.kube-linter.yml` (it reads it from where it runs only), or
 * `tools.kube-linter.enabled`; on the scope's manifests and charts under
 * `tools.kube-linter.options.paths` (default the project), never the whole
 * tree. No network. Recorded on 0.8.3:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 8.
 */
export const kubeLinter: ToolAdapter = {
  id: "kube-linter",
  layer: "lint",
  languages: ["yaml"],
  runsAt: "project-root",
  fileScoped: false,
  bin: "kube-linter",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "0.8.3",
  installHint: "brew install kube-linter",
  versionArgs: ["version"],
  adoptedAt: (_root, projectRoot) =>
    CONFIGS.some((name) => existsSync(join(projectRoot, name))),
  // A chart that does not render has none of its templates checked.
  masks: (f) => f.ruleId === "render",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const paths = existingPaths(
      env,
      "tools.kube-linter.options.paths",
      toolOptions(env, "kube-linter", Options).paths ?? ["."],
    );
    const yamlish = (p: string) =>
      (languageForFile(p) === "yaml" || p.endsWith(".tpl")) && within(p, paths);
    if (!changedAny(env, (p) => CONFIGS.includes(p) || yamlish(p))) return [];
    const { files, charts, scope } = kubernetesInputs(env, paths);
    const inputs = [...charts, ...files];
    if (inputs.length === 0) return [];
    const task: KubeLinterTask = { inputs, scope };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(format|output|with-color)(=|$)/.test(arg))
      ? "the kit reads kube-linter's JSON on stdout (and --with-color=false turns colour on)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "lint",
        "--format",
        "json",
        // Deprecated, and still the only way 0.8.3 reports what it skipped.
        "--fail-on-invalid-resource",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(ctx.options as KubeLinterTask).inputs,
      ],
      // 1: lint errors, and every failure too (no JSON then).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const root = parseJsonOutput<{
      Reports?: unknown;
      Summary?: { ChecksStatus?: unknown };
    } | null>("kube-linter", raw, null);
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: (ctx.options as KubeLinterTask).inputs.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    // Exit 0, nothing printed: "Warning: no valid objects found."
    if (root === null) return result([]);
    const status = root.Summary?.ChecksStatus;
    if (status !== "Passed" && status !== "Failed")
      throw new Error(
        `kube-linter output has no Summary.ChecksStatus (${JSON.stringify(status)}): its output format may have changed; refusing to report zero findings.`,
      );
    // Absent or null when nothing failed.
    const reports = (root.Reports ?? []) as KubeLinterReport[];
    if (!Array.isArray(reports))
      throw new Error(
        "kube-linter output has Reports that are not a list: its output format may have changed; refusing to report it.",
      );
    // What it could not load leaves the status at Passed.
    const checked = reports.filter((r) => r.Check !== LOAD_FAILED).length;
    if ((status === "Failed") !== checked > 0)
      throw new Error(
        `kube-linter says its checks ${status.toLowerCase()} but its output holds ${checked} reports of them: its output format may have changed; refusing to report it.`,
      );
    const cwd = toPosix(ctx.cwd);
    const kitPath = fromRealCwd(cwd);
    const scope = new Set((ctx.options as KubeLinterTask).scope);
    const findings: Finding[] = [];
    for (const r of reports) {
      const printed = r.Object?.Metadata?.FilePath;
      const object = r.Object?.K8sObject;
      const message = r.Diagnostic?.Message;
      if (
        typeof printed !== "string" ||
        typeof r.Check !== "string" ||
        typeof message !== "string"
      )
        throw new Error(
          "kube-linter reported a finding without a file, check or message: its output format may have changed; refusing to report it.",
        );
      const path = posix.relative(cwd, kitPath(printed));
      const failure =
        r.Check === LOAD_FAILED ? loadFailure(path, message) : undefined;
      if (r.Check === LOAD_FAILED && !failure) continue;
      const at = failure ?? { path, line: 1, col: 1, ruleId: r.Check };
      // A file the kit's scope leaves out.
      if (!scope.has(at.path) && !scope.has(posix.join(path, "Chart.yaml")))
        continue;
      const kind = object?.GroupVersionKind?.Kind;
      const name = [object?.Namespace, object?.Name]
        .filter(
          (part): part is string => typeof part === "string" && part !== "",
        )
        .join("/");
      findings.push(
        finding({
          tool: "kube-linter",
          layer: "lint",
          language: "yaml",
          file: posix.join(cwd, at.path),
          line: at.line,
          col: at.col,
          ruleId: at.ruleId,
          severity: "error",
          message: failure
            ? `${failure.ruleId === "render" ? "the Helm chart does not render, so none of its templates was checked" : failure.ruleId === "parse" ? "not valid YAML, so kube-linter skipped it" : "kube-linter could not load it"}: ${message}`
            : [
                typeof kind === "string" && name ? `${kind} ${name}: ` : "",
                message.replace(/([^.])$/, "$1."),
                typeof r.Remediation === "string" ? ` ${r.Remediation}` : "",
              ].join(""),
          fixable: false,
        }),
      );
    }
    return result(findings);
  },
};
