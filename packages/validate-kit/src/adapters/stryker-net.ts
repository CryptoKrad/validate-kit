import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "tinyglobby";
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
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, scratchOf, toolOptions } from "./base.js";
import { formatChanged } from "./mutation.js";

/** The mutation-testing-elements report Stryker writes (`-r json`). */
interface Report {
  files?: Record<
    string,
    {
      mutants?: {
        mutatorName?: unknown;
        status?: unknown;
        replacement?: unknown;
        location?: { start?: { line?: unknown; column?: unknown } };
      }[];
    }
  >;
}

const Options = z
  .object({
    /** The project (a .csproj) to mutate, relative to the solution's folder; needed when the solution holds several non-test projects. */
    project: z.string().min(1).optional(),
    /** The mutation score the run must reach (Stryker's --break-at); below it the run fails. */
    breakAt: z.number().min(0).max(100).optional(),
  })
  .strict();

interface Task {
  solution: string;
  project?: string;
  breakAt?: number;
}

const SOLUTION = /\.slnx?$/i;

/** The mutants whose survival is a finding. */
const SURVIVED = new Set(["Survived", "NoCoverage"]);

/** The newest mutation-report.json Stryker wrote under `dir` (`-O`). */
function latestReport(dir: string): string | undefined {
  const reports = globSync("**/reports/mutation-report.json", {
    cwd: dir,
    absolute: true,
  })
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime);
  return reports[0]?.path;
}

/**
 * Stryker.NET — C# mutation testing: each mutant the tests let live, and
 * each line no test covers, is code a change would not be caught in. The
 * kit's `stryker` adapter knows the JavaScript Stryker; this one drives
 * `dotnet stryker`. Where a solution (.sln or .slnx) is and the project
 * chose it: a stryker-config.json, `tools.stryker-net.enabled`, or a step.
 * One task per solution in the `deep` tier (it builds and runs the tests
 * many times); `options.project` names the project to mutate when the
 * solution has several, `options.breakAt` Stryker's own threshold. Each
 * survived or uncovered mutant is a warning at its line, naming the
 * mutator; a breached threshold is an error on the solution. Stryker exits
 * 0 with survivors and 2 below the threshold; the JSON report is read
 * either way. Recorded on 5.0.0 with .NET 10:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const strykerNet: ToolAdapter = {
  id: "stryker-net",
  layer: "mutation",
  languages: ["csharp"],
  bin: "dotnet",
  // `dotnet stryker` has no version flag (`-v` is the project version for
  // its dashboard): the installed tool's version comes from the tool list.
  versionArgs: ["tool", "list", "-g"],
  parseVersion: (out) => /dotnet-stryker\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "4.0.0",
  installHint: "dotnet tool install -g dotnet-stryker",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  runsAt: "project-root",
  optional: true,
  tier: "deep",
  timeoutMs: 1_800_000,
  configFiles: ["stryker-config.json"],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: ["stryker-config.json"],
        step: /(?:^|[\s;&|"'(/])dotnet[\s-]stryker(?:\s|$)/m,
      });
    if (!chosen) return [];
    const options = toolOptions(env, "stryker-net", Options);
    const solutions = globSync(["*.sln", "*.slnx", "*/*.sln", "*/*.slnx"], {
      cwd: root,
      ignore: ["**/node_modules/**", "**/bin/**", "**/obj/**"],
    })
      .map(toPosix)
      .filter((f) => SOLUTION.test(f))
      .toSorted();
    const tasks: TaskSeed[] = [];
    for (const solution of solutions) {
      const task: Task = {
        solution,
        ...(options.project ? { project: options.project } : {}),
        ...(options.breakAt !== undefined ? { breakAt: options.breakAt } : {}),
      };
      tasks.push({ ...seed, cwd: join(root, solution, ".."), options: task });
    }
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-r|--reporter|-s|--solution|-b|--break-at|-o|--open-report)(=|$|:)/.test(
        arg,
      ),
    )
      ? "the reporter, solution and break-at are the kit's (options.project, options.breakAt)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as Task;
    return {
      bin: this.bin,
      args: [
        "stryker",
        "-s",
        task.solution.split("/").at(-1) ?? task.solution,
        ...(task.project ? ["-p", task.project] : []),
        "-r",
        "json",
        ...(task.breakAt !== undefined ? ["-b", String(task.breakAt)] : []),
        "-O",
        scratchOf(ctx),
        ...(ctx.configPath ? ["-f", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      env: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      // 0 with survivors; 2 below --break-at; 1 when it could not mutate.
      okExitCodes: [0, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const task = ctx.options as Task;
    const path = latestReport(scratchOf(ctx));
    if (!path) {
      const why = raw.stdout
        .split(/\r?\n/)
        .find((l) => /failed to mutate|Given path|error/i.test(l));
      throw why
        ? new Error(`dotnet stryker: ${why.trim()}`)
        : formatChanged("dotnet stryker", "wrote no mutation-report.json");
    }
    const report = JSON.parse(readFileSync(path, "utf8")) as Report;
    if (!report.files || typeof report.files !== "object")
      throw formatChanged("dotnet stryker", "a report without files");
    const findings: Finding[] = [];
    for (const [file, entry] of Object.entries(report.files)) {
      for (const m of entry.mutants ?? []) {
        if (
          typeof m.status !== "string" ||
          typeof m.mutatorName !== "string" ||
          typeof m.location?.start?.line !== "number"
        )
          throw formatChanged(
            "dotnet stryker",
            "a mutant without a status, mutator or line",
          );
        if (!SURVIVED.has(m.status)) continue;
        findings.push(
          finding({
            tool: "stryker-net",
            layer: "mutation",
            language: "csharp",
            file: absPosix(cwd, file),
            line: m.location.start.line,
            col:
              typeof m.location.start.column === "number"
                ? m.location.start.column
                : 1,
            ruleId: m.status === "NoCoverage" ? "no-coverage" : "survived",
            severity: "warning",
            message:
              m.status === "NoCoverage"
                ? `no test runs this line (${m.mutatorName})`
                : `a ${m.mutatorName} survived every test: no test fails when this line changes`,
            fixable: false,
          }),
        );
      }
    }
    if (raw.exitCode === 2)
      findings.push(
        finding({
          tool: "stryker-net",
          layer: "mutation",
          language: "csharp",
          file: absPosix(cwd, task.solution.split("/").at(-1) ?? task.solution),
          line: 1,
          col: 1,
          ruleId: "break-at",
          severity: "error",
          message: `the mutation score is below the ${task.breakAt ?? "configured"}% the project requires`,
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
