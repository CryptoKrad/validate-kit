import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding, scratchOf, toolOptions } from "./base.js";

/** Where the usual test runners write a report diff-cover reads. */
const REPORTS = [
  "coverage/lcov.info", // vitest/jest (lcov), cargo llvm-cov --lcov
  "lcov.info",
  "coverage/cobertura-coverage.xml", // vitest/jest (cobertura)
  "coverage.xml", // pytest-cov --cov-report=xml, gocover-cobertura
];

const Options = z
  .object({
    /** Coverage reports, relative to the project root. */
    reports: z.array(z.string().min(1)).optional(),
    /** The branch the change is measured against. */
    compareBranch: z.string().min(1).optional(),
  })
  .strict();

interface CoverTask {
  reports: string[];
  compareBranch: string;
  /** The git top-level: diff-cover's paths are relative to it. */
  top: string;
  /** Changed non-test sources under the project root, relative to `top`. */
  sources: string[];
}

/** diff-cover's own flags that decide what it reads or reports. */
const KIT_FLAGS = [
  "--format",
  "--json-report",
  "--html-report",
  "--markdown-report",
  "--fail-under",
  "--quiet",
  "--compare-branch",
  "--diff-file",
  "--diff-range-notation",
  "--ignore-staged",
  "--ignore-unstaged",
  "--config-file",
];

/** A test file: its lines are not in a coverage report. */
const TEST_FILE =
  /(^|\/)(tests?|__tests__)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]*\.py$/;

interface Report {
  src_stats?: Record<string, { violation_lines?: number[] }>;
}

