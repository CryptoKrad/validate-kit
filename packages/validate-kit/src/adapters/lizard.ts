import { writeFileSync } from "node:fs";
import { join, posix } from "node:path";
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
import { absPosix, finding, scratchOf } from "./base.js";

/** `a.ts:1: warning: route has 9 NLOC, 17 CCN, 155 token, 2 PARAM, 9 length, 0 ND` */
const WARNING =
  /^(.+?):(\d+): warning: (.+) has (\d+) NLOC, (\d+) CCN, \d+ token, (\d+) PARAM, \d+ length/;

/** The kit's languages lizard reads (`lizard --help`, -l). */
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|sol)$/;

interface LizardTask {
  /** The files to measure, relative to the project root. */
  files: string[];
}

/**
 * lizard — cyclomatic complexity per function, in every language the kit
 * checks: a function over the bound (CCN 15, lizard's default; `-C N` in
 * `tools.lizard.extraArgs`) is a warning at its first line. It is a ratchet:
 * `validate-kit baseline` records the functions over the bound a project
 * has today, so only a new one (or one more in a file) fails. Where the
 * project chose it: `tools.lizard.enabled`, a `whitelizard.txt` (lizard's
 * own list of functions it forgives), or a step that runs it. Recorded on
 * 1.24.0: docs/research/lint-toolchain/lizard.md.
 */
export const lizard: ToolAdapter = {
  id: "lizard",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "lizard",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  // Before 1.22 it skips or double-counts TS arrow functions (review).
  minVersion: "1.22.0",
  installHint: "uv tool install lizard",
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(root, root, {
        configs: ["whitelizard.txt"],
        step: /(?:^|[\s;&|"'(/])lizard(?:\s|$)/m,
      });
    if (!chosen) return [];
    const top = toPosix(root);
    const changed = env.changedPaths && new Set(env.changedPaths.map(toPosix));
    const files = env.scopedFiles
      .map((file) => posix.relative(top, toPosix(file)))
      .filter((path) => CODE.test(path) && (!changed || changed.has(path)));
    if (files.length === 0) return [];
    const task: LizardTask = { files };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-X|--xml|--csv|-o|--output_file|-H|--html|--checkstyle|--warning-msvs|-i|--ignore_warnings|-w|--warnings_only|-f|--input_file|-L|--length|-a|--arguments|-T|--Threshold)(=|$)/.test(
        arg,
      ),
    )
      ? "the report format, its file, the file list, the exit code and the bounds other than -C are the kit's: it reads -w complexity lines"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // The list goes in a file: a large project's would not fit on a
    // command line.
    const list = join(scratchOf(ctx), "lizard-files.txt");
    writeFileSync(list, `${(ctx.options as LizardTask).files.join("\n")}\n`);
    return {
      bin: this.bin,
      // Only complexity warns: a long or many-parameter function prints the
      // same warning line.
      args: [
        "--warnings_only",
        "--length",
        "1000000",
        "--arguments",
        "1000000",
        ...ctx.extraArgs,
        "-f",
        list,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // lizard exits 0 when it cannot read a file: that file was not measured.
    const unread = /Fail to read source file '([^']+)'/.exec(raw.stderr)?.[1];
    if (unread)
      throw new Error(
        `lizard could not read ${unread}: it measured nothing there`,
      );
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = raw.stdout.split(/\r?\n/).flatMap((line) => {
      const m = WARNING.exec(line.trim());
      if (!m?.[1] || !m[2] || !m[3]) return [];
      const file = absPosix(cwd, toPosix(m[1]));
      return [
        finding({
          tool: "lizard",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: Number(m[2]),
          col: 1,
          ruleId: "ccn",
          severity: "warning",
          message: `${m[3]} has a cyclomatic complexity of ${m[5]} (${m[4]} lines, ${m[6]} parameters): split it, or record it in the baseline`,
          fixable: false,
        }),
      ];
    });
    return {
      findings,
      filesProcessed: (ctx.options as LizardTask).files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
