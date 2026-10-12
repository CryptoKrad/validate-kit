import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import pLimit from "p-limit";
import { checkAvailability, toolAvailability } from "../adapters/base.js";
import type { RunEvidence } from "./evidence.js";
import { run } from "./exec.js";
import { groupBy } from "./group.js";
import { EXIT, type ExitCode } from "./exit-codes.js";
import type { PlannedTask } from "./plan.js";
import { toPosix } from "../detect/languages.js";
import type {
  Finding,
  ResolvedConfig,
  Severity,
  ToolContext,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 240_000;

export interface ToolIssue {
  id: string;
  hint: string;
  /**
   * Why it cannot run: its version command failed, its configured executable
   * is missing, or it is missing from some of its folders.
   */
  problem?: string;
}
export interface CrashIssue {
  id: string;
  stderr: string;
}

/**
 * What happened to one tool: `pass` ran clean, `fail` reported a gating
 * finding, `inconclusive` crashed or timed out, `not_run` was missing or
 * could not cover part of its scope. Only `pass` means the tool vouches for
 * the code.
 */
export type ToolStatus = "pass" | "fail" | "inconclusive" | "not_run";

export interface RunSummary {
  scope: RunScope;
  findings: Finding[];
  incomplete: ToolIssue[];
  skippedOptional: ToolIssue[];
  crashed: CrashIssue[];
  fixesByTool: Record<string, number>;
  filesByTool: Record<string, number>;
  ranTools: string[];
  toolStatus: Record<string, ToolStatus>;
  /** Each tool's version, as its availability probe read it. */
  toolVersions: Record<string, string>;
  durationMs: number;
  exitCode: ExitCode;
  fixMode: boolean;
  /** What the run was produced from; collected only when a caller asks. */
  evidence?: RunEvidence;
  /** Set when a baseline judged the run: how many findings it accepted. */
  baseline?: { baselined: number; stale: number };
}

export interface RunScope {
  profile: string;
  mode: "full" | "changed" | "staged" | "since";
  files: number | null;
}

export interface ExecuteOptions {
  projectRoot: string;
  config: ResolvedConfig;
  tasks: PlannedTask[];
  fix: boolean;
  scope: RunScope;
  /**
   * The `ci` profile: a missing tool is never a skip, optional or not.
   * Coverage the project planned but did not get is incomplete (exit 3).
   */
  strict?: boolean;
  /**
   * The tasks that run first (the policy check) already ran before planning
   * reached the project's code: here they run only after the others.
   */
  checkedFirst?: boolean;
}

interface TaskOutcome {
  findings: Finding[];
  crashed?: CrashIssue;
  spawnFailed?: boolean;
  filesScanned: number;
}

interface SequencedTaskOutcome {
  task: PlannedTask;
  outcome: TaskOutcome;
}

function buildContext(
  task: PlannedTask,
  fix: boolean,
  tempDir: () => string,
): ToolContext {
  return {
    cwd: task.cwd,
    fix,
    tempDir,
    extraArgs: task.toolConfig.extraArgs ?? [],
    ...(task.files ? { files: task.files } : {}),
    ...(task.toolConfig.configPath
      ? { configPath: task.toolConfig.configPath }
      : {}),
    ...(task.options !== undefined ? { options: task.options } : {}),
  };
}

function applyToolSeverity(
  findings: Finding[],
  severity: Severity | undefined,
): Finding[] {
  if (!severity) return findings;
  return findings.map((f) => ({ ...f, severity }));
}

function applyOverrides(
  findings: Finding[],
  config: ResolvedConfig,
): Finding[] {
  if (config.severityOverrides.length === 0) return findings;
  const out: Finding[] = [];
  for (const f of findings) {
    // Precedence: an exact ruleId override always wins over a "*" wildcard for
    // the same tool. Without this, a `{tool,"*",off}` entry that appears before
    // a specific `{tool,rule,error}` re-enable would suppress the real error
    // (the canonical mute-then-reenable config) → false CLEAN.
    const exact = config.severityOverrides.find(
      (o) => o.tool === f.tool && o.ruleId === f.ruleId,
    );
    const ov =
      exact ??
      config.severityOverrides.find(
        (o) => o.tool === f.tool && o.ruleId === "*",
      );
    if (!ov) {
      out.push(f);
      continue;
    }
    if (ov.severity === "off") continue;
    out.push({ ...f, severity: ov.severity });
  }
  return out;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.tool}|${f.file}|${f.line}|${f.col}|${f.ruleId ?? ""}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.toSorted(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.col - b.col ||
      a.tool.localeCompare(b.tool),
  );
}

