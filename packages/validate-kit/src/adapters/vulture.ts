import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
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
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { gitFiles, ignoredBy } from "./native.js";

/** `mod.py:5: unused function 'unused_helper' (60% confidence)`, `, 2 lines` under --sort-by-size. */
const LINE = /^(.+?):(\d+): (.+) \((\d+)% confidence(?:, \d+ lines?)?\)$/;

/** Folders that hold a Python project of their own. */
const MARKERS = new Set(["pyproject.toml", "setup.py", "setup.cfg"]);

interface VultureTask {
  /**
   * The package's Python files, relative to it; none where the config's
   * `paths` name what to read.
   */
  files?: string[];
}

/**
 * A report line's rule and what to do about it: an unused name can be
 * whitelisted, a condition that is always true or false cannot (vulture
 * 2.16, core.py and reachability.py).
 */
function ruleOf(message: string): { rule: string; todo: string } {
  const kind = /^unused (\w+) '/.exec(message)?.[1];
  if (kind)
    return {
      rule: `unused-${kind}`,
      todo: "remove it, or name it in a whitelist file vulture reads",
    };
  if (/^(unsatisfiable|redundant) /.test(message))
    return {
      rule: "unsatisfiable-condition",
      todo: "fix the condition, or remove the code it decides",
    };
  return { rule: "unreachable-code", todo: "remove it" };
}

/** The `[tool.vulture]` table of the folder's own pyproject.toml. */
function vultureTable(dir: string): Record<string, unknown> | undefined {
  try {
    const doc = parseToml(readFileSync(join(dir, "pyproject.toml"), "utf8"));
    const table = (doc.tool as { vulture?: unknown } | undefined)?.vulture;
    return typeof table === "object" && table !== null
      ? (table as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * vulture — dead Python code: functions, classes, variables, imports and
 * attributes nothing uses, and code after a return. A warning each, with
 * vulture's confidence (60% is a guess: a name used dynamically looks
 * unused). It judges "unused" from every file it reads, so it reads the
 * whole package, also in a changed-file run. Where the package chose it: a
 * `[tool.vulture]` table in its pyproject.toml, which vulture reads from the
 * folder it runs in only (its `min_confidence`, `exclude`, `ignore_names`
 * and `paths` hold), or `tools.vulture.enabled`. Without `paths` it reads
 * the kit's Python files of the package and the dotfile ones git has (a
 * `.vulture_whitelist.py`), never `.` (which would take in a `.venv`).
 * Recorded on 2.16:
 * docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 6.
 */
export const vulture: ToolAdapter = {
  id: "vulture",
  layer: "lint",
  languages: ["python"],
  bin: "vulture",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "verify",
  minVersion: "2.16",
  installHint: "uv tool install vulture  (or: brew install vulture)",
  parseVersion: (out) => /vulture (\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1],
  adoptedAt: (root) => vultureTable(root) !== undefined,
  // 3: dead code found. 1 is invalid input (a missing file, a syntax error).
  findingExitCodes: [3],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const cwd = toPosix(seed.cwd);
    if (vultureTable(cwd)?.paths !== undefined) return [{ ...seed }];
    // A nested Python project is its own task.
    const nested = env.scopedFiles
      .filter(
        (f) =>
          MARKERS.has(posix.basename(f)) &&
          isUnder(f, cwd) &&
          posix.dirname(f) !== cwd,
      )
      .map((f) => posix.dirname(f));
    // The scope leaves dotfiles out; a whitelist is often one.
    const top = toPosix(env.projectRoot);
    const ignored = ignoredBy(env);
    const dotfiles = (gitFiles(top, env.changedMode === "staged") ?? [])
      .filter(
        (path) =>
          /(^|\/)\.[^/]+\.py$/.test(path) &&
          !/(^|\/)\.[^/]*\//.test(path) &&
          !ignored(path),
      )
      .map((path) => posix.join(top, path));
    const files = [...env.scopedFiles, ...dotfiles]
      .filter(
        (f) =>
          f.endsWith(".py") &&
          isUnder(f, cwd) &&
          !nested.some((dir) => isUnder(f, dir)),
      )
      .map((f) => posix.relative(cwd, f));
    if (files.length === 0) return [];
    const task: VultureTask = { files };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-v|--verbose|--make-whitelist)(=|$)/.test(arg))
      ? "the kit reads vulture's report lines; --verbose and --make-whitelist replace them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = (ctx.options as VultureTask | undefined)?.files ?? [];
    // shortcut: every file on one command line (vulture reads no file list);
    // a package whose paths pass ARG_MAX (~1 MB) needs `paths` in its config.
    return {
      bin: this.bin,
      args: [
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(files.length > 0 ? ["--", ...files] : []),
      ],
      okExitCodes: [0, 3],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    for (const line of raw.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = LINE.exec(line);
      if (!m?.[1] || !m[2] || !m[3])
        throw new Error(
          `vulture printed ${JSON.stringify(line)} where a report line goes: its output format may have changed; refusing to report it.`,
        );
      const { rule, todo } = ruleOf(m[3]);
      findings.push(
        finding({
          tool: "vulture",
          layer: "lint",
          language: "python",
          file: absPosix(ctx.cwd, m[1]),
          line: Number(m[2]),
          col: 1,
          ruleId: rule,
          severity: "warning",
          message: `${m[3]} (${m[4] ?? "?"}% confidence): ${todo}`,
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed:
        (ctx.options as VultureTask | undefined)?.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
