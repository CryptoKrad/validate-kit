import { existsSync } from "node:fs";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { ConfigError } from "../config/schema.js";
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
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, toolOptions } from "./base.js";

const CrosshairOptions = z
  .object({
    /** The modules to check (`pkg.mod`), importable from `root`. */
    modules: z.array(z.string().min(1)).min(1),
    /**
     * The folder they import from, whose `.venv` runs CrossHair, relative
     * to the project root (a `backend/` with its own environment). Default
     * the project root.
     */
    root: z.string().min(1).optional(),
  })
  .strict();

interface CrosshairTask {
  module: string;
}

/** `<abs>/mod.py:4: error: false when calling double(7) (which returns 0)` */
const LINE = /^(.+?):(\d+): (error|info): (.*)$/;

/** CPU seconds per condition; a project's own `--per_condition_timeout` comes later and wins. */
const PER_CONDITION_TIMEOUT = "10";

/**
 * CrossHair — Python contracts (PEP 316 `pre:`/`post:` docstrings, deal,
 * icontract) checked by symbolic execution: an input that breaks a
 * postcondition, or makes the function raise, is an error at the
 * condition's line, with the call that does it. A condition it could not
 * finish within the timeout passes silently in CrossHair's own exit code;
 * the kit counts them (`--report_all` names each) in one info finding. Only
 * where the project turned it on: `tools.crosshair.enabled` with
 * `options.modules`, one run per module from the project root (or
 * `options.root`), in the `.venv` there (it imports the code). In a
 * changed-file run every module runs when any Python file changed: a
 * module's contracts hold or break with the code it imports. Deep tier.
 * Recorded on 0.0.111:
 * docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 7.
 */
export const crosshair: ToolAdapter = {
  id: "crosshair",
  layer: "formal",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  inputs: [".py"],
  bin: "crosshair",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "deep",
  timeoutMs: 1_200_000,
  minVersion: "0.0.111",
  installHint:
    "uv add --dev crosshair-tool  (or: uv tool install crosshair-tool)",
  // It has no --version; its help proves it runs.
  versionArgs: ["--help"],
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (env.toolConfig.enabled !== true) return [];
    const { modules, root } = toolOptions(env, "crosshair", CrosshairOptions);
    const cwd = posix.join(toPosix(seed.cwd), root ?? ".");
    if (!existsSync(cwd))
      throw new ConfigError(
        `tools.crosshair.options.root: ${root ?? "."} is not a folder of the project`,
      );
    if (env.changedPaths && !env.changedPaths.some((p) => p.endsWith(".py")))
      return [];
    return modules.map((module) => {
      const task: CrosshairTask = { module };
      return { cwd, options: task };
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(report_verbose|report_all)(=|$)/.test(arg))
      ? "the kit reads CrossHair's one-line reports with every condition named (--report_all); --report_verbose replaces them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "check",
        "--report_all",
        "--per_condition_timeout",
        PER_CONDITION_TIMEOUT,
        ...ctx.extraArgs,
        (ctx.options as CrosshairTask).module,
      ],
      // 1: a counterexample. 2: a missing module, a usage error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { module } = ctx.options as CrosshairTask;
    if (/no checkable functions/.test(raw.stderr))
      throw new Error(
        `crosshair found no function with a contract in ${module}: nothing was checked; list the modules that have contracts in tools.crosshair.options.modules`,
      );
    const findings: Finding[] = [];
    const unfinished: { file: string; line: number }[] = [];
    for (const text of stripVTControlCharacters(raw.stdout).split(/\r?\n/)) {
      const m = LINE.exec(text);
      if (!m?.[1] || !m[2] || !m[4]) continue;
      const at = { file: absPosix(ctx.cwd, m[1]), line: Number(m[2]) };
      if (m[3] === "error")
        findings.push(
          finding({
            tool: "crosshair",
            layer: "formal",
            language: "python",
            ...at,
            col: 1,
            ruleId: "counterexample",
            severity: "error",
            message: `${m[4].replace(/^false when/, "postcondition is false when").replace(/:\s+when/, ": when")}: fix the code or the contract`,
            fixable: false,
          }),
        );
      // "Not confirmed." (out of time) and "Unable to meet precondition."
      else if (!m[4].startsWith("Confirmed over all paths"))
        unfinished.push(at);
    }
    const first = unfinished[0];
    if (first)
      findings.push(
        finding({
          tool: "crosshair",
          layer: "formal",
          language: "python",
          ...first,
          col: 1,
          ruleId: "unfinished",
          severity: "info",
          message: `CrossHair could not finish ${String(unfinished.length)} condition${unfinished.length === 1 ? "" : "s"} in ${module} (no counterexample found in the time, or no input met the precondition): they are neither proven nor refuted; raise --per_condition_timeout to go further`,
          fixable: false,
        }),
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
