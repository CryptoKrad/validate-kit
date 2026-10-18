import { devNull } from "node:os";
import { posix } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  finding,
  findingsArray,
  firstLineOf,
  parseFindings,
} from "./base.js";

interface RubocopFile {
  path?: unknown;
  offenses?: unknown;
}

interface RubocopOffense {
  severity?: unknown;
  message?: unknown;
  cop_name?: unknown;
  corrected?: unknown;
  correctable?: unknown;
  location?: {
    start_line?: unknown;
    start_column?: unknown;
    last_line?: unknown;
    last_column?: unknown;
  };
  correction?: { safe?: unknown };
}

/**
 * rubocop's severities to the kit's (docs.rubocop.org,
 * configuration#severity). Every offense fails rubocop's own run, so its
 * style level (`convention`: Style/, Layout/, Naming/) gates as a warning,
 * as ruff's style rules and the formatters do; only a cop the project set to
 * `Severity: info` does not.
 */
const SEVERITY: Record<string, Severity> = {
  fatal: "error",
  error: "error",
  warning: "warning",
  refactor: "warning",
  convention: "warning",
  info: "info",
};

/**
 * rubocop — the Ruby linter and style checker: bugs (`Lint/` cops, such as a
 * useless assignment), syntax errors (`Lint/Syntax`, which masks the rest of
 * the file) and the style the project's config sets, each at its line and
 * column. Runs where the project chose it: a `.rubocop.yml` at or above the
 * Ruby root, rubocop (or a `rubocop-*` plugin) in the Gemfile, or a step that
 * runs it. A file the config excludes stays excluded when named
 * (`--force-exclusion`). `--fix` is `--autocorrect`, rubocop's safe
 * corrections only (never `-A`), which may still delete a useless
 * assignment. Recorded on 1.92.0:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 3.
 */
export const rubocop: ToolAdapter = {
  id: "rubocop",
  layer: "lint",
  languages: ["ruby"],
  bin: "rubocop",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.92.0",
  installHint:
    "gem install rubocop  (or: brew install rubocop; a Gemfile's binstub: tools.rubocop.bin: bin/rubocop)",
  // `rubocop --version` loads the .rubocop.yml where it runs: one that names
  // a plugin not installed or an unknown cop failed the probe, so the tool
  // was skipped as missing, and the run passed.
  versionArgs: ["--version", "--config", devNull],
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "Lint/Syntax",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [".rubocop.yml"],
      gem: "rubocop(?:-[\\w-]+)?",
      step: /(?:^|[\s;&|"'(/])rubocop(?:\s|$)/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-o|--out|-a|-A|-x|--autocorrect|--autocorrect-all|--fix-layout|-s|--stdin)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads rubocop's JSON on stdout and decides when it corrects (safe corrections only)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("rubocop needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "--format",
        "json",
        // A file the config excludes is checked when named, without it.
        "--force-exclusion",
        ...(ctx.fix ? ["--autocorrect"] : []),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        "--",
        ...files.map((file) => posix.relative(toPosix(ctx.cwd), toPosix(file))),
      ],
      // 2: an error (missing file, bad config, usage), even with JSON on stdout.
      okExitCodes: [0, 1, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 2)
      throw new Error(`rubocop failed: ${firstLineOf(raw.stderr) ?? "exit 2"}`);
    const { items: files } = parseFindings<RubocopFile>(
      "rubocop",
      raw,
      "files",
    );
    const findings = files.flatMap((f) =>
      findingsArray<RubocopOffense>("rubocop", f, "offenses").flatMap((o) => {
        const severity =
          typeof o.severity === "string" ? SEVERITY[o.severity] : undefined;
        const at = o.location;
        if (
          typeof f.path !== "string" ||
          severity === undefined ||
          typeof o.cop_name !== "string" ||
          typeof o.message !== "string" ||
          typeof at?.start_line !== "number" ||
          typeof at.start_column !== "number"
        )
          throw new Error(
            `rubocop reported an offense without a file, position, cop, message or known severity (${JSON.stringify(o.severity)}): its output format may have changed; refusing to report it.`,
          );
        // A fix run reports what it corrected too; the pass after it checks again.
        if (o.corrected === true) return [];
        return [
          finding({
            tool: "rubocop",
            layer: "lint",
            language: "ruby",
            file: absPosix(ctx.cwd, f.path),
            line: at.start_line,
            col: at.start_column,
            ...(typeof at.last_line === "number" &&
            typeof at.last_column === "number"
              ? { endLine: at.last_line, endCol: at.last_column + 1 }
              : {}),
            ruleId: o.cop_name,
            severity,
            message: o.message,
            // What --autocorrect applies (correction.safe, 1.92).
            fixable: o.correctable === true && o.correction?.safe === true,
          }),
        ];
      }),
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
