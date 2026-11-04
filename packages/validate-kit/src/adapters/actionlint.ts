import { existsSync, readdirSync } from "node:fs";
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
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray } from "./base.js";
import { formatChanged } from "./mutation.js";

/** One item of `-format '{{json .}}'` (1.7.12). */
interface Item {
  message?: unknown;
  filepath?: unknown;
  line?: unknown;
  column?: unknown;
  end_column?: unknown;
  kind?: unknown;
}

/** actionlint's own config names (docs/config.md). */
const CONFIGS = [".github/actionlint.yaml", ".github/actionlint.yml"];

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The checks it hands to another tool: its findings keep that tool's weight. */
const EXTERNAL = new Set(["shellcheck", "pyflakes"]);

/** The project's workflow files, relative to the root (POSIX). */
function workflowsOf(root: string): string[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .toSorted()
    .map((name) => `.github/workflows/${name}`);
}

/**
 * actionlint — a GitHub workflow that parses as YAML and fails when it runs:
 * a `needs` naming no job, an expression whose context key is misspelled,
 * a runner label that does not exist,
 * a cron that never fires, an action input it does not take. zizmor audits
 * what a workflow lets an attacker do; this is whether it works. Where the
 * project chose it: its config in .github/, `tools.actionlint.enabled`, or a
 * step that runs it. The workflow files are named on the command line: with
 * none, actionlint reads the git repository's root, which is not always the
 * project's. Recorded on 1.7.12:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const actionlint: ToolAdapter = {
  id: "actionlint",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "actionlint",
  versionArgs: ["-version"],
  parseVersion: (out) => /v?(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "1.7.0",
  installHint:
    "brew install actionlint  (or: go install github.com/rhysd/actionlint/cmd/actionlint@latest)",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: CONFIGS,
        step: /(?:^|[\s;&|"'(/])actionlint(?:\s|$)|rhysd\/actionlint\b/m,
      });
    if (!chosen) return [];
    let files = workflowsOf(root);
    if (env.changedPaths) {
      const changed = new Set(
        env.changedPaths.map(toPosix).filter((path) => WORKFLOW.test(path)),
      );
      files = files.filter((file) => changed.has(file));
    }
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-(?:format|oneline)(=|$)/.test(arg))
      ? "-format and -oneline replace the output the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "-no-color",
        "-format",
        "{{json .}}",
        ...(ctx.configPath ? ["-config-file", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(ctx.files ?? []),
      ],
      // 1: problems found; 2: a bad option; 3: a fatal error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const items = findingsArray<Item>(
      "actionlint",
      JSON.parse(raw.stdout || "null"),
    );
    if (raw.exitCode === 1 && items.length === 0)
      throw formatChanged("actionlint", "exited 1 with no finding in its JSON");
    const findings: Finding[] = items.map((item) => {
      if (
        typeof item.message !== "string" ||
        typeof item.filepath !== "string" ||
        typeof item.line !== "number" ||
        typeof item.column !== "number" ||
        typeof item.kind !== "string"
      )
        throw formatChanged(
          "actionlint",
          "reported a finding without a message, file, position or kind",
        );
      return finding({
        tool: "actionlint",
        layer: "lint",
        file: absPosix(cwd, item.filepath),
        line: item.line,
        col: item.column,
        ...(typeof item.end_column === "number"
          ? { endLine: item.line, endCol: item.end_column }
          : {}),
        ruleId: item.kind,
        severity: EXTERNAL.has(item.kind) ? "warning" : "error",
        message: item.message,
        fixable: false,
        url: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md",
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
