import { closeSync, openSync, readSync } from "node:fs";
import { posix } from "node:path";
import picomatch from "picomatch";
import type {
  BuiltCommand,
  Finding,
  Layer,
  PlanEnv,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { gitSync } from "../detect/git.js";
import { toPosix } from "../detect/languages.js";
import { finding } from "./base.js";

export { gitSync };

/** The first `bytes` of a file; empty when it cannot be read. */
export function headOf(file: string, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One index entry: its mode (`100644`, `100755`, `120000`) and object id. */
export interface IndexEntry {
  mode: string;
  id: string;
}

/**
 * Every path in the index under `root` (project-relative), from one
 * `git ls-files -s -z` with no path arguments, so no list is too long for
 * the command line and no name is read as a glob. Empty outside git.
 */
export function indexEntries(root: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const entry of (gitSync(root, ["ls-files", "-s", "-z"]) ?? "").split(
    "\0",
  )) {
    const match = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(entry);
    if (match?.[1] && match[2] && match[3] !== undefined)
      entries.set(match[3], { mode: match[1], id: match[2] });
  }
  return entries;
}

/**
 * A command that does nothing: the kit's own node, for a task whose work is
 * done when its output is read (a kit check, or why a tool did not run).
 */
export const NOTHING: BuiltCommand = {
  bin: process.execPath,
  args: ["-e", ""],
};

/** What a kit check was given to read: project-relative POSIX paths. */
export interface NativeTask {
  files: string[];
  /** A changed-file run (`--staged`, `--changed`, `--since`). */
  changed: boolean;
  /** A `--staged` run: the commit is the index. */
  staged: boolean;
  /** Whatever else the check worked out while planning. */
  extra?: unknown;
}

/**
 * Git's own list of the project's files (project-relative): what the index
 * holds and, outside a staged run, new files git does not ignore, less those
 * deleted from disk. Dotfiles and build folders are in it.
 */
export function gitFiles(root: string, staged: boolean): string[] | undefined {
  const list = (args: string[]) =>
    gitSync(root, ["ls-files", "-z", ...args])
      ?.split("\0")
      .filter(Boolean);
  const listed = list(
    staged ? ["--cached"] : ["--cached", "--others", "--exclude-standard"],
  );
  if (listed === undefined) return undefined;
  const gone = new Set(staged ? [] : (list(["--deleted"]) ?? []));
  return [...new Set(listed)].filter((path) => !gone.has(path)).toSorted();
}

/** The config's `ignore`, as a test of a project-relative path. */
export function ignoredBy(env: PlanEnv): (path: string) => boolean {
  const patterns = env.config.ignore.map((pattern) =>
    toPosix(pattern).replace(/^\.\//, ""),
  );
  return patterns.length > 0 ? picomatch(patterns, { dot: true }) : () => false;
}

/**
 * A check the kit makes itself, reading the files with no tool to install:
 * the command is the kit's own node doing nothing, and the check runs when
 * the output is read. Runs on every commit (fast tier), on the scope's files,
 * or only the changed ones in a changed-file run.
 */
export function nativeCheck(spec: {
  id: string;
  layer: Layer;
  /** Of the files given (project-relative), the ones this check reads. */
  select?: (files: string[], env: PlanEnv) => string[];
  /**
   * A check of what git stores: it gets git's whole file list (dotfiles and
   * build folders too, less the config's `ignore`) instead of the scope, and
   * in a changed-file run every changed path, in scope or not.
   */
  allPaths?: boolean;
  /** Anything else to work out while planning, given the selected files. */
  plan?: (files: string[], env: PlanEnv) => unknown;
  check: (root: string, task: NativeTask) => Finding[];
}): ToolAdapter {
  return {
    id: spec.id,
    layer: spec.layer,
    languages: [],
    runsAt: "project-root",
    fileScoped: false,
    bin: process.execPath,
    binSetting: false,
    supportsFix: false,
    fixWriteBack: false,
    minVersion: "18.0.0",
    installHint: "node (the kit's own runtime)",
    tier: "fast",

    expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
      const top = toPosix(env.projectRoot);
      const staged = env.changedMode === "staged";
      const changed =
        env.changedPaths && new Set(env.changedPaths.map(toPosix));
      let given: string[];
      if (spec.allPaths) {
        const ignored = ignoredBy(env);
        given = (
          changed
            ? [...changed]
            : (gitFiles(top, staged) ??
              env.scopedFiles.map((file) => posix.relative(top, file)))
        ).filter((path) => !ignored(path));
      } else
        given = env.scopedFiles
          .map((file) => posix.relative(top, file))
          .filter((path) => !changed || changed.has(path));
      const files = spec.select ? spec.select(given, env) : given;
      if (files.length === 0) return [];
      const task: NativeTask = {
        files,
        changed: changed !== undefined,
        staged,
        ...(spec.plan ? { extra: spec.plan(files, env) } : {}),
      };
      return [{ ...seed, options: task }];
    },

    buildArgs: () => NOTHING,

    parseOutput(raw, ctx: ToolContext): RunResult {
      const task = ctx.options as NativeTask;
      return {
        findings: spec.check(toPosix(ctx.cwd), task),
        filesProcessed: task.files.length,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    },
  };
}

/** A finding of a kit check, at a project-relative path. */
export function fileFinding(
  tool: string,
  layer: Layer,
  root: string,
  path: string,
  f: {
    ruleId: string;
    severity: Severity;
    message: string;
    line?: number;
    col?: number;
  },
): Finding {
  return finding({
    tool,
    layer,
    file: posix.join(root, path),
    line: f.line ?? 1,
    col: f.col ?? 1,
    ruleId: f.ruleId,
    severity: f.severity,
    message: f.message,
    fixable: false,
  });
}
