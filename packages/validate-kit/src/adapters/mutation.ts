import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type {
  Finding,
  Language,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolContext,
} from "../core/types.js";
import { isUnder, languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/**
 * What every mutation adapter shares: a run costs a test run per mutant, so
 * it is opt-in, in the `deep` tier (the `ci` profile), with a long timeout
 * (docs/research/lint-toolchain/mutation-testing/findings.md).
 */
export const MUTATION_TOOL = {
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  optional: true,
  tier: "deep",
  timeoutMs: 1_800_000,
} as const;

/** What a mutation tool's task carries from planning to its command. */
export interface MutationTask {
  /**
   * A changed-file run's changed source files, relative to the task's folder
   * (POSIX). Undefined in a full run: the tool's own config decides.
   */
  targets?: string[];
  /** Files whose surviving mutants count (absolute, POSIX): the kit's scope. */
  scope: string[];
}

const JS_TESTS =
  /(?:^|\/)(?:tests?|__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/** Each language's tests, test data and declarations: nothing to mutate. */
const TEST_FILES: Partial<Record<Language, RegExp>> = {
  ts: JS_TESTS,
  js: JS_TESTS,
  rust: /(?:^|\/)(?:tests|benches|examples)\//,
  python:
    /(?:^|\/)(?:tests?|__tests__)\/|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/,
  go: /_test\.go$|(?:^|\/)testdata\//,
};

/** A test of its language, by its path relative to the task's folder. */
export function isTestFile(path: string): boolean {
  const lang = languageForFile(path);
  return lang !== undefined && (TEST_FILES[lang]?.test(path) ?? false);
}

/** A file's name without its extension or test marks: what a test is named after. */
function stem(path: string): string {
  return posix
    .basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(?:test|spec)$/, "")
    .replace(/^test_|_test$/g, "");
}

/**
 * The sources a changed test checks, so that weakening a test is judged too:
 * in Go its package (the folder), elsewhere the sources named like it
 * (`calc.test.ts`, `test_calc.py` and `tests/calc.rs` check `calc`).
 */
function testedBy(test: string, sources: readonly string[]): string[] {
  if (test.endsWith(".go"))
    return sources.filter(
      (source) => posix.dirname(source) === posix.dirname(test),
    );
  return sources.filter((source) => stem(source) === stem(test));
}

/**
 * Of the files under `cwd`, those of its own project: none under a folder
 * between them that holds one of `markers` (a nested package or module,
 * which has a run of its own).
 */
function ownedBy(
  cwd: string,
  markers: readonly string[],
): (file: string) => boolean {
  const nested = new Map<string, boolean>();
  const isNested = (dir: string): boolean => {
    if (dir === cwd || !isUnder(dir, cwd)) return false;
    let found = nested.get(dir);
    if (found === undefined) {
      found =
        markers.some((name) => existsSync(join(dir, name))) ||
        isNested(posix.dirname(dir));
      nested.set(dir, found);
    }
    return found;
  };
  return (file) => !isNested(posix.dirname(file));
}

/**
 * Plan one mutation run: the kit's scope under the task's folder, without a
 * nested project's files (`nested`: its markers). In a changed-file run the
 * targets are the changed sources and the sources a changed test checks; a
 * mutant in a test is no gap in the tests. A change with none plants nothing.
 */
export function planMutation(
  seed: TaskSeed,
  env: PlanEnv,
  languages: readonly Language[],
  nested: readonly string[] = [],
): TaskSeed[] {
  const cwd = toPosix(seed.cwd);
  const own = ownedBy(cwd, nested);
  const scope = env.scopedFiles.filter((file) => {
    const lang = languageForFile(file);
    return (
      lang !== undefined &&
      languages.includes(lang) &&
      isUnder(file, cwd) &&
      own(file)
    );
  });
  if (!env.changedPaths) {
    const task: MutationTask = { scope };
    return [{ ...seed, options: task }];
  }
  const root = toPosix(env.projectRoot);
  const changed = new Set(
    env.changedPaths.map((path) => posix.join(root, toPosix(path))),
  );
  const paths = scope.map((file) => posix.relative(cwd, file));
  const sources = paths.filter((path) => !isTestFile(path));
  const targets = new Set<string>();
  for (const [i, file] of scope.entries()) {
    const path = paths[i] ?? "";
    if (!changed.has(file)) continue;
    if (!isTestFile(path)) targets.add(path);
    else for (const source of testedBy(path, sources)) targets.add(source);
  }
  if (targets.size === 0) return [];
  const task: MutationTask = { targets: [...targets], scope };
  return [{ ...seed, options: task }];
}

/**
 * One of the tool's config files is in `root` itself: a mutation tool reads
 * its config from the folder it runs in, so one further up adopts nothing.
 */
export function configIn(root: string, names: readonly string[]): boolean {
  return names.some((name) => existsSync(join(root, name)));
}

/**
 * The file a tool names (relative to the task's folder), absolute, when its
 * mutants count: a target of a changed-file run (a tool may test more, by
 * name), else a file in the kit's scope.
 */
export function scopedFile(
  ctx: ToolContext,
): (path: string) => string | undefined {
  const cwd = toPosix(ctx.cwd);
  const task = ctx.options as MutationTask;
  const counted = new Set(
    task.targets?.map((path) => posix.join(cwd, path)) ?? task.scope,
  );
  return (path) => {
    const file = absPosix(cwd, path);
    return counted.has(file) ? file : undefined;
  };
}

/** A 1-based line and column of a report, if it holds both as numbers. */
export function position(
  p: unknown,
): { line: number; column: number } | undefined {
  const { line, column } = (p ?? {}) as { line?: unknown; column?: unknown };
  return typeof line === "number" && typeof column === "number"
    ? { line, column }
    : undefined;
}

/** The line of a tool's output that says why it failed: `prefer`'s, else the last. */
export function failureLine(raw: RawOutput, prefer?: RegExp): string {
  const lines = `${raw.stdout}\n${raw.stderr}`
    .split(/[\r\n]+/)
    .map((line) => line.trim());
  return (
    (prefer ? lines.find((line) => prefer.test(line)) : undefined) ??
    lines.findLast(Boolean) ??
    ""
  );
}

/** A report of a shape the adapter was not written for. */
export function formatChanged(tool: string, what: string): Error {
  return new Error(
    `${tool} ${what}: its output format may have changed; refusing to report it.`,
  );
}

/**
 * Survived: the tests ran the mutated code and none failed. No coverage: no
 * test runs it at all.
 */
export type MutantKind = "survived" | "no-coverage";

/** A piece of source for a message: one line, at most 60 characters. */
export function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return `\`${line.length > 60 ? `${line.slice(0, 59)}…` : line}\``;
}

