import { existsSync } from "node:fs";
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
import { upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, consoleError, finding, parseJsonOutput } from "./base.js";

/** PHPStan's config names; `phpstan.neon` wins over the others (phpstan.org/config-reference). */
const CONFIGS = ["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"];

interface PhpstanMessage {
  message?: unknown;
  line?: unknown;
  identifier?: unknown;
  tip?: unknown;
}

interface PhpstanReport {
  /** Keyed by absolute path. */
  files?: unknown;
  errors?: unknown;
}

/**
 * The block PHPStan appends to stderr when it sees an AI agent's
 * environment (AI_AGENT, CLAUDECODE…): instructions, not a diagnostic
 * (dotnet-ruby-php-elixir.md, 5).
 */
function withoutAgentNotes(stderr: string): string {
  const at = stderr.search(/^Instructions for interpreting errors$/m);
  return at < 0 ? stderr : stderr.slice(0, at);
}

/**
 * PHPStan — static analysis of PHP at the level its config sets: wrong
 * argument and return types, unknown classes and methods, dead branches,
 * each at its line (PHPStan reports no column), every one an error; a file
 * that does not parse masks the rest of it. Runs where the project chose
 * it: a `phpstan.neon`, `phpstan.neon.dist` or `phpstan.dist.neon` in the
 * PHP root or above it, from that folder (PHPStan reads its config only from
 * where it runs), over the paths that config names, when a PHP file
 * changed; or `tools.phpstan.enabled`. Recorded on 2.3.1:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 5.
 */
export const phpstan: ToolAdapter = {
  id: "phpstan",
  layer: "type-check",
  languages: ["php"],
  // Paths named on the command line replace the config's: a changed file
  // the project does not analyse would be analysed.
  fileScoped: false,
  bin: "phpstan",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "2.3.1",
  installHint:
    "brew install phpstan  (or: composer require --dev phpstan/phpstan, then tools.phpstan.bin: vendor/bin/phpstan)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "phpstan.parse",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // shortcut: looks up from the PHP root only; a config below it (a
    // project without composer.json) is not found. Upgrade if one appears.
    const dir = upTo(seed.cwd, env.projectRoot).find((d) =>
      CONFIGS.some((name) => existsSync(join(d, name))),
    );
    // Two PHP roots under one config give the same task: the planner keeps
    // one.
    if (dir) return [{ ...seed, cwd: toPosix(dir) }];
    if (env.toolConfig.configPath !== undefined) return [seed];
    return env.toolConfig.enabled === true
      ? [
          {
            ...seed,
            // With no config and no paths it exits 1, "At least one path
            // must be specified to analyse".
            cannotRun:
              "no phpstan.neon, phpstan.neon.dist or phpstan.dist.neon here or above, so PHPStan has no paths to analyse: add one, or set tools.phpstan.configPath",
          },
        ]
      : [];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--error-format|-b|--generate-baseline|--fix|--watch|--pro)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads PHPStan's JSON report; a baseline or a fix would write into the project"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "analyse",
        "--error-format=json",
        "--no-progress",
        ...(ctx.configPath ? ["-c", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      // 1: errors found, and also a missing path, bad option or bad config.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const stderr = withoutAgentNotes(raw.stderr);
    if (!raw.stdout.trimStart().startsWith("{"))
      throw new Error(
        `phpstan failed: ${consoleError(stderr, /^Note: Using configuration file/) ?? `exit ${raw.exitCode} with no message`}`,
      );
    const report = parseJsonOutput<PhpstanReport>("phpstan", raw, {});
    const files = report.files;
    if (
      files === null ||
      typeof files !== "object" ||
      Array.isArray(files) ||
      !Array.isArray(report.errors)
    )
      throw new Error(
        "phpstan output has no `files` object or `errors` array: its output format may have changed; refusing to report zero findings.",
      );
    const findings: Finding[] = [];
    for (const [path, entry] of Object.entries(
      files as Record<string, { messages?: PhpstanMessage[] } | undefined>,
    )) {
      for (const m of entry?.messages ?? []) {
        if (typeof m.message !== "string" || typeof m.line !== "number")
          throw new Error(
            "phpstan reported an error without a message or line: its output format may have changed; refusing to report it.",
          );
        const identifier =
          typeof m.identifier === "string" ? m.identifier : undefined;
        findings.push(
          finding({
            tool: "phpstan",
            layer: "type-check",
            language: "php",
            file: absPosix(ctx.cwd, path),
            line: m.line,
            col: 1,
            ...(identifier ? { ruleId: identifier } : {}),
            severity: "error",
            message:
              typeof m.tip === "string" ? `${m.message} ${m.tip}` : m.message,
            fixable: false,
            ...(identifier
              ? { url: `https://phpstan.org/error-identifiers/${identifier}` }
              : {}),
          }),
        );
      }
    }
    // Errors tied to no file (an ignore pattern that matched nothing): the
    // config is where they are fixed.
    const config =
      ctx.configPath ??
      CONFIGS.map((name) => join(ctx.cwd, name)).find((path) =>
        existsSync(path),
      ) ??
      join(ctx.cwd, "phpstan.neon");
    for (const error of report.errors)
      findings.push(
        finding({
          tool: "phpstan",
          layer: "type-check",
          file: toPosix(config),
          line: 1,
          col: 1,
          severity: "error",
          message: String(error),
          fixable: false,
        }),
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr,
    };
  },
};