function countByTool(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.tool] = (counts[f.tool] ?? 0) + 1;
  return counts;
}

/** What a write-back fix task can touch: its explicit file list if it has one,
 * otherwise everything under its cwd (project-scoped tools like ast-grep). */
interface WriteScope {
  dir?: string;
  files?: string[];
}

function writeScopeOf(task: PlannedTask): WriteScope {
  if (task.files) {
    return { files: task.files.map((f) => resolve(task.cwd, f)) };
  }
  return { dir: resolve(task.cwd) };
}

function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scopesOverlap(a: WriteScope, b: WriteScope): boolean {
  if (a.dir !== undefined && b.dir !== undefined) {
    return isWithin(a.dir, b.dir) || isWithin(b.dir, a.dir);
  }
  if (a.dir !== undefined) {
    const dir = a.dir;
    return (b.files ?? []).some((f) => isWithin(f, dir));
  }
  if (b.dir !== undefined) {
    const dir = b.dir;
    return (a.files ?? []).some((f) => isWithin(f, dir));
  }
  const bFiles = new Set(b.files);
  return (a.files ?? []).some((f) => bFiles.has(f));
}

async function runSequentially(
  group: PlannedTask[],
  runTask: (task: PlannedTask, fix: boolean) => Promise<TaskOutcome>,
): Promise<SequencedTaskOutcome[]> {
  const outcomes: SequencedTaskOutcome[] = [];
  await group.reduce<Promise<void>>(
    (previous, task) =>
      previous.then(async () => {
        outcomes.push({ task, outcome: await runTask(task, true) });
      }),
    Promise.resolve(),
  );
  return outcomes;
}

/** Orchestrate a full validation run: availability → read-only pass → optional
 * fix pass → re-read → severity resolution → exit code. */
export async function execute(opts: ExecuteOptions): Promise<RunSummary> {
  // Tasks' scratch directories share one root, made on first use and removed
  // when the run ends: also in a long-lived process (the MCP server) and
  // after a task timed out.
  let scratchRoot: string | undefined;
  const tempDir = (): string => {
    scratchRoot ??= mkdtempSync(join(tmpdir(), "validate-kit-run-"));
    return mkdtempSync(join(scratchRoot, "task-"));
  };
  try {
    // A tool that reads the tree as the patch left it (the policy check) runs
    // alone before any other tool is probed or run, and again after them all:
    // a config file a tool executes, a test, a build script is the patch's
    // code, and could change the tree before or during the check.
    const first = opts.tasks.filter((task) => task.adapter.runsFirst);
    const rest = opts.tasks.filter((task) => !task.adapter.runsFirst);
    // With nothing else to run, once is enough.
    if (first.length === 0 || rest.length === 0)
      return await executeTasks(opts, tempDir);
    const startedAt = Date.now();
    const alone = { ...opts, tasks: first, fix: false };
    const parts = opts.checkedFirst ? [] : [await executeTasks(alone, tempDir)];
    parts.push(await executeTasks({ ...opts, tasks: rest }, tempDir));
    parts.push(await executeTasks(alone, tempDir));
    return mergeSummaries(parts, Date.now() - startedAt);
  } finally {
    try {
      if (scratchRoot)
        rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A temp directory left behind must not replace the run's verdict.
    }
  }
}

/** An error or a warning: what decides the exit code. */
export function isGating(finding: Finding): boolean {
  return finding.severity === "error" || finding.severity === "warning";
}

