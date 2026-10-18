import { writeFileSync } from "node:fs";
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
import { firstConfig } from "../detect/adoption.js";
import {
  absPosix,
  finding,
  findingsArray,
  parseFindings,
  scratchOf,
} from "./base.js";

/** Where a project keeps its PMD ruleset, which PMD itself never looks for. */
const RULESETS = ["pmd-ruleset.xml", ".pmd/ruleset.xml"];

interface PmdTask {
  /** The ruleset, absolute. */
  ruleset: string;
}

/** One file of `-f json` (c-zig-jvm.md, 6). */
interface PmdFile {
  filename?: unknown;
  violations?: unknown;
}

interface PmdViolation {
  beginline?: unknown;
  begincolumn?: unknown;
  endline?: unknown;
  endcolumn?: unknown;
  description?: unknown;
  rule?: unknown;
  priority?: unknown;
  externalInfoUrl?: unknown;
}

interface PmdError {
  filename?: unknown;
  message?: unknown;
}

/**
 * PMD — Java static analysis by the project's ruleset: unused code, bug
 * patterns, error-prone and design rules. Where the project has a ruleset:
 * `tools.pmd.configPath`, or a `pmd-ruleset.xml` or `.pmd/ruleset.xml` at
 * or above the Java root. A rule of priority 1 or 2 is an error, the rest
 * warnings; a file PMD cannot parse is an error, and a rule it drops as
 * misconfigured (exit 0) a crash. Verify tier: a JVM per run. Recorded on
 * 7.28.0:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 6.
 */
export const pmd: ToolAdapter = {
  id: "pmd",
  layer: "lint",
  languages: ["java"],
  bin: "pmd",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "7.28.0",
  installHint: "brew install pmd",
  parseVersion: (out) => /^PMD (\d+\.\d+\.\d+)/m.exec(out)?.[1],
  // 4: violations; 5: a file it could not process.
  findingExitCodes: [4, 5],
  masks: (f) => f.ruleId === "processing-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const ruleset =
      env.toolConfig.configPath ??
      firstConfig(seed.cwd, env.projectRoot, RULESETS);
    if (!seed.files?.length) return [];
    if (ruleset === undefined)
      return env.toolConfig.enabled === true
        ? [
            {
              ...seed,
              cannotRun: `no ${RULESETS.join(" or ")} here or above, and no tools.pmd.configPath: PMD needs a ruleset`,
            },
          ]
        : [];
    const task: PmdTask = { ruleset };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-r|--report-file|-z|--relativize-paths-with|-d|--dir|--file-list|-R|--rulesets|--cache|--no-fail-on-violation|--no-fail-on-error)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets PMD's report, its files, its ruleset and its exit codes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Absolute paths: PMD prints each as given, and `-z .` misplaces them.
    const list = join(scratchOf(ctx), "pmd-files.txt");
    writeFileSync(
      list,
      `${(ctx.files ?? []).map((file) => absPosix(ctx.cwd, file)).join("\n")}\n`,
    );
    return {
      bin: this.bin,
      args: [
        "check",
        "-R",
        (ctx.options as PmdTask).ruleset,
        "-f",
        "json",
        "--no-cache",
        "--no-progress",
        ...ctx.extraArgs,
        "--file-list",
        list,
      ],
      // 1: an unusable ruleset or a missing path; 2: usage.
      okExitCodes: [0, 4, 5],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { root, items: files } = parseFindings<PmdFile>("pmd", raw, "files");
    // A rule PMD dropped (`Removed misconfigured rule`, exit 0) never ran.
    const [broken] = findingsArray<{ rule?: unknown; message?: unknown }>(
      "pmd",
      root,
      "configurationErrors",
    );
    if (broken)
      throw new Error(
        `pmd dropped the misconfigured rule ${String(broken.rule)}: ${String(broken.message)}`,
      );
    const findings: Finding[] = [];
    for (const f of files) {
      for (const v of findingsArray<PmdViolation>("pmd", f, "violations")) {
        if (
          typeof f.filename !== "string" ||
          typeof v.beginline !== "number" ||
          typeof v.begincolumn !== "number" ||
          typeof v.rule !== "string" ||
          typeof v.description !== "string" ||
          typeof v.priority !== "number"
        )
          throw new Error(
            "pmd reported a violation without a file, position, rule, description or priority: its output format may have changed; refusing to report it.",
          );
        findings.push(
          finding({
            tool: "pmd",
            layer: "lint",
            language: "java",
            file: absPosix(ctx.cwd, f.filename),
            line: v.beginline,
            col: v.begincolumn,
            ...(typeof v.endline === "number" && typeof v.endcolumn === "number"
              ? { endLine: v.endline, endCol: v.endcolumn }
              : {}),
            ruleId: v.rule,
            // Priority 1 (high) to 5 (low); any of them fails PMD's run.
            severity: v.priority <= 2 ? "error" : "warning",
            message: v.description,
            fixable: false,
            ...(typeof v.externalInfoUrl === "string"
              ? { url: v.externalInfoUrl }
              : {}),
          }),
        );
      }
    }
    for (const e of findingsArray<PmdError>("pmd", root, "processingErrors")) {
      if (typeof e.filename !== "string" || typeof e.message !== "string")
        throw new Error(
          "pmd reported a processing error without a file or message: its output format may have changed; refusing to report it.",
        );
      // `ParseException: ... at line 2, column 11: Encountered "{".`
      const at = /at line (\d+), column (\d+)/.exec(e.message);
      findings.push(
        finding({
          tool: "pmd",
          layer: "lint",
          language: "java",
          file: absPosix(ctx.cwd, e.filename),
          line: Number(at?.[1] ?? 1),
          col: Number(at?.[2] ?? 1),
          ruleId: "processing-error",
          severity: "error",
          message: `PMD could not check this file: ${e.message.split("\n")[0] ?? ""}`,
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
