import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, byConfigFolder, finding, relativeFiles } from "./base.js";

/** yamllint's config names, searched upward from the folder it runs in. */
const CONFIGS = [".yamllint", ".yamllint.yaml", ".yamllint.yml"];

/** `bad.yaml:4:6: [error] too many spaces after hyphen (hyphens)` */
const PROBLEM = /^(.+?):(\d+):(\d+): \[(error|warning)\] (.*) \(([\w-]+)\)$/;

/**
 * yamllint — YAML problems a parser accepts: duplicate keys, bad
 * indentation, truthy values (`yes`, `on`), trailing spaces, and syntax
 * errors. Runs where the project configured it (its built-in default flags
 * nearly every file): a `.yamllint`, `.yamllint.yaml` or `.yamllint.yml` at
 * or above the file (from that config's folder, where yamllint finds it),
 * `tools.yamllint.enabled` or `tools.yamllint.configPath`. Its errors are
 * errors; its warnings are info, as yamllint passes on them. Recorded on
 * 1.38.0:
 * docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 3.
 */
export const yamllint: ToolAdapter = {
  id: "yamllint",
  layer: "lint",
  languages: ["yaml"],
  bin: "yamllint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.38.0",
  installHint: "brew install yamllint  (or: uv tool install yamllint)",
  findingExitCodes: [1],

  expand: (seed, env) => byConfigFolder(seed, env, "yaml", CONFIGS),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-s|--strict|--list-files)(=|$)/.test(arg),
    )
      ? "the kit reads yamllint's parsable format and its exit code; --format, --strict and --list-files change them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "-f",
        "parsable",
        ...(ctx.configPath ? ["-c", ctx.configPath] : []),
        ...ctx.extraArgs,
        // Relative, so the config's `ignore` patterns match them.
        "--",
        ...relativeFiles(ctx, "yamllint"),
      ],
      // 255 (a missing file) and 2 (usage) are crashes.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A config it cannot read, or a file it cannot decode, is a traceback
    // and exit 1, with the other files' problems still on stdout.
    const crash = () => {
      const last = raw.stderr.trim().split(/\r?\n/).at(-1)?.trim();
      return new Error(`yamllint could not run${last ? `: ${last}` : ""}`);
    };
    if (raw.stderr.includes("Traceback (most recent call last)")) throw crash();
    const findings: Finding[] = [];
    for (const text of raw.stdout.split(/\r?\n/)) {
      if (text.trim() === "") continue;
      const m = PROBLEM.exec(text);
      if (!m?.[1] || !m[6])
        throw new Error(
          `yamllint printed a line that is not a parsable problem (${JSON.stringify(text.slice(0, 120))}): its output format may have changed; refusing to report it.`,
        );
      findings.push(
        finding({
          tool: "yamllint",
          layer: "lint",
          language: "yaml",
          file: absPosix(ctx.cwd, m[1]),
          line: Number(m[2]),
          col: Number(m[3]),
          ruleId: m[6],
          severity: m[4] === "error" ? "error" : "info",
          message: m[5] ?? "",
          fixable: false,
        }),
      );
    }
    // It exits 1 on errors only: with none, something else went wrong.
    if (raw.exitCode === 1 && !findings.some((f) => f.severity === "error"))
      throw crash();
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
