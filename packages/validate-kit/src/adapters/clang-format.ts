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
import { configFolderOf } from "../detect/adoption.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, finding, readResult } from "./base.js";

/** `src/bad.c:1:11: error: code should be clang-formatted [-Wclang-format-violations]` */
const VIOLATION =
  /^(\S.*?):(\d+):(\d+): (?:error|warning): code should be clang-formatted \[-Wclang-format-violations\]$/;

/**
 * Any other diagnostic (`sub/.clang-format:1:1: error: Unknown value for
 * BasedOnStyle`), `Error reading <config>: Invalid argument`, or a missing
 * file: a file clang-format did not check, whatever the others show.
 */
const CRASH =
  /^\S.*?:\d+:\d+: (?:error|warning): |^Error (?:reading|parsing) |^error: |: No such file or directory$/;

/**
 * clang-format — C and C++ formatting, in the project's own style. Where a
 * `.clang-format` or `_clang-format` is in the file's folder or above it (up
 * to the project root, the way `--style=file` looks), or
 * `tools.clang-format.enabled` / `configPath`: with no config it would check
 * every file against LLVM style, so a file no config reaches is left out. It
 * prints one diagnostic per replacement: one finding per file, at the first.
 * A config it cannot read crashes the run, even beside another file's
 * finding. Recorded on 23.1.3 and 22.1.8:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 1.
 */
export const clangFormat: ToolAdapter = {
  id: "clang-format",
  layer: "format",
  languages: ["c", "cpp"],
  bin: "clang-format",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "22.1.8",
  installHint: "brew install clang-format",
  parseVersion: (out) => /clang-format version (\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined;
    const folderOf = configFolderOf(env.projectRoot, [
      ".clang-format",
      "_clang-format",
    ]);
    const files = (seed.files ?? []).filter(
      (file) => chosen || folderOf(file) !== undefined,
    );
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--?(i|output-replacements-xml|files|Wno-error)(=|$)/.test(arg),
    )
      ? "the kit sets the files, how clang-format reports them and when it rewrites them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("clang-format needs the task's file list");
    return {
      bin: this.bin,
      args: [
        // Without --Werror a file that differs is a warning, and exit 0.
        ...(ctx.fix ? ["-i"] : ["--dry-run", "--Werror"]),
        ctx.configPath ? `--style=file:${ctx.configPath}` : "--style=file",
        ...ctx.extraArgs,
        ...files,
      ],
      // 1: a file differs, or a crash (a missing file, a bad flag).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    const lines = raw.stderr.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const m = VIOLATION.exec(line);
      if (!m?.[1] || !m[2] || !m[3]) {
        if (CRASH.test(line))
          throw new Error(`clang-format did not check every file: ${line}`);
        continue;
      }
      // The source line and the caret under it.
      i += 2;
      const file = absPosix(ctx.cwd, m[1]);
      if (seen.has(file)) continue;
      seen.add(file);
      findings.push(
        finding({
          tool: "clang-format",
          layer: "format",
          language: languageForFile(file),
          file,
          line: Number(m[2]),
          col: Number(m[3]),
          severity: "warning",
          message: "File is not clang-formatted (its first difference is here)",
          fixable: true,
        }),
      );
    }
    return readResult("clang-format", raw, ctx, findings);
  },
};
