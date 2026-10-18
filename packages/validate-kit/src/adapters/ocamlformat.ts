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
  batchThenEach,
  byConfigFolder,
  charColumn,
  eachRun,
  finding,
  relativeFiles,
  sourceLines,
} from "./base.js";

/** `File "broken.ml", line 2, characters 0-0:` (a byte offset in the line) */
const SYNTAX = /File "[^"]*", line (\d+), characters (\d+)-/;

/**
 * Where ocamlformat stops looking for a `.ocamlformat`: its project root,
 * the nearest folder holding one of these (`ocamlformat --help`).
 */
const PROJECT_ROOTS = [".git", ".hg", "dune-project"];

/**
 * ocamlformat — the OCaml formatter, as a check (`--check`): a file it
 * would change, and a syntax error at its position. It prints nothing for
 * an unformatted file, so the files run in one process and, only when that
 * run fails, each in its own, whose exit code names it. Where the project
 * chose it: a `.ocamlformat` at or above the file and not above its project
 * root (the nearest `.git`, `.hg` or `dune-project`), where ocamlformat
 * itself stops; without one it skips the file and exits 0, and that warning
 * is a crash here. Or `tools.ocamlformat.enabled`. OCAMLFORMAT is emptied for
 * the run: ocamlformat reads that variable as its options. Not in Homebrew:
 * `opam install ocamlformat`, or `tools.ocamlformat.bin` for a binary in an
 * opam switch. `--fix` runs `--inplace`, layout only. Recorded on 0.29.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 8.
 */
export const ocamlformat: ToolAdapter = {
  id: "ocamlformat",
  layer: "format",
  languages: ["ocaml"],
  bin: "ocamlformat",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "0.29.0",
  installHint: "opam install ocamlformat",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) =>
    byConfigFolder(seed, env, "ocaml", [".ocamlformat"], {
      stopAt: PROJECT_ROOTS,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--check|-i|--inplace|-o|--output|--name|--print-config|-)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets ocamlformat's mode and names the file"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      ...batchThenEach(
        this.bin,
        [ctx.fix ? "--inplace" : "--check", ...ctx.extraArgs],
        relativeFiles(ctx, "ocamlformat"),
      ),
      // Read as `opt=val,...`: a value from the caller's shell fails every run.
      env: { OCAMLFORMAT: "" },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const linesOf = sourceLines();
    for (const { file, status, out } of eachRun("ocamlformat", raw)) {
      const path = absPosix(ctx.cwd, file);
      const text = stripVTControlCharacters(out).trim();
      const failed = () =>
        new Error(
          `ocamlformat failed on ${file} (exit ${String(status)}): ${text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .join(" ")
            .slice(0, 400)}`,
        );
      // Exit 0 and "Ocamlformat disabled": it found no .ocamlformat in the
      // file's project and checked nothing.
      if (status === 0) {
        if (/Ocamlformat disabled/.test(text)) throw failed();
        continue;
      }
      if (status !== 1) throw failed();
      const syntax = SYNTAX.exec(text);
      if (syntax && /\(syntax error\)/.test(text)) {
        const line = Number(syntax[1]);
        findings.push(
          finding({
            tool: "ocamlformat",
            layer: "format",
            language: "ocaml",
            file: path,
            line,
            col: charColumn(linesOf(path), line, Number(syntax[2])),
            ruleId: "syntax-error",
            severity: "error",
            message: "syntax error: ocamlformat cannot parse the file",
            fixable: false,
          }),
        );
      }
      // Exit 1 with nothing printed: the file is not formatted. Exit 1 with
      // any other text: a bad config, a version mismatch, a usage error.
      else if (text) throw failed();
      else if (!ctx.fix)
        findings.push(
          finding({
            tool: "ocamlformat",
            layer: "format",
            language: "ocaml",
            file: path,
            line: 1,
            col: 1,
            ruleId: "format",
            severity: "warning",
            message: "not formatted as ocamlformat would: run `check --fix`",
            fixable: true,
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
