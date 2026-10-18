import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { configFolderOf, toolAdopted, upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  existingFiles,
  finding,
  fromRealCwd,
  parseFindings,
  relativeFiles,
} from "./base.js";

/** One diagnostic of `dart analyze --format=json` (3.13.5). */
interface Diagnostic {
  code?: unknown;
  severity?: unknown;
  location?: {
    file?: unknown;
    range?: { start?: { line?: unknown; column?: unknown } };
  };
  problemMessage?: unknown;
  correctionMessage?: unknown;
  documentation?: unknown;
}

interface AnalyzeTask {
  /** Each file's nearest analysis_options.yaml, absolute, POSIX. */
  options: string[];
}

const SEVERITY: Record<string, Severity> = {
  ERROR: "error",
  WARNING: "warning",
  // Lints are INFO by default: style the project did not raise to a warning.
  INFO: "info",
};

const OPTIONS = "analysis_options.yaml";

/** Where the project chose the Dart tools: its analysis_options.yaml. */
const adopted = (step: RegExp) => (root: string, projectRoot: string) =>
  toolAdopted(root, projectRoot, { configs: [OPTIONS], step });

/** The seed's Dart files that exist: `dart format` passes a missing path. */
function existing(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
  const files = existingFiles(seed, env, "dart");
  return files.length === 0 ? [] : [{ cwd: seed.cwd, files }];
}

/**
 * The package's dependencies were declared but never fetched: the analyzer
 * then reports every import of them as an error (`uri_does_not_exist`).
 */
function unfetched(packageDir: string, projectRoot: string): boolean {
  let pubspec: unknown;
  try {
    pubspec = parseYaml(readFileSync(join(packageDir, "pubspec.yaml"), "utf8"));
  } catch {
    return false;
  }
  const p = pubspec as {
    dependencies?: unknown;
    dev_dependencies?: unknown;
    resolution?: unknown;
  } | null;
  const declares = [p?.dependencies, p?.dev_dependencies].some(
    (deps) =>
      deps !== null && typeof deps === "object" && Object.keys(deps).length > 0,
  );
  // Only a pub workspace member's package config is at the workspace root;
  // another package's above it does not resolve this one's dependencies.
  const dirs =
    p?.resolution === "workspace"
      ? upTo(packageDir, projectRoot)
      : [packageDir];
  return (
    declares &&
    !dirs.some((dir) =>
      existsSync(join(dir, ".dart_tool", "package_config.json")),
    )
  );
}

/** `line 1, column 13 of lib/broken.dart: Expected an identifier.` */
const PARSE_ERROR = /^line (\d+), column (\d+) of (.+?): (.*)$/;

/**
 * What else dart format prints for a file it cannot parse: its header, and
 * the source excerpt under each error (box-drawing frame, line numbers).
 */
const PARSE_NOISE =
  /^(?:Could not format because the source could not be parsed:|\s*\d*\s*[─-╿].*|\s*)$/;

/**
 * dart format — the Dart formatter, as a check: each file it would change,
 * at line 1 (it names files, not places). Where the project chose it: an
 * `analysis_options.yaml` at or above the package (it holds the formatter's
 * page width too), a step that runs it, `tools.dart-format.enabled`. Only
 * files that exist (a missing path passes). `--fix` runs `dart format`,
 * layout only. Analytics are suppressed for the run (no network). Recorded
 * on Dart 3.13.5:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 3.
 */
