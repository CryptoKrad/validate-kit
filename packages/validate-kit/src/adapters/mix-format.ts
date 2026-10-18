import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
import { hexInstalled, toolAdopted, upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, escapeRegex, finding } from "./base.js";

/**
 * One line of mix format's diff: the line in the file as it is, in the
 * formatted one, and the sign (`4   -|`, `  4 +|`, `2 2  |`).
 */
const DIFF = /^\s*(\d+)?\s*(\d+)?\s*([-+ ])\|/;

/**
 * The first line of each run of changed lines in mix format's diff, in the
 * file as it is: a removed line by its own number, an added one after the
 * last unchanged line.
 */
function changedLines(diff: readonly string[]): number[] {
  const lines: number[] = [];
  let last = 0;
  let inRun = false;
  for (const text of diff) {
    const m = DIFF.exec(text);
    if (!m || (m[1] === undefined && m[2] === undefined)) continue;
    const sign = m[3];
    if (sign === " ") {
      last = Number(m[1]);
      inRun = false;
      continue;
    }
    const line = sign === "-" ? Number(m[1]) : last + 1;
    if (!inRun) lines.push(line);
    inRun = true;
    if (sign === "-") last = line;
  }
  return lines;
}

/**
 * mix format — Elixir's formatter, by the project's `.formatter.exs`: each
 * run of lines it would change, at its first line, and a file that does not
 * parse. Runs where the project chose it: a `.formatter.exs` at or above the
 * Mix project, or a step that runs `mix format`; on the changed files (a file
 * outside the formatter's `inputs` is left alone). It needs Erlang on PATH
 * (Homebrew's `erlang` is keg-only). `--fix` runs `mix format`, layout only.
 * Recorded on Elixir 1.20.4:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 7.
 */
export const mixFormat: ToolAdapter = {
  id: "mix-format",
  layer: "format",
  languages: ["elixir"],
  bin: "mix",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.20.4",
  installHint:
    "brew install elixir  (with Homebrew's keg-only erlang, put /opt/homebrew/opt/erlang/bin on PATH)",
  // `mix --version` prints Erlang's banner (erts-17.1.1) first.
  parseVersion: (out) => /Mix (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [".formatter.exs"],
      step: /\bmix\s+format\b/,
    }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // A formatter that imports its deps' rules (`import_deps`, as Phoenix
    // apps do) or loads plugins needs them fetched, and Hex to load them.
    const config =
      env.toolConfig.configPath ?? join(seed.cwd, ".formatter.exs");
    let text = "";
    try {
      text = readFileSync(config, "utf8");
    } catch {
      return [seed];
    }
    if (!/^[^#\n]*\b(?:import_deps|plugins)\s*:/m.test(text)) return [seed];
    const fetched = upTo(seed.cwd, env.projectRoot).some((dir) =>
      existsSync(join(dir, "deps")),
    );
    const cannotRun = !fetched
      ? "its .formatter.exs imports its deps (import_deps or plugins), which are not fetched: run `mix deps.get` first, which needs Hex and the network"
      : !hexInstalled()
        ? "its .formatter.exs imports its deps (import_deps or plugins), and Hex is not installed to load them: run `mix local.hex`"
        : undefined;
    return [cannotRun ? { ...seed, cannotRun } : seed];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(check-formatted|dry-run|no-exit|stdin-filename)(=|$)/.test(arg),
    )
      ? "the kit decides when mix format checks and when it writes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "format",
        ...(ctx.fix ? [] : ["--check-formatted"]),
        ...(ctx.configPath ? ["--dot-formatter", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(ctx.files ?? []).map((file) =>
          posix.relative(toPosix(ctx.cwd), toPosix(file)),
        ),
      ],
      // 1: unformatted, and every failure too (told by stderr).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    if (raw.exitCode === 0) return result([]);
    // Coloured even when stderr is not a terminal, and NO_COLOR does not stop it.
    const lines = stripVTControlCharacters(raw.stderr).split("\n");
    const listed = lines.findIndex(
      (line) => line.trim() === "The following files are not formatted:",
    );
    if (listed >= 0) {
      const findings: Finding[] = [];
      let file: string | undefined;
      let diff: string[] = [];
      const flush = () => {
        if (file === undefined) return;
        const changed = changedLines(diff);
        for (const line of changed.length > 0 ? changed : [1])
          findings.push(
            finding({
              tool: "mix-format",
              layer: "format",
              language: "elixir",
              file,
              line,
              col: 1,
              severity: "warning",
              message: "Not formatted as mix format formats it",
              fixable: true,
            }),
          );
      };
      for (const line of lines.slice(listed + 1)) {
        // Each file is named by its absolute path, then its diff.
        if (posix.isAbsolute(toPosix(line.trim())) && !DIFF.test(line)) {
          flush();
          file = toPosix(line.trim());
          diff = [];
        } else diff.push(line);
      }
      flush();
      if (findings.length > 0) return result(findings);
    }
    // `mix format failed for file: lib/broken.ex`, then the parse error.
    const failed = lines
      .map((line) => /^mix format failed for file: (.+)$/.exec(line)?.[1])
      .find((path) => path !== undefined);
    if (failed !== undefined) {
      const error = lines.find((line) => line.startsWith("** ("));
      const at = new RegExp(`${escapeRegex(failed)}:(\\d+):(\\d+)`).exec(
        error ?? "",
      );
      return result([
        finding({
          tool: "mix-format",
          layer: "format",
          language: "elixir",
          file: absPosix(ctx.cwd, failed),
          line: at ? Number(at[1]) : 1,
          col: at ? Number(at[2]) : 1,
          ruleId: "syntax",
          severity: "error",
          message: `Does not parse, so mix format cannot format it: ${error?.replace(/^\*\* /, "") ?? "a syntax error"}`,
          fixable: false,
        }),
      ]);
    }
    throw new Error(
      `mix format failed: ${lines.find((line) => line.trim())?.trim() ?? `exit ${raw.exitCode}`}`,
    );
  },
};
