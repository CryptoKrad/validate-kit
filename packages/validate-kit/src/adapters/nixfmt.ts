import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, byConfigFolder, finding, relativeFiles } from "./base.js";

/**
 * nixfmt — the official Nix formatter, as a check (`--check`): a file it
 * would change (it names files, not places), and a file it cannot parse, at
 * the parser's position. Opt-in (`tools.nixfmt.enabled`): it has no config
 * file to adopt it by. Findings and failures share exit 1, so stderr is
 * read line by line and any line it does not recognise is a crash. `--fix`
 * runs `nixfmt`, layout only. Recorded on 1.5.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 9.
 */
export const nixfmt: ToolAdapter = {
  id: "nixfmt",
  layer: "format",
  languages: ["nix"],
  bin: "nixfmt",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.5.0",
  installHint: "brew install nixfmt  (or: nix profile install nixpkgs#nixfmt)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand: (seed, env) => byConfigFolder(seed, env, "nix", []),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-c|--check|-q|--quiet|-f|--filename|-)(=|$)/.test(arg),
    )
      ? "the kit sets nixfmt's mode and reads its messages"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? [] : ["--check"]),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "nixfmt"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const add = (
      path: string,
      line: number,
      col: number,
      syntax: boolean,
      message: string,
    ) =>
      findings.push(
        finding({
          tool: "nixfmt",
          layer: "format",
          language: "nix",
          file: absPosix(ctx.cwd, path),
          line,
          col,
          ruleId: syntax ? "syntax-error" : "format",
          severity: syntax ? "error" : "warning",
          message,
          fixable: !syntax,
        }),
      );
    // A parse error: `broken.nix:1:7:`, a caret excerpt (`  |`, `1 | ...`),
    // then its message lines up to a blank line.
    let error:
      { path: string; line: number; col: number; text: string[] } | undefined;
    const flush = () => {
      if (error)
        add(error.path, error.line, error.col, true, error.text.join(": "));
      error = undefined;
    };
    for (const text of raw.stderr.split(/\r?\n/)) {
      if (error) {
        if (!text.trim()) flush();
        else if (!/^\s|^\d+ \|/.test(text)) error.text.push(text.trim());
        continue;
      }
      if (!text.trim()) continue;
      const unformatted = /^(.+): not formatted$/.exec(text);
      if (unformatted?.[1]) {
        add(
          unformatted[1],
          1,
          1,
          false,
          "not formatted as nixfmt would: run `check --fix`",
        );
        continue;
      }
      const at = /^(.+?):(\d+):(\d+):$/.exec(text);
      if (!at?.[1]) throw new Error(`nixfmt failed: ${text.trim()}`);
      error = {
        path: at[1],
        line: Number(at[2]),
        col: Number(at[3]),
        text: [],
      };
    }
    flush();
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
