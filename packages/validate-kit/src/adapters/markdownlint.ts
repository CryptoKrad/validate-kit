import { posix } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, byConfigFolder, finding } from "./base.js";

/** markdownlint-cli2's config names, looked up from each file's folder up. */
const CONFIGS = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
  ".markdownlint.cjs",
  ".markdownlint.mjs",
];

/** `bad.md:5 error MD012/no-multiple-blanks Multiple consecutive blank lines [Expected: 1; Actual: 2]` */
const PROBLEM = /^(.+?):(\d+)(?::(\d+))? (error|warning) (\S+) (.+)$/;

/**
 * markdownlint-cli2 — Markdown structure and style: heading levels, list
 * markers, blank lines, fenced code without a language, bare URLs. Runs
 * where the project configured it: one of its config files at or above the
 * file, `tools.markdownlint-cli2.enabled` or `.configPath`. Run from the
 * project root (it finds each file's config itself) on the task's files as
 * literal paths, since its arguments are globs. `--fix` applies its own
 * fixes (blank lines and whitespace in the recorded runs). Recorded on
 * 0.23.3: docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 4.
 */
export const markdownlint: ToolAdapter = {
  id: "markdownlint-cli2",
  layer: "lint",
  languages: ["markdown"],
  bin: "markdownlint-cli2",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "0.23.3",
  installHint:
    "brew install markdownlint-cli2  (or: pnpm add -D markdownlint-cli2)",
  findingExitCodes: [1],

  // A path that matches nothing passes: only existing files go in.
  expand(seed, env) {
    const files = byConfigFolder(seed, env, "markdown", CONFIGS).flatMap(
      (task) => task.files ?? [],
    );
    return files.length === 0 ? [] : [{ cwd: seed.cwd, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => arg === "--format" || arg === "--fix")
      ? "--format reads stdin and --fix is the kit's to pass"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("markdownlint-cli2 needs the task's file list");
    const cwd = toPosix(ctx.cwd);
    return {
      bin: this.bin,
      args: [
        // Only the kit's files, not the config's own `globs` as well.
        "--no-globs",
        ...(ctx.fix ? ["--fix"] : []),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        // A leading `:` makes an argument a literal path, not a glob.
        ...files.map((file) => `:${posix.relative(cwd, toPosix(file))}`),
      ],
      // 2: a bad config or a file it cannot read.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // The summary on stdout counts the problems printed on stderr; a config's
    // `noProgress` drops it, and then exit 0 means none.
    const summary = /^Summary: (\d+) issues? in /m.exec(raw.stdout)?.[1];
    const findings: Finding[] = raw.stderr.split(/\r?\n/).flatMap((text) => {
      const m = PROBLEM.exec(text);
      if (!m?.[1] || !m[5] || !m[6]) return [];
      const rule = m[5].split("/")[0] ?? m[5];
      return [
        finding({
          tool: "markdownlint-cli2",
          layer: "lint",
          language: "markdown",
          file: absPosix(ctx.cwd, m[1]),
          line: Number(m[2]),
          col: m[3] ? Number(m[3]) : 1,
          ruleId: rule,
          severity: m[4] === "error" ? "error" : "warning",
          message: m[6],
          fixable: false,
          ...(/^MD\d+$/.test(rule)
            ? {
                url: `https://github.com/DavidAnson/markdownlint/blob/main/doc/${rule.toLowerCase()}.md`,
              }
            : {}),
        }),
      ];
    });
    if (
      summary === undefined
        ? raw.exitCode !== 0 && findings.length === 0
        : findings.length !== Number(summary)
    )
      throw new Error(
        `markdownlint-cli2 ${summary === undefined ? `exited ${raw.exitCode} with no summary (a config's \`noProgress\`) and` : `counted ${summary} issues but printed`} ${findings.length} problems the kit can read: a config's \`outputFormatters\` replaces the output it reads, or the format changed; refusing to report them.`,
      );
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