/** The first ref that exists: the branch to measure a change against. */
function baseBranch(root: string): string | undefined {
  // Not @{upstream}: a CI push checkout tracks its own remote copy.
  return ["origin/HEAD", "origin/main", "main"].find(
    (ref) => git(root, ["rev-parse", "--verify", "--quiet", ref]) !== undefined,
  );
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Consecutive lines as ranges: [3, 4, 5, 9] -> [[3, 5], [9, 9]]. */
function runs(lines: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const line of [...lines].toSorted((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  return out;
}

/**
 * diff-cover — the changed lines no test runs, read from the coverage
 * report the project's own tests wrote (lcov, or Cobertura/Clover/JaCoCo
 * XML). The kit does not run the tests: a report older than the newest
 * changed source judges code it never saw, so then the run cannot run
 * (exit 3 under ci). Opt-in (`tools.diff-cover.enabled`, with
 * `options.reports` and `options.compareBranch`), in the `deep` tier
 * (pre-push and CI). Each run of uncovered changed lines is one warning.
 * Recorded on 10.6.0: docs/research/lint-toolchain/diff-cover.md.
 */
export const diffCover: ToolAdapter = {
  id: "diff-cover",
  layer: "behavior",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "diff-cover",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "deep",
  minVersion: "9.0.0",
  installHint: "uv tool install diff-cover",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(root, root, {
        configs: [],
        step: /(?:^|[\s;&|"'(/])diff-cover(?:\s|$)/m,
      });
    if (!chosen) return [];
    const options = toolOptions(env, "diff-cover", Options);
    const cannot = (why: string) => [{ ...seed, cannotRun: why }];
    const named = options.reports ?? REPORTS;
    const present = named.filter((path) => existsSync(resolve(root, path)));
    // A report the project named and the tests did not write is not
    // coverage of nothing.
    const missing = options.reports
      ? named.filter((path) => !present.includes(path))
      : [];
    if (present.length === 0 || missing.length > 0)
      return cannot(
        `no coverage report (${(missing.length > 0 ? missing : named).join(", ")}): run the tests with coverage first`,
      );
    const reports = present.map((path) => resolve(root, path));
    const gitTop = git(root, ["rev-parse", "--show-toplevel"]);
    if (!gitTop)
      return cannot("not in a git work tree: diff-cover reads git diff");
    // git names the real path (/private/var on macOS): the project's place
    // in it, and the top-level spelled as the project root is.
    const here = posix.relative(
      toPosix(realpathSync(gitTop)),
      toPosix(realpathSync(root)),
    );
    const top =
      here === "" ? toPosix(root) : toPosix(root).slice(0, -(here.length + 1));
    const compareBranch = options.compareBranch ?? baseBranch(root);
    if (
      !compareBranch ||
      git(root, ["merge-base", compareBranch, "HEAD"]) === undefined
    )
      return cannot(
        `no merge base with ${compareBranch ?? "origin/HEAD, origin/main or main"}: fetch it (fetch-depth: 0) or set tools.diff-cover.options.compareBranch`,
      );
    // git diff names paths from the top-level; the project may be below it.
    const changed = [
      ...(
        git(root, ["diff", "--name-only", `${compareBranch}...HEAD`]) ?? ""
      ).split("\n"),
      ...(git(root, ["diff", "--name-only", "HEAD"]) ?? "").split("\n"),
    ].filter(
      (path) =>
        path &&
        languageForFile(path) !== undefined &&
        (here === "" || path.startsWith(`${here}/`)),
    );
    // A changed source newer than the oldest report: the report is stale.
    const oldest = Math.min(...reports.map((path) => statSync(path).mtimeMs));
    const stale = changed.find((path) => {
      try {
        return statSync(posix.join(top, path)).mtimeMs > oldest;
      } catch {
        return false;
      }
    });
    if (stale)
      return cannot(
        `the coverage report is older than ${stale}: run the tests with coverage again`,
      );
    const sources = [...new Set(changed)].filter(
      (path) => !TEST_FILE.test(path),
    );
    const task: CoverTask = { reports, compareBranch, top, sources };
    return [{ ...seed, options: task }];
  },

  // argparse takes any unambiguous prefix: `--fail-u` is `--fail-under`.
  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => {
      const name = arg.split("=")[0] ?? "";
      return (
        name === "-q" ||
        name === "-c" ||
        (name.length > 3 &&
          name.startsWith("--") &&
          KIT_FLAGS.some((flag) => flag.startsWith(name)))
      );
    })
      ? "the output format, the report files, --fail-under, the compared branch and the diff are the kit's: it reads the JSON report"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as CoverTask;
    return {
      bin: this.bin,
      args: [
        ...task.reports,
        "--compare-branch",
        task.compareBranch,
        "--format",
        `json:${join(scratchOf(ctx), "diff-cover.json")}`,
        "-q",
        ...ctx.extraArgs,
      ],
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    let report: Report;
    try {
      report = JSON.parse(
        readFileSync(join(scratchOf(ctx), "diff-cover.json"), "utf8"),
      ) as Report;
    } catch {
      throw new Error(
        `diff-cover wrote no report: ${`${raw.stderr}\n${raw.stdout}`.trim().split("\n").at(-1) ?? ""}`,
      );
    }
    const task = ctx.options as CoverTask;
    const byFile = report.src_stats ?? {};
    if (Object.keys(byFile).length === 0 && task.sources.length > 0)
      throw new Error(
        `diff-cover matched none of the ${task.sources.length} changed source file(s) (${task.sources.slice(0, 3).join(", ")}) with the coverage report: its paths must be absolute or relative to ${task.top}`,
      );
    const findings: Finding[] = Object.entries(byFile).flatMap(
      ([file, stats]) =>
        runs(stats.violation_lines ?? []).map(([from, to]) => {
          // diff-cover names files from the git top-level.
          const abs = absPosix(task.top, toPosix(file));
          return finding({
            tool: "diff-cover",
            layer: "behavior",
            language: languageForFile(abs),
            file: abs,
            line: from,
            col: 1,
            ruleId: "uncovered-change",
            severity: "warning",
            message:
              from === to
                ? `line ${from} changed and no test runs it`
                : `lines ${from}-${to} changed and no test runs them`,
            fixable: false,
          });
        }),
    );
    return {
      findings,
      filesProcessed: Object.keys(report.src_stats ?? {}).length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