export const dartFormat: ToolAdapter = {
  id: "dart-format",
  layer: "format",
  languages: ["dart"],
  bin: "dart",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "3.13.5",
  installHint: "brew install dart-lang/dart/dart  (or: the Flutter SDK)",
  adoptedAt: adopted(/\bdart\s+format\b/),
  adoptHint:
    "Add an analysis_options.yaml to the package, or set `tools.dart-format.enabled: true`.",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "syntax-error",
  expand: existing,

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-o|--output|--set-exit-if-changed|--show|--summary)(=|$)/.test(arg),
    )
      ? "the kit sets what dart format writes and prints"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--suppress-analytics",
        "format",
        ...(ctx.fix ? [] : ["--output=none", "--set-exit-if-changed"]),
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "dart format"),
      ],
      // 65: a file did not parse (the others were still checked).
      okExitCodes: [0, 1, 65],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    const lines = raw.stdout.split(/\r?\n/).map((line) => line.trim());
    if (!lines.some((line) => /^Formatted (no files|\d+ files?) /.test(line)))
      throw new Error(
        `dart format printed no summary line (exit ${raw.exitCode}): ${raw.stderr.trim().split("\n")[0] ?? ""}`,
      );
    for (const line of lines) {
      const changed = /^Changed (.+)$/.exec(line)?.[1];
      if (changed === undefined || ctx.fix) continue;
      findings.push(
        finding({
          tool: "dart-format",
          layer: "format",
          language: "dart",
          file: absPosix(ctx.cwd, changed),
          line: 1,
          col: 1,
          ruleId: "format",
          severity: "warning",
          message: "not formatted as `dart format` would: run `check --fix`",
          fixable: true,
        }),
      );
    }
    // Parse errors on stderr, whatever the exit (65 when only unparsable
    // files were given, 1 when another one changed too). Any other text
    // (`No file or directory found at "x"`) is a failure the exit code
    // does not show.
    for (const text of raw.stderr.split(/\r?\n/)) {
      const m = PARSE_ERROR.exec(text.trim());
      if (!m?.[3] || !m[4]) {
        if (PARSE_NOISE.test(text)) continue;
        throw new Error(`dart format failed: ${text.trim()}`);
      }
      findings.push(
        finding({
          tool: "dart-format",
          layer: "format",
          language: "dart",
          file: absPosix(ctx.cwd, m[3]),
          line: Number(m[1]),
          col: Number(m[2]),
          ruleId: "syntax-error",
          severity: "error",
          message: m[4],
          fixable: false,
        }),
      );
    }
    if (
      raw.exitCode === 65 &&
      !findings.some((f) => f.ruleId === "syntax-error")
    )
      throw new Error(
        `dart format exited 65 (a file it cannot parse) with no parse error: ${raw.stderr.trim().split("\n")[0] ?? ""}`,
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

/**
 * dart analyze — the Dart analyzer on the changed files: compile errors,
 * warnings, and the lints the project's analysis_options.yaml turns on (INFO,
 * which does not gate, unless the config raises them; `--fatal-infos` is
 * off). Where the project chose it: an `analysis_options.yaml` at or above
 * the package, a step that runs it, `tools.dart-analyze.enabled`. A package
 * whose dependencies were never fetched cannot run (exit 3 under `ci`, as
 * tsc's missing dependencies) and says to run `dart pub get` (the kit never
 * fetches: that is network): the analyzer would report every import of
 * them as an error. Analytics are suppressed for the run. Recorded on Dart
 * 3.13.5:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 3.
 */
export const dartAnalyze: ToolAdapter = {
  id: "dart-analyze",
  layer: "lint",
  languages: ["dart"],
  bin: "dart",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "3.13.5",
  installHint: "brew install dart-lang/dart/dart  (or: the Flutter SDK)",
  adoptedAt: adopted(/\bdart\s+analyze\b/),
  adoptHint:
    "Add an analysis_options.yaml to the package, or set `tools.dart-analyze.enabled: true`.",
  // 1: infos under --fatal-infos; 2: warnings; 3: errors.
  findingExitCodes: [1, 2, 3],

  // Its task runs from the package's folder (pubspec.yaml is dart's marker).
  expand(seed, env) {
    const optionsOf = configFolderOf(env.projectRoot, [OPTIONS]);
    const tasks = existing(seed, env);
    for (const task of tasks) {
      if (unfetched(task.cwd, env.projectRoot))
        task.cannotRun = `${task.cwd}/pubspec.yaml declares dependencies that were never fetched (no .dart_tool/package_config.json): run \`dart pub get\` first, or the analyzer reports every import of them as an error`;
      // Each file's analysis_options.yaml: analysing a file whose options do
      // not parse passes in silence; named, the options exit 3.
      const options: AnalyzeTask = {
        options: [
          ...new Set(
            (task.files ?? []).flatMap((file) => {
              const dir = optionsOf(file);
              return dir === undefined ? [] : [toPosix(join(dir, OPTIONS))];
            }),
          ),
        ],
      };
      task.options = options;
    }
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--format(=|$)/.test(arg))
      ? "the kit reads dart analyze's JSON output"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--suppress-analytics",
        "analyze",
        "--format=json",
        ...ctx.extraArgs,
        ...relativeFiles(ctx, "dart analyze"),
        ...((ctx.options as AnalyzeTask | undefined)?.options ?? []).map(
          (path) => posix.relative(toPosix(ctx.cwd), path),
        ),
      ],
      okExitCodes: [0, 1, 2, 3],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { root, items } = parseFindings<Diagnostic>(
      "dart analyze",
      raw,
      "diagnostics",
    );
    if ((root as { version?: unknown }).version !== 1)
      throw new Error(
        "dart analyze's JSON is not version 1: its output format may have changed; refusing to report it.",
      );
    // Exit 3 and no diagnostic: an analysis_options.yaml that does not parse
    // (the JSON leaves it out; a text-mode run names it).
    const options = (ctx.options as AnalyzeTask | undefined)?.options ?? [];
    if (raw.exitCode === 3 && items.length === 0)
      throw new Error(
        `dart analyze exited 3 with no diagnostic: ${options.join(", ") || "its analysis_options.yaml"} does not parse (\`dart analyze\` in ${ctx.cwd} says where)`,
      );
    // Absolute, and the real path (/private/tmp for /tmp).
    const fileOf = fromRealCwd(ctx.cwd);
    const findings = items.map((d) => {
      const start = d.location?.range?.start;
      const severity =
        typeof d.severity === "string" ? SEVERITY[d.severity] : undefined;
      if (
        typeof d.code !== "string" ||
        typeof d.problemMessage !== "string" ||
        typeof d.location?.file !== "string" ||
        typeof start?.line !== "number" ||
        typeof start.column !== "number" ||
        severity === undefined
      )
        throw new Error(
          `dart analyze reported a diagnostic without a code, message, file, position or known severity (${JSON.stringify(d.severity)}): its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "dart-analyze",
        layer: "lint",
        language: "dart",
        file: fileOf(d.location.file),
        line: start.line,
        col: start.column,
        ruleId: d.code,
        severity,
        message:
          typeof d.correctionMessage === "string"
            ? `${d.problemMessage} ${d.correctionMessage}`
            : d.problemMessage,
        fixable: false,
        ...(typeof d.documentation === "string"
          ? { url: d.documentation }
          : {}),
      });
    });
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
