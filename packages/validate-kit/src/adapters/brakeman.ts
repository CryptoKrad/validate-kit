import { existsSync } from "node:fs";
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
import { isUnder, languageForFile, toPosix } from "../detect/languages.js";
import {
  absPosix,
  finding,
  findingsArray,
  firstLineOf,
  parseFindings,
} from "./base.js";

/**
 * What a Rails app that chose Brakeman holds besides the gem: its options,
 * its list of accepted warnings, or a binstub (brakemanscanner.org/docs/options).
 */
const CONFIGS = [
  "config/brakeman.yml",
  "config/brakeman.ignore",
  "bin/brakeman",
];

interface BrakemanWarning {
  warning_type?: unknown;
  check_name?: unknown;
  message?: unknown;
  file?: unknown;
  line?: unknown;
  link?: unknown;
  user_input?: unknown;
  confidence?: unknown;
}

interface BrakemanError {
  error?: unknown;
}

/** `app/models/broken.rb:2 :: parse error on value "$" ($end) …` */
const PARSE_ERROR = /^(.+?):(\d+) :: (.+)$/s;

/**
 * Brakeman — security scan of a Rails app: SQL injection, cross-site
 * scripting, command injection, mass assignment, unsafe redirects and the
 * rest of its 79 checks, each at its file and line (it prints no column),
 * High and Medium confidence as errors, Weak as warnings; a file it cannot
 * parse is an error too, since nothing in it was checked. Runs on each Rails
 * app in scope (a `config/application.rb` beside a Gemfile naming rails)
 * that chose it: brakeman in its Gemfile, a `config/brakeman.yml` or
 * `config/brakeman.ignore`, a `bin/brakeman`, a step that runs it, or
 * `tools.brakeman.enabled`; whenever a file in the app changed, templates
 * included. Warnings the ignore file lists stay ignored. Offline, writes
 * nothing.
 * Recorded on 8.1.0:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 4.
 */
export const brakeman: ToolAdapter = {
  id: "brakeman",
  layer: "security",
  // It reads the app's templates as well as its Ruby: a change to either
  // runs it, which a language's file list would not do.
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "brakeman",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "8.1.0",
  installHint:
    "gem install --user-install brakeman  (its bin, ~/.gem/ruby/<version>/bin, is not on PATH: add it, or set tools.brakeman.bin)",
  parseVersion: (out) => /brakeman (\d+\.\d+\.\d+)/.exec(out)?.[1],
  // 3: warnings found; 7: errors (a file it could not parse) and no warning.
  findingExitCodes: [3, 7],
  masks: (f) => f.ruleId === "parse-error",

  expand(_seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const top = toPosix(env.projectRoot);
    const changed = env.changedPaths?.map((path) =>
      posix.join(top, toPosix(path)),
    );
    const apps = new Set(
      env.scopedFiles
        .filter((file) => posix.basename(file) === "Gemfile")
        .map((file) => posix.dirname(toPosix(file))),
    );
    return (
      [...apps]
        .filter(
          (dir) =>
            existsSync(join(dir, "config", "application.rb")) &&
            toolAdopted(dir, dir, { configs: [], gem: "rails|railties" }) &&
            (env.toolConfig.enabled === true ||
              toolAdopted(dir, top, {
                configs: CONFIGS,
                gem: "brakeman",
                step: /(?:^|[\s;&|"'(/])brakeman(?:\s|$)/m,
              })) &&
            (!changed || changed.some((file) => isUnder(file, dir))),
        )
        // A project-level seed holds nothing but its folder.
        .map((cwd) => ({ cwd }))
    );
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-o|--output|--no-exit-on-warn|--no-exit-on-error|--exit-on-warn|--exit-on-error)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads Brakeman's JSON on stdout and its exit codes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["-f", "json", "--no-pager", "-q", ...ctx.extraArgs, "."],
      // 4: not a Rails app; 255: usage. Told by stderr below.
      okExitCodes: [0, 3, 4, 7, 255],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 4 || raw.exitCode === 255)
      throw new Error(
        `brakeman failed: ${firstLineOf(raw.stderr) ?? `exit ${raw.exitCode}`}`,
      );
    const { root, items: warnings } = parseFindings<BrakemanWarning>(
      "brakeman",
      raw,
      "warnings",
    );
    const findings: Finding[] = warnings.map((w) => {
      if (
        typeof w.file !== "string" ||
        typeof w.line !== "number" ||
        typeof w.check_name !== "string" ||
        typeof w.warning_type !== "string" ||
        typeof w.message !== "string"
      )
        throw new Error(
          "brakeman reported a warning without a file, line, check or message: its output format may have changed; refusing to report it.",
        );
      const confidence =
        typeof w.confidence === "string" ? w.confidence : "Weak";
      const file = absPosix(ctx.cwd, w.file);
      return finding({
        tool: "brakeman",
        layer: "security",
        language: languageForFile(file),
        file,
        line: w.line,
        col: 1,
        ruleId: w.check_name,
        severity: confidence === "Weak" ? "warning" : "error",
        message: `${w.warning_type}: ${w.message}${typeof w.user_input === "string" ? ` from ${w.user_input}` : ""} (${confidence.toLowerCase()} confidence)`,
        fixable: false,
        ...(typeof w.link === "string" ? { url: w.link } : {}),
      });
    });
    for (const e of findingsArray<BrakemanError>("brakeman", root, "errors")) {
      const text = typeof e.error === "string" ? e.error : JSON.stringify(e);
      const at = PARSE_ERROR.exec(text);
      const file = absPosix(ctx.cwd, at?.[1] ?? "Gemfile");
      findings.push(
        finding({
          tool: "brakeman",
          layer: "security",
          language: languageForFile(file),
          file,
          line: at ? Number(at[2]) : 1,
          col: 1,
          ruleId: "parse-error",
          severity: "error",
          message: `Brakeman could not check this: ${at?.[3] ?? text}`,
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
