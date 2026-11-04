import { existsSync, readFileSync } from "node:fs";
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
import { absPosix, finding, lineOf } from "./base.js";
import { formatChanged } from "./mutation.js";

/** `3 issues found in ./packages/a/package.json:` (`./` is the workspace itself). */
const FILE = /^\d+ issues? found in (\S+):$/;

/** ` ⨯ error <message> <rule>` or ` ⚠️ warning <message> <rule>`. */
const ISSUE = /^\s*\S+\s+(error|warning)\s+(.*\S)\s+([a-z][a-z-]*)$/;

/** What sherif reads: the workspace's manifests. */
const INPUT = /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml)$/;

/** The root is a workspace: pnpm's file, or `workspaces` in package.json. */
function workspaceAt(root: string): boolean {
  if (existsSync(join(root, "pnpm-workspace.yaml"))) return true;
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown> | null;
    return pkg !== null && typeof pkg === "object" && "workspaces" in pkg;
  } catch {
    return false;
  }
}

/**
 * sherif — a JS workspace's manifests against each other: one dependency at
 * two versions across packages, `@types/*` in `dependencies`, a root that
 * is not private or names no package manager, dependencies out of order.
 * An agent adding a dependency to one package at a different version than
 * the rest is the usual case; knip and npm-package see one package at a
 * time. Where the project chose it: sherif in the root's devDependencies, a
 * `sherif` key in package.json, `tools.sherif.enabled`, or a step. Text
 * output only and no line numbers: a finding sits on the manifest's
 * dependencies line when the rule is about them, else on line 1. `CI=1`
 * keeps its `--fix` off. Recorded on 1.13.0:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const sherif: ToolAdapter = {
  id: "sherif",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "sherif",
  parseVersion: (out) => /sherif (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "1.0.0",
  installHint: "pnpm add -D -w sherif  (or: npx sherif@1.13.0)",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    if (!workspaceAt(root)) return [];
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(root, root, {
        configs: [],
        dep: "sherif",
        key: "sherif",
        step: /(?:^|[\s;&|"'(/])sherif(?:\s|$)|\bsherif@/m,
      });
    if (!chosen) return [];
    if (
      env.changedPaths &&
      !env.changedPaths.some((path) => INPUT.test(toPosix(path)))
    )
      return [];
    return [seed];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--fix$/.test(arg))
      ? "--fix rewrites the manifests"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [...ctx.extraArgs],
      env: { CI: "1" },
      // 1: an error-level issue (or any, with --fail-on-warnings); 2: usage.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    let file: string | undefined;
    let text: string | undefined;
    for (const line of raw.stdout.split(/\r?\n/)) {
      const at = FILE.exec(line);
      if (at) {
        const path = (at[1] ?? "").replace(/^\.\/?/, "");
        file = absPosix(cwd, path === "" ? "package.json" : path);
        try {
          text = readFileSync(file, "utf8");
        } catch {
          text = undefined;
        }
        continue;
      }
      const issue = ISSUE.exec(line);
      if (!issue || !file) continue;
      const [, severity = "error", message = "", ruleId = ""] = issue;
      findings.push(
        finding({
          tool: "sherif",
          layer: "lint",
          file,
          line: /dependenc/i.test(message)
            ? lineOf(text, /"(?:dev|peer|optional)?[dD]ependencies"\s*:/)
            : 1,
          col: 1,
          ruleId,
          severity: severity === "warning" ? "warning" : "error",
          message,
          fixable: false,
        }),
      );
    }
    if (raw.exitCode === 1 && findings.length === 0)
      throw formatChanged(
        "sherif",
        "exited 1 with no issue line in its output",
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
