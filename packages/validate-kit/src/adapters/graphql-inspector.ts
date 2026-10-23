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
import { gitSync, inTree, mainBase, noBase } from "../detect/git.js";
import { absPosix, finding, toolOptions } from "./base.js";
import { NOTHING } from "./native.js";
import { changedAny, existingPaths } from "./schemas-iac.js";

const Options = z
  .object({
    /** The schema file, relative to the project root. */
    schema: z.string().min(1).optional(),
  })
  .strict();

interface DiffTask {
  schema: string;
  /** `git:<base>:<path from the repository's top>`, the schema at the base. */
  old?: string;
  /** Why nothing is compared, when nothing is. */
  skip?: string;
}

/** `[log] ✖  Field email was removed from object type User` */
const CHANGE = /^(?:\[log\]\s+)?([✖⚠✔])\s+(.+)$/u;

/** The verdict line of a run that found breaking changes. */
const BREAKING = /^\[error\] Detected (\d+) breaking changes?$/;

/**
 * graphql-inspector diff — a change to the GraphQL schema that breaks its
 * clients (a field or type removed, an argument made required), against the
 * schema on the main branch at its merge base with HEAD (origin's default
 * branch, or the trusted ref), read from the local repository: no network.
 * A breaking change is an error; a dangerous one (an enum value added) is
 * info, since graphql-inspector itself passes it. Only where
 * `tools.graphql-inspector.options.schema` names the schema file; in a
 * changed-file run, only when that file changed. It has no file positions:
 * findings are at the schema's first line. Recorded on 7.0.1:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 4.
 */
export const graphqlInspector: ToolAdapter = {
  id: "graphql-inspector",
  layer: "lint",
  languages: ["graphql"],
  runsAt: "project-root",
  fileScoped: false,
  bin: "graphql-inspector",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "7.0.1",
  installHint:
    "brew install graphql-inspector  (or: pnpm add -D @graphql-inspector/cli)",
  // `--version` prints "unknown" (schemas-iac.md, 4).
  parseVersion: () => undefined,

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const named = toolOptions(env, "graphql-inspector", Options).schema;
    if (named === undefined) return [];
    const [schema = named] = existingPaths(
      env,
      "tools.graphql-inspector.options.schema",
      [named],
    );
    if (!changedAny(env, (path) => path === schema)) return [];
    const base = mainBase(env.projectRoot, env.trusted?.commit);
    // No base compares nothing: under `ci` that is an incomplete run, never
    // a pass.
    if (!base) return [{ ...seed, cannotRun: noBase(env.trusted?.commit) }];
    // The `git:` loader runs `git show`, whose path is from the top.
    const old = `${(gitSync(env.projectRoot, ["rev-parse", "--show-prefix"]) ?? "").trim()}${schema}`;
    // Only a schema the base surely lacks is new; when git cannot tell, the
    // diff runs and fails loudly.
    const task: DiffTask =
      inTree(env.projectRoot, base, schema) === false
        ? {
            schema,
            skip: `the schema is not on the main branch (${base.slice(0, 12)}) yet: nothing to compare`,
          }
        : { schema, old: `git:${base}:${old}` };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--onComplete(=|$)/.test(arg))
      ? "--onComplete replaces the report the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as DiffTask;
    if (!task.old) return NOTHING;
    return {
      bin: this.bin,
      args: ["diff", task.old, task.schema, ...ctx.extraArgs],
      env: { NO_COLOR: "1" },
      // 1: breaking changes, and every failure too (the output tells which).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as DiffTask;
    const file = absPosix(ctx.cwd, task.schema);
    const at = (
      ruleId: string,
      severity: Finding["severity"],
      message: string,
    ): Finding =>
      finding({
        tool: "graphql-inspector",
        layer: "lint",
        language: "graphql",
        file,
        line: 1,
        col: 1,
        ruleId,
        severity,
        message,
        fixable: false,
      });
    if (task.skip)
      return {
        findings: [at("not-compared", "info", task.skip)],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    const lines = raw.stdout.split(/\r?\n/).map((line) => line.trim());
    const findings: Finding[] = [];
    for (const line of lines) {
      const m = CHANGE.exec(line);
      if (!m?.[2] || m[1] === "✔") continue;
      findings.push(
        m[1] === "✖"
          ? at("breaking", "error", `breaking change: ${m[2]}`)
          : at(
              "dangerous",
              "info",
              `dangerous change (clients may handle it wrongly): ${m[2]}`,
            ),
      );
    }
    if (raw.exitCode === 1) {
      // Exit 1 is also every load error: only the verdict line tells.
      const verdict = lines.map((line) => BREAKING.exec(line)).find(Boolean);
      const breaking = findings.filter((f) => f.severity === "error").length;
      if (!verdict || Number(verdict[1]) !== breaking)
        throw new Error(
          `graphql-inspector diff failed: ${lines.find((line) => line.startsWith("[error]")) ?? raw.stderr.trim().split("\n")[0] ?? "no message"}`,
        );
    }
    return {
      findings,
      filesProcessed: 1,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