/** One mutant no test caught, at the mutated code. */
export function mutantFinding(f: {
  tool: string;
  language?: Language;
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  kind: MutantKind;
  /** The mutation: what was replaced with what. */
  mutation: string;
}): Finding {
  return finding({
    tool: f.tool,
    layer: "mutation",
    ...(f.language !== undefined ? { language: f.language } : {}),
    file: f.file,
    line: f.line,
    col: f.col,
    ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
    ...(f.endCol !== undefined ? { endCol: f.endCol } : {}),
    ruleId: f.kind,
    severity: "warning",
    message: `${f.kind === "survived" ? "no test fails on" : "no test runs"} ${f.mutation}`,
    fixable: false,
  });
}

/**
 * The run's result, its mutants in one order whatever order the tool
 * reported them in (workers finish in any order; Stryker's report is not
 * sorted).
 */
export function mutationResult(
  raw: RawOutput,
  ctx: ToolContext,
  findings: Finding[],
): RunResult {
  const task = ctx.options as MutationTask;
  return {
    findings: findings.toSorted(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.col - b.col ||
        a.message.localeCompare(b.message),
    ),
    filesProcessed: task.targets?.length ?? task.scope.length,
    fixesApplied: 0,
    rawExitCode: raw.exitCode,
    stderr: raw.stderr,
  };
}
