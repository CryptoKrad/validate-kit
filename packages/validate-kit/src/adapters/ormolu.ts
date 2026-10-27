import { resolveBin } from "../core/exec.js";
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
  batchThenEach,
  byConfigFolder,
  eachRun,
  finding,
  relativeFiles,
} from "./base.js";

/** `Broken.hs:2:7` then the parser's message on the next lines. */
const PARSE_ERROR = /^(.+?):(\d+):(\d+)/;

/**
 * Each hunk of ormolu's diff (`@@ -1,4 +1,5 @@`, then lines prefixed by two
 * spaces, `- ` or `+ `), as the first line it changes.
 */
function changedLines(diff: string): number[] {
  const lines: number[] = [];
  let at: number | undefined;
  for (const text of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)/.exec(text);
    if (hunk) {
      at = Number(hunk[1]);
      continue;
    }
    if (at === undefined) continue;
    if (text.startsWith("- ") || text.startsWith("+ ") || /^[-+]$/.test(text)) {
      lines.push(at);
      at = undefined;
    } else at += 1;
  }
  return lines;
}

/**
 * ormolu — the Haskell formatter, as a check (`--mode check`): each hunk it
 * would rewrite, at its first changed line, and a file GHC's parser
 * rejects. Opt-in, since a project with no ormolu config still has
 * ormolu's one fixed style: `tools.ormolu.enabled`, or a `.ormolu` fixity
 * file at or above the file. All files in one process, and each in its
 * own only when that run fails: with two unformatted files the diffs
 * interleave on stderr. Exit 100 is a finding. `--fix` runs
 * `--mode inplace`, layout only. Recorded on 0.9.0.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 7.
 */
export const ormolu: ToolAdapter = {
  id: "ormolu",
  layer: "format",
  languages: ["haskell"],
  bin: "ormolu",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "0.9.0",
  installHint: "brew install ormolu  (or: cabal install ormolu)",
  findingExitCodes: [100],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) => byConfigFolder(seed, env, "haskell", [".ormolu"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-m|--mode|-i|--color|--stdin-input-file)(=|$)/.test(arg),
    )
      ? "the kit sets ormolu's mode and reads its plain diff"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return batchThenEach(
      // Resolved: Windows would run an ormolu.exe in the project folder first.
      resolveBin(this.bin, ctx.cwd, process.env, this !== ormolu),
      [
        "--mode",
        ctx.fix ? "inplace" : "check",
        "--color",
        "never",
        ...ctx.extraArgs,
      ],
      relativeFiles(ctx, "ormolu"),
    );
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    for (const { file, status, out } of eachRun("ormolu", raw)) {
      const at = (
        line: number,
        col: number,
        syntax: boolean,
        message: string,
      ) =>
        findings.push(
          finding({
            tool: "ormolu",
            layer: "format",
            language: "haskell",
            file: absPosix(ctx.cwd, file),
            line,
            col,
            ruleId: syntax ? "syntax-error" : "format",
            severity: syntax ? "error" : "warning",
            message,
            fixable: !syntax,
          }),
        );
      if (status === 0) continue;
      // 100: not formatted, the diff on stderr.
      const hunks = status === 100 ? changedLines(out) : [];
      for (const line of hunks)
        at(line, 1, false, "not formatted as ormolu would: run `check --fix`");
      if (hunks.length > 0) continue;
      // 3: GHC's parser rejected the file. Anything else (1: a missing file,
      // a usage error) is a failure.
      const [head = "", ...rest] = out.trim().split(/\r?\n/);
      const m = PARSE_ERROR.exec(head.trim());
      if (status !== 3 || !m)
        throw new Error(
          `ormolu failed on ${file} (exit ${String(status)}): ${head.trim()}`,
        );
      at(
        Number(m[2]),
        Number(m[3]),
        true,
        rest
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" "),
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
