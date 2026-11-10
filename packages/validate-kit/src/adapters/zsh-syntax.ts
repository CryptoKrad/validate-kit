import { closeSync, openSync, readSync } from "node:fs";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/** `file:line: message`, as zsh reports a script it cannot parse. */
const PARSE = /^(.+?):(\d+): (.+)$/;

/**
 * Is this a zsh script: a `.zsh` file, or one whose first line names zsh
 * (`#!/bin/zsh`, `#!/usr/bin/env zsh`)? shellcheck and shfmt read sh, bash,
 * dash and ksh, not zsh: a zsh script is theirs to leave alone.
 */
export function isZsh(path: string): boolean {
  if (/\.zsh$/i.test(path)) return true;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const read = readSync(fd, head, 0, head.length, 0);
    const first = head.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    return /^#!.*\bzsh\b/.test(first);
  } catch {
    return false; // gone, or unreadable: not for this tool to say
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The task without the scripts `mine` rejects, or no task when none is left. */
export function onlyScripts(
  seed: TaskSeed,
  mine: (path: string) => boolean,
): TaskSeed[] {
  if (!seed.files) return [seed];
  const files = seed.files.filter(mine);
  return files.length > 0 ? [{ ...seed, files }] : [];
}

/**
 * zsh-syntax — zsh scripts zsh itself cannot parse: an unclosed `if`, a
 * missing brace. shellcheck does not read zsh (SC1071), so without this a
 * `#!/bin/zsh` script is checked by nothing. `zsh -n` reads a script without
 * running it, one script per process, so one zsh loops over the task's files;
 * `-f` keeps the user's startup files out of it. Syntax only: it finds no
 * unquoted expansion and no unused variable. Each error is reported at its
 * line. Recorded on zsh 5.9:
 * docs/research/lint-toolchain/sota-2026-11-09/recorded.md.
 */
export const zshSyntax: ToolAdapter = {
  id: "zsh-syntax",
  layer: "lint",
  languages: ["shell"],
  bin: "zsh",
  // `zsh 5.9 (arm64-apple-darwin25.0)`: two parts.
  parseVersion: (out) => {
    const found = /zsh (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
    return found
      ? `${found[1] ?? "0"}.${found[2] ?? "0"}.${found[3] ?? "0"}`
      : undefined;
  },
  minVersion: "5.0.0",
  installHint: "brew install zsh  (or: apt install zsh; macOS ships it)",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: true,
  optional: true,
  findingExitCodes: [1],

  expand: (seed) => onlyScripts(seed, isZsh),

  refuseArgs: (extraArgs) =>
    extraArgs.length > 0
      ? "zsh-syntax takes no arguments: they would be the script's own"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("zsh-syntax needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "-f",
        "-c",
        'r=0; for f; do zsh -f -n -- "$f" || r=1; done; exit $r',
        "zsh",
        ...files,
      ],
      // 1: a script did not parse (or could not be opened).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const parsed = PARSE.exec(line);
      // `zsh: can't open input file: x`: zsh's own trouble, not the script's.
      if (!parsed || parsed[1] === "zsh")
        throw new Error(`zsh-syntax: ${line.trim()}`);
      findings.push(
        finding({
          tool: "zsh-syntax",
          layer: "lint",
          language: "shell",
          file: absPosix(cwd, parsed[1] ?? ""),
          line: Number(parsed[2]),
          col: 1,
          ruleId: "parse",
          severity: "error",
          message: `zsh cannot parse this script: ${parsed[3] ?? ""}`,
          fixable: false,
        }),
      );
    }
    if (raw.exitCode === 1 && findings.length === 0)
      throw new Error(
        "zsh-syntax: zsh exited 1 and named no line: its output format may have changed; refusing to report it.",
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
