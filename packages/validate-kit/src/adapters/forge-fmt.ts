import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
import { toolAdopted, upTo } from "../detect/adoption.js";
import { isUnder } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/**
 * One diff row: old and new line numbers (a `-` row has only the old one, a
 * `+` row only the new one), `|`, then the sign (none on a context row).
 */
const ROW = /^\s*(\d+)(?:\s+\d+)?\s+\|([+-]?)/;

/** solar's frame under an `error:` line: `╭▸ src/Syn.sol:1:10`. */
const FRAME = /╭▸ (.+):(\d+):(\d+)\s*$/;

/**
 * Each file `forge fmt --check` prints a diff for, at the first line that
 * changes: a `-` row's old line, or the line a `+` row inserts before.
 */
function diffs(stdout: string, cwd: string): Finding[] {
  const findings: Finding[] = [];
  let file: string | undefined;
  let lastOld = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^Diff in (.+):$/.exec(line);
    if (header?.[1]) {
      file = absPosix(cwd, header[1]);
      lastOld = 0;
      continue;
    }
    const row = ROW.exec(line);
    if (file === undefined || !row?.[1]) continue;
    if (!row[2]) {
      lastOld = Number(row[1]);
      continue;
    }
    findings.push(
      finding({
        tool: "forge-fmt",
        layer: "format",
        language: "solidity",
        file,
        line: row[2] === "-" ? Number(row[1]) : lastOld + 1,
        col: 1,
        severity: "warning",
        message: "Code is not forge-fmt-formatted: run `forge fmt`",
        fixable: true,
      }),
    );
    file = undefined;
  }
  return findings;
}

/** Each `error:` solar reports at a file position: a file that does not parse. */
function parseErrors(stderr: string, cwd: string): Finding[] {
  const findings: Finding[] = [];
  let message: string | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const error = /^error: (.+)$/.exec(line);
    if (error?.[1]) {
      message = error[1];
      continue;
    }
    const frame = FRAME.exec(line);
    if (message === undefined || !frame?.[1]) continue;
    findings.push(
      finding({
        tool: "forge-fmt",
        layer: "format",
        language: "solidity",
        file: absPosix(cwd, frame[1]),
        line: Number(frame[2]),
        col: Number(frame[3]),
        ruleId: "syntax-error",
        severity: "error",
        message: `${message}: forge fmt cannot format a file that does not parse`,
        fixable: false,
      }),
    );
    message = undefined;
  }
  return findings;
}

/**
 * The folders `foundry.toml` at `root` names as `libs` (default `lib`):
 * vendored code the project's own `forge fmt` leaves alone.
 */
function libsOf(root: string): string[] {
  let libs: unknown;
  try {
    const toml = parseToml(readFileSync(join(root, "foundry.toml"), "utf8"));
    libs = (toml.profile as { default?: { libs?: unknown } } | undefined)
      ?.default?.libs;
  } catch {
    // no foundry.toml, or one forge itself will reject: the default
  }
  return (
    Array.isArray(libs) && libs.every((lib) => typeof lib === "string")
      ? libs
      : ["lib"]
  ).map((lib) => join(root, lib));
}

/**
 * forge fmt — Foundry's Solidity formatter, with the `[fmt]` settings of
 * each file's nearest `foundry.toml` (`--nearest`: from the repository root
 * forge reads only the root's). Runs where the project adopted it: a
 * `foundry.toml` at or above the Foundry root, or `tools.forge-fmt.enabled`.
 * One finding per file whose layout differs; a file that does not parse is
 * an error at its position (forge prints it only when no other file has a
 * diff). Files under the `libs` folders are left out, as forge's own run
 * does. Fix: `forge fmt`, layout only. Recorded on 1.8.5:
 * docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, 5.
 */
export const forgeFmt: ToolAdapter = {
  id: "forge-fmt",
  layer: "format",
  languages: ["solidity"],
  bin: "forge",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.8.5",
  installHint:
    "brew install foundry  (or: curl -L https://foundry.paradigm.xyz | bash && foundryup)",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, { configs: ["foundry.toml"] }),
  adoptHint:
    "Add a foundry.toml (its [fmt] table sets the style), or set `tools.forge-fmt.enabled: true`.",
  // 1: a diff, or a file that does not parse or does not exist.
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const libs = new Map<string, string[]>();
    const files = (seed.files ?? []).filter((file) => {
      const root =
        upTo(dirname(file), env.projectRoot).find((dir) =>
          existsSync(join(dir, "foundry.toml")),
        ) ?? seed.cwd;
      if (!libs.has(root)) libs.set(root, libsOf(root));
      return !libs.get(root)?.some((lib) => isUnder(file, lib));
    });
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-r|--raw|--color|--check)(=|$)/.test(arg))
      ? "the kit reads forge fmt's plain diff and decides when it writes; --raw, --color and --check change that"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("forge fmt needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "fmt",
        ...(ctx.fix ? [] : ["--check"]),
        "--nearest",
        ...ctx.extraArgs,
        ...files,
      ],
      // 2: usage, a crash.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const diffed = ctx.fix ? [] : diffs(raw.stdout, ctx.cwd);
    const findings =
      diffed.length > 0 || raw.exitCode === 0
        ? diffed
        : parseErrors(raw.stderr, ctx.cwd);
    if (findings.length === 0 && raw.exitCode !== 0) {
      const first =
        /^error: .+$/m.exec(raw.stderr)?.[0] ??
        `${raw.stdout}\n${raw.stderr}`.trim().split("\n")[0];
      throw new Error(
        `forge fmt exited ${raw.exitCode} with no diff and no parse error${first ? `: ${first}` : ""}`,
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