export function exitCodeOf(
  findings: readonly Finding[],
  crashed: readonly CrashIssue[],
  incomplete: readonly ToolIssue[],
): ExitCode {
  if (crashed.length > 0) return EXIT.INTERNAL;
  if (incomplete.length > 0) return EXIT.INCOMPLETE;
  return findings.some(isGating) ? EXIT.FINDINGS : EXIT.CLEAN;
}

const STATUS_RANK: Record<ToolStatus, number> = {
  pass: 0,
  fail: 1,
  not_run: 2,
  inconclusive: 3,
};

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/** One issue per tool and reason: a tool may have several (tsc). */
function uniqueIssues(items: readonly ToolIssue[]): ToolIssue[] {
  return [
    ...new Map(
      items.map((item) => [`${item.id}\0${item.problem ?? ""}`, item]),
    ).values(),
  ];
}

/**
 * One summary of several runs, which may share a tool (the policy check runs
 * before and after the rest): a tool's worst status and largest file count
 * win, findings are deduplicated. The last part sets scope and fix mode.
 */
export function mergeSummaries(
  parts: readonly RunSummary[],
  durationMs: number,
): RunSummary {
  const last = parts.at(-1);
  if (!last) throw new Error("mergeSummaries needs at least one summary");
  const findings = sortFindings(dedupe(parts.flatMap((p) => p.findings)));
  const crashed = uniqueById(parts.flatMap((p) => p.crashed));
  const incomplete = uniqueIssues(parts.flatMap((p) => p.incomplete));
  const toolStatus: Record<string, ToolStatus> = {};
  const filesByTool: Record<string, number> = {};
  const fixesByTool: Record<string, number> = {};
  for (const part of parts) {
    for (const [id, status] of Object.entries(part.toolStatus)) {
      const known = toolStatus[id];
      if (!known || STATUS_RANK[status] > STATUS_RANK[known])
        toolStatus[id] = status;
    }
    for (const [id, n] of Object.entries(part.filesByTool))
      filesByTool[id] = Math.max(filesByTool[id] ?? 0, n);
    for (const [id, n] of Object.entries(part.fixesByTool))
      fixesByTool[id] = Math.max(fixesByTool[id] ?? 0, n);
  }
  return {
    scope: last.scope,
    findings,
    incomplete,
    skippedOptional: uniqueIssues(parts.flatMap((p) => p.skippedOptional)),
    crashed,
    fixesByTool,
    filesByTool,
    ranTools: Object.keys(toolStatus).filter(
      (id) => toolStatus[id] === "pass" || toolStatus[id] === "fail",
    ),
    toolStatus,
    toolVersions: Object.fromEntries(
      parts.flatMap((p) => Object.entries(p.toolVersions)),
    ),
    durationMs,
    exitCode: exitCodeOf(findings, crashed, incomplete),
    fixMode: last.fixMode,
  };
}

