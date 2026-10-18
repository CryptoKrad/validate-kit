import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding, readResult } from "./base.js";
import { compileDb, dbEntries } from "./c-family.js";

/** `src/bad.c:2:3: warning: if with identical then and else branches [bugprone-branch-clone]` */
const DIAGNOSTIC = /^(\S.*?):(\d+):(\d+): (warning|error): (.+) \[([^\]]+)\]$/;

const HEADER = /\.(?:h|hh|hpp|hxx|h\+\+|ipp)$/i;

/** `#include "h.h"` / `#include <dir/h.h>`: the name it includes. */
const INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;

interface ClangTidyTask {
  /** The folder holding compile_commands.json. */
  db: string;
  /**
   * The folders a printed relative path may be from: the file's own
   * database entry first, then every entry's (an included header is printed
   * from the folder its source compiles in).
   */
  dirs: string[];
  /** The macOS SDK, on macOS. */
  sdk?: string;
}

let sdk: { path?: string } | undefined;

/** `xcrun --show-sdk-path`, asked once; nothing without Xcode's tools. */
function macSdk(): string | undefined {
  if (sdk === undefined) {
    try {
      const path = execFileSync("xcrun", ["--show-sdk-path"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }).trim();
      sdk = path ? { path } : {};
    } catch {
      sdk = {};
    }
  }
  return sdk.path;
}

/**
 * The changed headers, each by the sources that include it, directly or
 * through another header (matched by file name, so a same-named header only
 * adds a source): a header clang-tidy checks alone is compiled without what
 * its includer put before it. A header no source includes is checked by
 * itself.
 */
function throughSources(
  headers: readonly string[],
  sources: readonly string[],
  scoped: readonly string[],
): string[] {
  // What each source and header includes, by file name.
  const includes = new Map<string, string[]>();
  for (const file of new Set([
    ...sources,
    ...scoped.filter((f) => HEADER.test(f)),
  ])) {
    try {
      const text = readFileSync(file, "utf8");
      includes.set(
        file,
        [...text.matchAll(INCLUDE)].map((m) => basename(m[1] ?? "")),
      );
    } catch {
      // Unreadable: it includes nothing the kit can see.
    }
  }
  const found = new Set<string>();
  const alone: string[] = [];
  for (const header of headers) {
    const names = new Set([basename(header)]);
    const pending = new Map(includes);
    let reached = false;
    for (let grew = true; grew;) {
      grew = false;
      for (const [file, included] of pending) {
        if (!included.some((name) => names.has(name))) continue;
        pending.delete(file);
        grew = true;
        if (HEADER.test(file)) names.add(basename(file));
        else {
          found.add(file);
          reached = true;
        }
      }
    }
    if (!reached) alone.push(header);
  }
  return [...found, ...alone];
}

/**
 * clang-tidy — C and C++ lint: the checks the project's `.clang-tidy` turns
 * on (bugprone, readability, the static analyzer), one run per changed
 * source with its flags from the compilation database; a changed header is
 * checked through the sources that include it. Where a `.clang-tidy` is in
 * the file's folder or above it, or `tools.clang-tidy.enabled` /
 * `configPath`; a project with no `compile_commands.json` (from the root up
 * to the project root, or `build/` of any of them, or
 * `options.compileCommands`) cannot run it, and is told so. Its exit code
 * ignores warnings, so the output is the verdict; a `.clang-tidy` it cannot
 * parse (it falls back to the parent's) is a crash. Recorded on LLVM 22.1.8:
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 2.
 */
