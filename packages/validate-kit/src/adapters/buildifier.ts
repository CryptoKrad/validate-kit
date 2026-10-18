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
import {
  absPosix,
  existingFiles,
  finding,
  findingsArray,
  parseJsonOutput,
  relativeFiles,
} from "./base.js";

/** One file of `-format=json` (buildifier 10.1.0). */
interface BuildFile {
  filename?: unknown;
  formatted?: unknown;
  valid?: unknown;
  warnings?: unknown;
}

interface Warning {
  start?: { line?: unknown; column?: unknown };
  category?: unknown;
  message?: unknown;
  url?: unknown;
}

/** A Bazel workspace's root files; `.buildifier.json` is buildifier's own. */
const ROOTS = [
  "MODULE.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  ".buildifier.json",
];

/** `BUILD:3:1: syntax error` */
const SYNTAX = /^(.+?):(\d+):(\d+): (.*)$/;

/**
 * buildifier — Bazel's formatter and linter for BUILD, WORKSPACE,
 * MODULE.bazel and .bzl files: a file it would reformat, and each lint
 * warning (`native-cc-library`, `unused-variable`, `load`...) by its
 * category, with its documentation. On by default in a Bazel workspace (a
 * MODULE.bazel, WORKSPACE or WORKSPACE.bazel at the task's root, or a
 * `.buildifier.json`), else `tools.buildifier.enabled`. Its JSON run always
 * exits 0: the JSON and stderr are the verdict, and a file it did not
 * report is a crash. The kit's flags override a `.buildifier.json`'s mode
 * and format; its other settings (warnings, tables) apply. `--fix` formats
 * only (`-mode=fix -lint=off`): `-lint=fix` adds `load`s, a code change.
 * Recorded on 10.1.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 10.
 */
export const buildifier: ToolAdapter = {
  id: "buildifier",
  layer: "lint",
  languages: ["starlark"],
  bin: "buildifier",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "10.1.0",
  installHint:
    "brew install buildifier  (or: go install github.com/bazelbuild/buildtools/buildifier@latest)",
  // Homebrew's binary prints `buildifier version: redacted`: no version.
  versionArgs: ["-version"],
  masks: (f) => f.ruleId === "syntax-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      ROOTS.some((name) => existsSync(join(seed.cwd, name)));
    // Only files that exist: buildifier's JSON run passes a missing one.
    const files = chosen ? existingFiles(seed, env, "starlark") : [];
    return files.length === 0 ? [] : [{ cwd: seed.cwd, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--?(mode|format|lint|d|r|path|v|diff_command|multi_diff)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets buildifier's mode, lint mode and JSON output, and names the files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        // `-format=` clears a .buildifier.json's "format", which fix refuses.
        ...(ctx.fix
          ? ["-mode=fix", "-lint=off", "-format="]
          : ["-mode=check", "-lint=warn", "-format=json"]),
        ...(ctx.configPath ? [`-config=${ctx.configPath}`] : []),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "buildifier"),
      ],
      // 1: a file in fix mode did not parse (in check mode it exits 0).
      okExitCodes: ctx.fix ? [0, 1] : [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // stderr holds only parse errors' positions; anything else (`open x: no
    // such file`) is a failure the exit code hides.
    const syntax = new Map<
      string,
      { line: number; col: number; text: string }
    >();
    for (const text of raw.stderr.split(/\r?\n/)) {
      if (!text.trim()) continue;
      const m = SYNTAX.exec(text.trim());
      if (!m?.[1] || !m[4])
        throw new Error(`buildifier failed: ${text.trim()}`);
      if (!syntax.has(m[1]))
        syntax.set(m[1], { line: Number(m[2]), col: Number(m[3]), text: m[4] });
    }
    const findings: Finding[] = [];
    const add = (
      path: string,
      f: {
        line: number;
        col: number;
        ruleId: string;
        message: string;
        url?: string;
      },
    ) =>
      findings.push(
        finding({
          tool: "buildifier",
          layer: "lint",
          language: "starlark",
          file: absPosix(ctx.cwd, path),
          ...f,
          severity: f.ruleId === "syntax-error" ? "error" : "warning",
          fixable: f.ruleId === "format",
        }),
      );
    if (ctx.fix) {
      for (const [path, at] of syntax)
        add(path, { ...at, ruleId: "syntax-error", message: at.text });
      return {
        findings,
        filesProcessed: ctx.files?.length ?? 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    }
    const report = parseJsonOutput<{ success?: unknown; files?: unknown }>(
      "buildifier",
      raw,
      {},
    );
    const files = findingsArray<BuildFile>("buildifier", report, "files");
    if (files.length !== (ctx.files?.length ?? 0))
      throw new Error(
        `buildifier reported ${files.length} of the ${ctx.files?.length ?? 0} files it was given: its output format may have changed; refusing to report it.`,
      );
    for (const file of files) {
      if (typeof file.filename !== "string")
        throw new Error(
          "buildifier reported a file without a name: its output format may have changed; refusing to report it.",
        );
      const path = file.filename;
      if (file.valid === false) {
        const at = syntax.get(path) ?? {
          line: 1,
          col: 1,
          text: "syntax error",
        };
        add(path, { ...at, ruleId: "syntax-error", message: at.text });
        continue;
      }
      if (file.formatted === false)
        add(path, {
          line: 1,
          col: 1,
          ruleId: "format",
          message: "not formatted as buildifier would: run `check --fix`",
        });
      for (const w of findingsArray<Warning>("buildifier", file.warnings)) {
        if (
          typeof w.category !== "string" ||
          typeof w.message !== "string" ||
          typeof w.start?.line !== "number" ||
          typeof w.start.column !== "number"
        )
          throw new Error(
            "buildifier reported a warning without a category, message or position: its output format may have changed; refusing to report it.",
          );
        add(path, {
          line: w.start.line,
          col: w.start.column,
          ruleId: w.category,
          // The first line; the rest is how to silence or re-export.
          message: w.message.split("\n")[0] ?? w.message,
          ...(typeof w.url === "string" ? { url: w.url } : {}),
        });
      }
    }
    if (report.success === false && findings.length === 0)
      throw new Error(
        "buildifier reported a failure with no file to blame: its output format may have changed; refusing to report it.",
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
