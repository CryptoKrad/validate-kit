import { existsSync } from "node:fs";
import { join, posix } from "node:path";
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
import { hexInstalled, toolAdopted, upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray, parseJsonLine } from "./base.js";

interface CredoIssue {
  category?: unknown;
  check?: unknown;
  column?: unknown;
  column_end?: unknown;
  filename?: unknown;
  line_no?: unknown;
  message?: unknown;
}

/**
 * Credo's categories to the kit's (hexdocs.pm/credo, Mix.Tasks.Credo). Each
 * one fails Credo's own run, so readability and consistency, its style
 * categories, gate as warnings, as rubocop's and ruff's style rules do.
 */
const SEVERITY: Record<string, Severity> = {
  warning: "warning",
  design: "warning",
  refactor: "warning",
  readability: "warning",
  consistency: "warning",
};

/** Its exit status: one bit per category that reported an issue. */
const CATEGORY_BITS = Array.from({ length: 31 }, (_, i) => i + 1);

/** mix.exs in `dir` depends on credo (a line that is not a comment). */
const dependsOnCredo = (dir: string) =>
  toolAdopted(dir, dir, { configs: [], mix: "credo" });

/**
 * Credo — Elixir static analysis: likely bugs (an `IO.inspect` left in),
 * design and refactoring hints, and readability, each
 * at its line and column, with `--strict` (its low-priority issues too); a
 * file it cannot parse is an error, since Credo skips it. Runs where the
 * project chose it: its mix.exs, or its umbrella's, depends on `:credo`; on
 * the changed files, from where it is declared. Credo is a project
 * dependency: before `mix deps.get` (Hex, the network), or without Hex, it
 * cannot run, and the kit says so instead of fetching anything. Its first run
 * compiles it into Mix's own `_build/`, as any `mix` command there does.
 * Recorded on 1.7.19:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 8.
 */
export const credo: ToolAdapter = {
  id: "credo",
  layer: "lint",
  languages: ["elixir"],
  bin: "mix",
  // The probe checks that mix runs (Erlang on PATH) and reports no version
  // ("", not Erlang's erts number): credo's is the project dependency's, and
  // `mix credo --version` before `mix deps.get` asks on stdin to install
  // Hex, waiting out the probe's timeout.
  parseVersion: () => "",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "1.7.19",
  installHint:
    'add {:credo, "~> 1.7", only: [:dev, :test], runtime: false} to mix.exs, then mix deps.get  (Erlang on PATH: Homebrew\'s is keg-only)',
  findingExitCodes: CATEGORY_BITS,
  masks: (f) => f.ruleId === "parse",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // An umbrella declares credo in its root mix.exs, and its apps' files
    // are planned from apps/<app>: Credo runs from where it is declared,
    // where its task exists and its .credo.exs is.
    const declared = upTo(seed.cwd, env.projectRoot).find(dependsOnCredo);
    if (declared === undefined && env.toolConfig.enabled !== true) return [];
    const cwd = toPosix(declared ?? seed.cwd);
    const fetched = upTo(cwd, env.projectRoot).some((dir) =>
      existsSync(join(dir, "deps", "credo")),
    );
    // Without Hex, Mix cannot load a Hex dependency at all.
    const cannotRun = !fetched
      ? "credo is not fetched (no deps/credo): run `mix deps.get` first, which needs Hex and the network"
      : !hexInstalled()
        ? "Hex is not installed, so Mix cannot load credo: run `mix local.hex`"
        : undefined;
    return [{ ...seed, cwd, ...(cannotRun ? { cannotRun } : {}) }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(format|mute-exit-status)(=|$)/.test(arg))
      ? "the kit reads Credo's JSON report and its exit status"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "credo",
        "--format",
        "json",
        "--strict",
        ...ctx.extraArgs,
        ...(ctx.files ?? []).map((file) =>
          posix.relative(toPosix(ctx.cwd), toPosix(file)),
        ),
      ],
      // A bit set of categories; 1 is also a crash, 130 a usage error. The
      // JSON tells them apart.
      okExitCodes: "any",
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A cold run prints the deps' compile output in front of the JSON.
    const start = raw.stdout.search(/^\{/m);
    if (start < 0 || raw.exitCode > 31) {
      const lines = `${raw.stderr}\n${raw.stdout}`
        .split("\n")
        .map((line) => line.trim());
      const why =
        lines.find((line) => /^\*\* \((?!EXIT)/.test(line)) ??
        lines.find(Boolean);
      throw new Error(`credo failed: ${why ?? `exit ${raw.exitCode}`}`);
    }
    const issues = findingsArray<CredoIssue>(
      "credo",
      parseJsonLine<unknown>("credo", raw.stdout.slice(start)),
      "issues",
    );
    const findings: Finding[] = issues.map((issue) => {
      const severity =
        typeof issue.category === "string"
          ? SEVERITY[issue.category]
          : undefined;
      if (
        severity === undefined ||
        typeof issue.filename !== "string" ||
        typeof issue.line_no !== "number" ||
        typeof issue.check !== "string" ||
        typeof issue.message !== "string"
      )
        throw new Error(
          `credo reported an issue without a file, line, check, message or known category (${JSON.stringify(issue.category)}): its output format may have changed; refusing to report it.`,
        );
      const column = typeof issue.column === "number" ? issue.column : 1;
      return finding({
        tool: "credo",
        layer: "lint",
        language: "elixir",
        file: absPosix(ctx.cwd, issue.filename),
        line: issue.line_no,
        col: column,
        ...(typeof issue.column_end === "number"
          ? { endLine: issue.line_no, endCol: issue.column_end }
          : {}),
        ruleId: issue.check,
        severity,
        message: issue.message,
        fixable: false,
      });
    });
    // `info: Some source files could not be parsed correctly and are
    // excluded:` then `   1) lib/broken.ex`: not checked, and not an error exit.
    const lines = raw.stderr.split("\n");
    const header = lines.findIndex((line) =>
      line.includes("could not be parsed correctly and are excluded"),
    );
    for (const line of header < 0 ? [] : lines.slice(header + 1)) {
      const path = /^\s+\d+\) (.+)$/.exec(line)?.[1];
      if (path === undefined) {
        if (line.trim()) break;
        continue;
      }
      findings.push(
        finding({
          tool: "credo",
          layer: "lint",
          language: "elixir",
          file: absPosix(ctx.cwd, path.trim()),
          line: 1,
          col: 1,
          ruleId: "parse",
          severity: "error",
          message:
            "Does not parse, so Credo left it unchecked: `mix compile` names the error",
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