async function executeTasks(
  opts: ExecuteOptions,
  tempDir: () => string,
): Promise<RunSummary> {
  const startedAt = Date.now();
  const { config, tasks } = opts;

  const incomplete: ToolIssue[] = [];
  const skippedOptional: ToolIssue[] = [];
  const filesByTool: Record<string, number> = {};
  const runtimeUnavailable = new Set<string>();

  // --- availability: one probe per executable a tool's tasks resolve to ---
  const byTool = groupBy(tasks, (t) => t.adapter.id);
  const unavailable = new Set<string>();
  // Tools that could not cover part of their scope.
  const partial = new Set<string>();
  const missing = new Set<PlannedTask>();
  const toolVersions: Record<string, string> = {};
  const record = (issue: ToolIssue, optional: boolean | undefined): void => {
    const target = optional && !opts.strict ? skippedOptional : incomplete;
    if (
      !target.some(
        (known) => known.id === issue.id && known.problem === issue.problem,
      )
    )
      target.push(issue);
  };
  const limit = pLimit(Math.max(1, config.concurrency));
  await Promise.all(
    [...byTool].map(async ([id, own]) => {
      const found = await toolAvailability(
        own,
        opts.projectRoot,
        (adapter, cwd, pathOnly) =>
          limit(() => checkAvailability(adapter, cwd, pathOnly)),
      );
      if (found.versions.length > 0)
        toolVersions[id] = found.versions.join(", ");
      if (found.lacking.length === 0) return;
      for (const task of found.lacking) missing.add(task);
      if (found.lacking.length === own.length) unavailable.add(id);
      else partial.add(id);
      const adapter = own[0]?.adapter;
      record(
        {
          id,
          hint: adapter?.installHint ?? "",
          ...(found.problem ? { problem: found.problem } : {}),
        },
        adapter?.optional === true && !found.configuredMissing,
      );
    }),
  );

  // Tasks the adapter planned as impossible here: coverage the run does not
  // have, said with the adapter's reason, and treated as a missing tool.
  for (const task of tasks) {
    if (task.cannotRun === undefined) continue;
    partial.add(task.adapter.id);
    record(
      {
        id: task.adapter.id,
        hint: task.adapter.installHint,
        problem: task.cannotRun,
      },
      task.adapter.optional,
    );
  }
  const runnable = tasks.filter(
    (t) => !missing.has(t) && t.cannotRun === undefined,
  );
  // Optional-tool policy (intentional asymmetry): MISSING optional tool =
  // user chose not to install it → visible skippedOptional, run stays CLEAN.
  // PRESENT-but-crashing optional tool = coverage the user provisioned was
  // silently lost → INTERNAL, same as required tools (matches the timeout
  // policy: a security tool that breaks must never read as "clean").
  const recordOutcomeIssue = (
    task: PlannedTask,
    outcome: TaskOutcome,
    crashTarget: CrashIssue[],
  ): void => {
    if (outcome.spawnFailed) {
      runtimeUnavailable.add(task.adapter.id);
      const target =
        task.adapter.optional && !opts.strict ? skippedOptional : incomplete;
      // A cannot-run reason for the same tool is another issue.
      if (
        !target.some(
          (issue) =>
            issue.id === task.adapter.id && issue.problem === undefined,
        )
      ) {
        target.push({ id: task.adapter.id, hint: task.adapter.installHint });
      }
    }

    const crashedIssue = outcome.crashed;
    if (
      crashedIssue &&
      !crashTarget.some((issue) => issue.id === crashedIssue.id)
    ) {
      crashTarget.push(crashedIssue);
    }
  };

  const runTask = async (
    task: PlannedTask,
    fix: boolean,
  ): Promise<TaskOutcome> => {
    const ctx = buildContext(task, fix, tempDir);
    // buildArgs can do real work (astgrep writes a generated sgconfig to
    // tmpdir) — a throw here must crash THIS adapter, not abort the whole run.
    let cmd;
    try {
      cmd = task.adapter.buildArgs(ctx);
    } catch (err) {
      return {
        findings: [],
        crashed: {
          id: task.adapter.id,
          stderr: (err instanceof Error ? err.message : String(err)).slice(
            0,
            2000,
          ),
        },
        filesScanned: 0,
      };
    }
    const timeoutMs =
      task.toolConfig.timeoutMs ?? task.adapter.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const raw = await run(cmd.bin, cmd.args, {
      cwd: cmd.cwd ?? task.cwd,
      ...(cmd.env ? { env: cmd.env } : {}),
      ...(cmd.processGroup ? { ownProcessGroup: true } : {}),
      ...(task.toolConfig.bin !== undefined ? { pathOnly: true } : {}),
      timeoutMs,
    });
    if (raw.spawnError)
      return { findings: [], spawnFailed: true, filesScanned: 0 };
    // A timeout is a hard failure, never a silent skip: treat it as a crash so it
    // forces EXIT.INTERNAL for BOTH required and optional tools (a security tool
    // that times out must not be reported as "clean"). Do not attach an install
    // hint — the tool exists, it was too slow.
    if (raw.timedOut) {
      return {
        findings: [],
        crashed: {
          id: task.adapter.id,
          stderr: `${task.adapter.id} timed out after ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`} (scope down, raise concurrency limits, or split the run)`,
        },
        filesScanned: ctx.files?.length ?? 0,
      };
    }
    const ok =
      raw.exitCode === 0 ||
      cmd.okExitCodes === "any" ||
      (cmd.okExitCodes ?? [0]).includes(raw.exitCode);
    if (!ok) {
      return {
        findings: [],
        crashed: {
          id: task.adapter.id,
          stderr: (raw.stderr || raw.stdout).slice(0, 2000),
        },
        filesScanned: ctx.files?.length ?? 0,
      };
    }
    let result;
    try {
      result = task.adapter.parseOutput(raw, ctx);
    } catch (err) {
      return {
        findings: [],
        crashed: {
          id: task.adapter.id,
          stderr: (err instanceof Error ? err.message : String(err)).slice(
            0,
            2000,
          ),
        },
        filesScanned: ctx.files?.length ?? 0,
      };
    }
    // The tool said it found something and the output holds nothing. Not in
    // a fix pass: a tool may exit 1 for having fixed (ruff's
    // --exit-non-zero-on-fix), and the read-only pass after it checks again.
    if (
      !fix &&
      result.findings.length === 0 &&
      // The exit as the adapter reads it: one that says nothing was linted
      // is not a findings exit.
      task.adapter.findingExitCodes?.includes(result.rawExitCode) === true
    ) {
      return {
        findings: [],
        crashed: {
          id: task.adapter.id,
          stderr: `${task.adapter.id} exited ${raw.exitCode}, which means it reported findings, but its output holds none: its output format may have changed.${raw.stderr.trim() ? ` ${raw.stderr.trim().slice(0, 1500)}` : ""}`,
        },
        filesScanned: ctx.files?.length ?? 0,
      };
    }
    const withSeverity = applyToolSeverity(
      result.findings,
      task.toolConfig.severity,
    );
    // Which config produced each finding: the repository's own gate may run
    // the tool with another (R11 row 9).
    for (const f of withSeverity) {
      const used =
        f.config ?? task.adapter.configFor?.(f, ctx) ?? ctx.configPath;
      if (used) f.config = toPosix(used);
    }
    return { findings: withSeverity, filesScanned: ctx.files?.length ?? 0 };
  };

  // `final`: the pass whose findings are the verdict; only it counts files.
  const readonlyPass = async (
    passTasks: PlannedTask[],
    crashTarget: CrashIssue[],
    final: boolean,
  ): Promise<Finding[]> => {
    const outcomes = await Promise.all(
      passTasks.map((t) => limit(() => runTask(t, false))),
    );
    const findings: Finding[] = [];
    outcomes.forEach((o, i) => {
      const task = passTasks[i];
      const id = task?.adapter.id ?? "?";
      if (final) filesByTool[id] = (filesByTool[id] ?? 0) + o.filesScanned;
      if (task) recordOutcomeIssue(task, o, crashTarget);
      findings.push(...o.findings);
    });
    return findings;
  };

  // --- read-only pass (before) ---
  // Under --fix the before pass only measures what the fixers will fix; a
  // tool that cannot fix (a test suite, tsc) runs once, after the fixes,
  // which is the state that is judged.
  const fixTasks = runnable.filter(
    (t) => t.adapter.supportsFix && t.adapter.fixWriteBack,
  );
  const crashedBefore: CrashIssue[] = [];
  const before = await readonlyPass(
    opts.fix ? fixTasks : runnable,
    crashedBefore,
    !opts.fix,
  );
  let crashed = crashedBefore;

  let finalFindings = before;
  const fixesByTool: Record<string, number> = {};

  if (opts.fix) {
    // Cluster fix-capable tasks by overlapping WRITE SCOPE (not by exact cwd):
    // two write-back tasks that can touch the same file — nested roots, a
    // project-scoped fixer above a sub-dir formatter, or shared explicit file
    // lists in changed mode — must never run concurrently or edits get lost.
    // Disjoint clusters run in parallel; within a cluster tasks run
    // sequentially with formatters LAST so they normalize whitespace left
    // behind by structural lint/custom-rule edits (e.g. a deleted console.log
    // statement).
    let clusters: { scopes: WriteScope[]; tasks: PlannedTask[] }[] = [];
    for (const t of fixTasks) {
      const scope = writeScopeOf(t);
      const merged: { scopes: WriteScope[]; tasks: PlannedTask[] } = {
        scopes: [],
        tasks: [],
      };
      const disjoint: typeof clusters = [];
      for (const cluster of clusters) {
        if (cluster.scopes.some((s) => scopesOverlap(s, scope))) {
          merged.scopes.push(...cluster.scopes);
          merged.tasks.push(...cluster.tasks);
        } else {
          disjoint.push(cluster);
        }
      }
      merged.scopes.push(scope);
      merged.tasks.push(t);
      clusters = [...disjoint, merged];
    }
    const fixOutcomes = await Promise.all(
      clusters.map(({ tasks: group }) =>
        limit(() =>
          runSequentially(
            group.toSorted(
              (a, b) =>
                (a.adapter.layer === "format" ? 1 : 0) -
                (b.adapter.layer === "format" ? 1 : 0),
            ),
            runTask,
          ),
        ),
      ),
    );
    const crashedInFix: CrashIssue[] = [];
    for (const groupOutcomes of fixOutcomes) {
      for (const { task, outcome } of groupOutcomes) {
        recordOutcomeIssue(task, outcome, crashedInFix);
      }
    }

    const crashedAfter: CrashIssue[] = [];
    const after = await readonlyPass(runnable, crashedAfter, true);
    // Crash state is judged on the FINAL passes: a tool that crashed only in
    // the before pass but ran clean through fix + after was transient — the
    // final findings are complete, so the run must not report INTERNAL.
    crashed = [...crashedInFix];
    for (const issue of crashedAfter) {
      if (!crashed.some((c) => c.id === issue.id)) crashed.push(issue);
    }
    // fixes = reduction in per-tool finding count. A fixer that INTRODUCES
    // findings clamps to 0 here — that regression is not hidden: the new
    // findings land in `after`, gate the exit code, and show as issues on the
    // offending tool in every report.
    const b = countByTool(before);
    const a = countByTool(after);
    for (const tool of new Set([...Object.keys(b), ...Object.keys(a)])) {
      fixesByTool[tool] = Math.max(0, (b[tool] ?? 0) - (a[tool] ?? 0));
    }
    finalFindings = after;
  }

  finalFindings = sortFindings(dedupe(applyOverrides(finalFindings, config)));
  const exitCode = exitCodeOf(finalFindings, crashed, incomplete);

  const gatingTools = new Set(
    finalFindings
      .filter((f) => f.severity === "error" || f.severity === "warning")
      .map((f) => f.tool),
  );
  const toolStatus: Record<string, ToolStatus> = {};
  // A tool that could not run, or could not cover part of its scope and
  // found nothing in the rest, vouches for nothing.
  for (const id of byTool.keys()) {
    toolStatus[id] =
      unavailable.has(id) || runtimeUnavailable.has(id)
        ? "not_run"
        : crashed.some((issue) => issue.id === id)
          ? "inconclusive"
          : gatingTools.has(id)
            ? "fail"
            : partial.has(id)
              ? "not_run"
              : "pass";
  }

  return {
    scope: opts.scope,
    findings: finalFindings,
    incomplete,
    skippedOptional,
    crashed,
    fixesByTool,
    filesByTool,
    ranTools: [...byTool.keys()].filter(
      (id) => toolStatus[id] === "pass" || toolStatus[id] === "fail",
    ),
    toolStatus,
    toolVersions,
    durationMs: Date.now() - startedAt,
    exitCode,
    fixMode: opts.fix,
  };
}