export const clangTidy: ToolAdapter = {
  id: "clang-tidy",
  layer: "lint",
  languages: ["c", "cpp"],
  bin: "clang-tidy",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "22.1.8",
  installHint:
    "brew install llvm  (keg-only: set tools.clang-tidy.bin to /opt/homebrew/opt/llvm/bin/clang-tidy)",
  parseVersion: (out) => /LLVM version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  // A file that does not compile gets no check findings.
  masks: (f) => f.ruleId === "clang-diagnostic-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined;
    const folderOf = configFolderOf(env.projectRoot, [".clang-tidy"]);
    const configured = (file: string) => chosen || folderOf(file) !== undefined;
    const files = (seed.files ?? []).filter(configured);
    if (files.length === 0) return [];
    const db = compileDb(seed.cwd, env, "clang-tidy");
    if (db === undefined)
      return [
        {
          ...seed,
          files,
          cannotRun:
            "no compile_commands.json from here up to the project root, in build/ of any of them, or at tools.clang-tidy.options.compileCommands: clang-tidy needs each file's compile flags (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON; make: bear -- make)",
        },
      ];
    const entries = dbEntries(db);
    // A database from another checkout or a removed build folder: clang-tidy
    // aborts (`LLVM ERROR: Cannot chdir`) and then hangs in its crash dump.
    const gone = entries.find((e) => !existsSync(e.directory))?.directory;
    if (gone !== undefined)
      return [
        {
          ...seed,
          files,
          cannotRun: `${db}/compile_commands.json compiles from ${gone}, which does not exist: regenerate it`,
        },
      ];
    const headers = files.filter((file) => HEADER.test(file));
    const checked = new Set([
      ...files.filter((file) => !HEADER.test(file)),
      ...(headers.length === 0
        ? []
        : throughSources(
            headers,
            entries.map((e) => e.file).filter((f) => existsSync(f)),
            env.scopedFiles,
          ).filter(configured)),
    ]);
    const everyDir = [...new Set(entries.map((e) => e.directory))];
    const dirOf = new Map(entries.map((e) => [e.file, e.directory]));
    const path = process.platform === "darwin" ? macSdk() : undefined;
    // One run per file: two sources of one name in a run get the first's
    // text, and each prints paths from its own entry's folder.
    return [...checked].map((file) => {
      const own = dirOf.get(file);
      const task: ClangTidyTask = {
        db,
        dirs: own === undefined ? everyDir : [own, ...everyDir],
        ...(path ? { sdk: path } : {}),
      };
      return { cwd: seed.cwd, files: [file], options: task };
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--?(fix|fix-errors|fix-notes|export-fixes|p|quiet|list-checks|dump-config|explain-config)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets the database (tools.clang-tidy.options.compileCommands), the output and that clang-tidy never rewrites files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("clang-tidy needs the task's file list");
    const task = ctx.options as ClangTidyTask;
    const args = ["--quiet", "-p", task.db];
    // Homebrew's clang-tidy has no SDK of its own (<stdio.h> not found).
    // Before the entry's flags, so a database's own -isysroot wins.
    if (task.sdk) args.push(`--extra-arg-before=-isysroot${task.sdk}`);
    if (ctx.configPath) args.push(`--config-file=${ctx.configPath}`);
    args.push(...ctx.extraArgs, ...files);
    // 1: an error-level diagnostic (a compile error, warnings-as-errors) or
    // a crash (no checks enabled, a bad flag).
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A nested .clang-tidy that does not parse: clang-tidy uses the parent's
    // and exits 0, so the checks that folder chose did not run.
    const unread = /^Error (?:parsing|reading) .*$/m.exec(raw.stderr)?.[0];
    if (unread)
      throw new Error(`clang-tidy could not read a config: ${unread}`);
    const { dirs } = ctx.options as ClangTidyTask;
    const fileOf = (path: string): string => {
      if (isAbsolute(path)) return toPosix(path);
      const dir = dirs.find((d) => existsSync(resolve(d, path)));
      return absPosix(dir ?? ctx.cwd, path);
    };
    const findings: Finding[] = [];
    // Notes, source excerpts and carets belong to the diagnostic above them.
    for (const line of raw.stdout.split(/\r?\n/)) {
      const unplaced = /^error: (.+) \[clang-diagnostic-error\]$/.exec(line);
      if (unplaced?.[1])
        throw new Error(`clang-tidy could not check a file: ${unplaced[1]}`);
      const m = DIAGNOSTIC.exec(line);
      if (!m?.[1] || !m[2] || !m[3] || !m[5] || !m[6]) continue;
      const file = fileOf(m[1]);
      findings.push(
        finding({
          tool: "clang-tidy",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: Number(m[2]),
          col: Number(m[3]),
          ruleId: m[6].replace(/,-warnings-as-errors$/, ""),
          severity: m[4] === "error" ? "error" : "warning",
          message: m[5],
          fixable: false,
        }),
      );
    }
    return readResult("clang-tidy", raw, ctx, findings);
  },
};
