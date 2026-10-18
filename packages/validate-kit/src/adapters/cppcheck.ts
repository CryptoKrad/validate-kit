import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { compileDb, dbEntries } from "./c-family.js";

/**
 * The fields the kit reads, tab-separated (c-zig-jvm.md, 3:
 * `finding-template`). Not SARIF: cppcheck's SARIF says `error` for every
 * result, its warnings too; the text keeps the severity.
 */
const TEMPLATE =
  "{file}\\t{line}\\t{column}\\t{severity}\\t{id}\\t{cwe}\\t{message}";

/**
 * cppcheck's severities. `style` shows only where the project turns it on
 * (`--enable=style`), and then fails cppcheck's own run; `information` is
 * about the run, not the code.
 */
const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  portability: "warning",
  performance: "warning",
  style: "warning",
  information: "info",
};

interface CppcheckTask {
  /** The database folder, when the task's files are its entries. */
  db?: string;
}

/**
 * cppcheck — C and C++ bug finding (leaks, null dereferences, out-of-bounds
 * access, undefined behaviour) with few false positives. Where the project
 * chose it: `tools.cppcheck.enabled` or a step that runs it (it reads no
 * config file of its own). Files a `compile_commands.json` lists (found as
 * clang-tidy finds it, or `options.compileCommands`) are checked through it
 * (`--project`, with their include paths and defines), the rest and headers
 * by name; `// cppcheck-suppress` comments hold. One run per changed set, so
 * a cross-file result needs a full run. Recorded on 2.22.0:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 3.
 */
export const cppcheck: ToolAdapter = {
  id: "cppcheck",
  layer: "lint",
  languages: ["c", "cpp"],
  bin: "cppcheck",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "2.22.0",
  installHint: "brew install cppcheck",
  parseVersion: (out) => /Cppcheck (\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1],
  // 3, the kit's --error-exitcode: findings. Not 1, which is also cppcheck's
  // own exit for a bad flag or a missing path.
  findingExitCodes: [3],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(seed.cwd, env.projectRoot, {
        configs: [],
        step: /(?:^|[\s;&|"'(/])cppcheck(?:\s|$)/m,
      });
    const files = seed.files ?? [];
    if (!chosen || files.length === 0) return [];
    const db = compileDb(seed.cwd, env, "cppcheck");
    // A file the database does not list (new since it was written) fails
    // its --file-filter run: those go by name.
    const listed = new Set(
      db === undefined ? [] : dbEntries(db).map((entry) => entry.file),
    );
    const inDb = files.filter((file) => listed.has(file));
    const rest = files.filter((file) => !listed.has(file));
    const tasks: TaskSeed[] = [];
    if (db !== undefined && inDb.length > 0)
      tasks.push({ ...seed, files: inDb, options: { db } });
    if (rest.length > 0) tasks.push({ ...seed, files: rest, options: {} });
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(template|output-format|output-file|xml|xml-version|error-exitcode|project|file-list|file-filter|plist-output)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets cppcheck's output, its exit code and the files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("cppcheck needs the task's file list");
    const { db } = ctx.options as CppcheckTask;
    return {
      bin: this.bin,
      args: [
        "-q",
        // The project's `// cppcheck-suppress <id>` comments.
        "--inline-suppr",
        `--template=${TEMPLATE}`,
        "--error-exitcode=3",
        ...ctx.extraArgs,
        // --project takes no file arguments: it narrows to them by filter.
        ...(db
          ? [
              `--project=${join(db, "compile_commands.json")}`,
              ...files.map((file) => `--file-filter=${file}`),
            ]
          : files),
      ],
      okExitCodes: [0, 3],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [path, row, column, level, id, , ...text] = line.split("\t");
      const severity = level === undefined ? undefined : SEVERITY[level];
      if (!path || !id || severity === undefined || text.length === 0)
        throw new Error(
          `cppcheck printed a line that is not the kit's template (${JSON.stringify(line.slice(0, 120))}): its output format may have changed; refusing to report it.`,
        );
      // The count of active checkers, not a problem.
      if (id === "checkersReport") continue;
      // `nofile`: about the run (an unmatched suppression), not a file.
      const file =
        path === "nofile" ? toPosix(ctx.cwd) : absPosix(ctx.cwd, path);
      findings.push(
        finding({
          tool: "cppcheck",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: Number(row),
          col: Number(column),
          ruleId: id,
          severity,
          message: text.join("\t"),
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
