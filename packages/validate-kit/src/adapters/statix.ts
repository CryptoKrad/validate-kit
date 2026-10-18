import { stripVTControlCharacters } from "node:util";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  byConfigFolder,
  charColumn,
  finding,
  relativeFiles,
  sourceLines,
} from "./base.js";

/**
 * `./bad.nix>7:10:W:1:Comparing `a` with boolean literal `true``; the
 * column counts bytes.
 */
const ERRFMT = /^(.+?)>(\d+):(\d+):([WE]):(\d+):(.*)$/;

/**
 * statix — Nix antipatterns (`a == true`, a needless `let`, legacy `let`
 * syntax...), each lint by its number (W01 bool_comparison), and a file
 * that does not parse. Where the project chose it: a `statix.toml`, which
 * statix reads from the folder it runs in and above, so each file runs from
 * its nearest one's folder; or `tools.statix.enabled` / `.configPath`.
 * `statix check` takes one path, so one file per process; a missing path
 * exits 0 with a line on stderr, which is a crash here. Homebrew's build has
 * no JSON: errfmt lines, ANSI stripped; a lint that names several places
 * (W20, a key assigned in parts) prints a line per place, read as one
 * finding. No fix: its rewrites change code. Recorded on 0.5.8:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 9.
 */
export const statix: ToolAdapter = {
  id: "statix",
  layer: "lint",
  languages: ["nix"],
  bin: "statix",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.5.8",
  installHint: "brew install statix  (or: cargo install statix)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) =>
    byConfigFolder(seed, env, "nix", ["statix.toml"]).flatMap(
      ({ cwd, files }) => (files ?? []).map((file) => ({ cwd, files: [file] })),
    ),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-o|--format|-s|--stdin)(=|$)/.test(arg))
      ? "the kit names the file and reads statix's errfmt lines"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "check",
        "-o",
        "errfmt",
        ...(ctx.configPath ? ["-c", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "statix"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const stderr = stripVTControlCharacters(raw.stderr).trim();
    if (stderr) throw new Error(`statix failed: ${stderr.split("\n")[0]}`);
    const findings: Finding[] = [];
    const linesOf = sourceLines();
    for (const text of stripVTControlCharacters(raw.stdout).split(/\r?\n/)) {
      if (!text.trim()) continue;
      const m = ERRFMT.exec(text.trim());
      if (!m?.[1] || !m[6])
        throw new Error(
          `statix printed a line that is not errfmt (${text.trim().slice(0, 120)}): its output format may have changed; refusing to report it.`,
        );
      const lint = m[4] === "W";
      const file = absPosix(ctx.cwd, m[1]);
      const line = Number(m[2]);
      const ruleId = lint ? `W${m[5]?.padStart(2, "0") ?? ""}` : "syntax-error";
      // `... repeated here ...`: another place of the finding before it.
      const last = findings.at(-1);
      if (
        m[6].startsWith("...") &&
        last?.ruleId === ruleId &&
        last.file === file
      ) {
        last.message = `${last.message.replace(/\s*\.\.\.$/, "")}, ${m[6].replace(/^\.\.\.\s*/, "")}`;
        continue;
      }
      findings.push(
        finding({
          tool: "statix",
          layer: "lint",
          language: "nix",
          file,
          line,
          col: charColumn(linesOf(file), line, Number(m[3]) - 1),
          ruleId,
          severity: lint ? "warning" : "error",
          message: m[6],
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
