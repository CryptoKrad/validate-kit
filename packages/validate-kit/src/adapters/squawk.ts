import { posix } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, parseFindings } from "./base.js";

/** One squawk violation (docs/research/lint-toolchain/squawk-cli.md, 1). */
interface SquawkViolation {
  file: string;
  line: number;
  column: number;
  line_end: number;
  column_end: number;
  rule_name: string;
  message: string;
  level: string;
}

/**
 * A migration that runs forward: a `.sql` file under a `migrations` or
 * `migration` folder (below the project root, whatever folder holds it), not
 * a down migration, whose whole purpose is dropping (squawk-cli.md, 4).
 * Views, seeds and other dialects' SQL only add noise.
 */
export function isMigration(file: string, root: string): boolean {
  const parts = posix.relative(toPosix(root), toPosix(file)).split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.slice(0, -1).some((dir) => /^migrations?$/i.test(dir)) &&
    !/(^|\.)down\.sql$/i.test(name)
  );
}

/** squawk reads each path as a glob: match it literally (squawk-cli.md, 4). */
function literal(path: string): string {
  return path.replace(/[[\]*?]/g, (c) => `[${c}]`);
}

/** squawk — PostgreSQL migration linter: locks, rewrites, unsafe DDL. */
export const squawk: ToolAdapter = {
  id: "squawk",
  layer: "lint",
  languages: ["sql"],
  bin: "squawk",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  // 2.20–2.56 corrupt the JSON when GITHUB_ACTIONS is set (squawk-cli.md, 6).
  minVersion: "2.57.0",
  installHint: "pnpm add -D squawk-cli  (or: pip install squawk-cli)",
  parseVersion: (out) => /^squawk (\d+\.\d+\.\d+)/m.exec(out)?.[1],
  // Its rules are about Postgres locking, and nothing in a .sql file names
  // its dialect: only where the repository chose it.
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [".squawk.toml"],
      dep: "squawk-cli",
      pyproject: true,
      step: /\bsquawk\b/,
    }),

  findingExitCodes: [1],
  // A file that does not parse gets no rule findings.
  masks: (f) => f.ruleId === "syntax-error",

  expand(seed) {
    const files =
      seed.files?.filter((file) => isMigration(file, seed.cwd)) ?? [];
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--(reporter|debug)(=|$)/.test(arg)))
      return "the kit reads squawk's JSON report; --reporter and --debug change it";
    if (
      extraArgs.some((arg) =>
        /^--(stdin-filepath|no-error-on-unmatched-pattern)(=|$)/.test(arg),
      )
    )
      return "squawk would read stdin, which the kit does not give it";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    // No paths makes squawk read stdin, which never ends under the kit.
    if (files.length === 0)
      throw new Error("squawk needs the task's file list");
    const args = ["--reporter", "json"];
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(
      ...ctx.extraArgs,
      "--",
      ...files.map((file) =>
        literal(posix.relative(toPosix(ctx.cwd), toPosix(file))),
      ),
    );
    return {
      bin: this.bin,
      args,
      okExitCodes: [0, 1],
      env: { SQUAWK_DISABLE_GITHUB_ANNOTATIONS: "1" },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Every file left out by the project's `excluded_paths` (squawk #363).
    if (
      raw.exitCode === 1 &&
      raw.stdout.trim() === "" &&
      raw.stderr.startsWith("Failed to find files for provided patterns")
    )
      return {
        findings: [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: 0,
        stderr: raw.stderr,
      };
    const { items } = parseFindings<SquawkViolation>("squawk", raw);
    const findings = items.map((v) => {
      if (
        typeof v.file !== "string" ||
        typeof v.line !== "number" ||
        typeof v.column !== "number" ||
        typeof v.line_end !== "number" ||
        typeof v.column_end !== "number" ||
        typeof v.rule_name !== "string" ||
        typeof v.message !== "string" ||
        (v.level !== "Warning" && v.level !== "Error")
      )
        throw new Error(
          `squawk output has a violation without a file, 0-based position, rule, message or known level (${JSON.stringify(v.level)}): its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "squawk",
        layer: "lint",
        language: "sql",
        file: absPosix(ctx.cwd, v.file),
        // 0-based, and columns count bytes (equal to characters in ASCII).
        line: v.line + 1,
        col: v.column + 1,
        endLine: v.line_end + 1,
        endCol: v.column_end + 1,
        ruleId: v.rule_name,
        // Both levels make squawk exit 1.
        severity: v.level === "Error" ? "error" : "warning",
        message: v.message,
        fixable: false,
        ...(v.rule_name === "unused-ignore"
          ? {}
          : {
              url: `https://squawkhq.com/docs/${v.rule_name === "prefer-timestamp-tz" ? "prefer-timestamptz" : v.rule_name}`,
            }),
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
