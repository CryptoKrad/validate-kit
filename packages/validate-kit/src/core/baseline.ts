import { existsSync, readFileSync } from "node:fs";
import { posix, relative } from "node:path";
import { z } from "zod";
import { ConfigError, formatIssues } from "../config/schema.js";
import { fileAtCommit, pathsAtCommit } from "../detect/git.js";
import { toPosix } from "../detect/languages.js";
import { exitCodeOf, isGating, type RunSummary } from "./runner.js";
import type { Finding, TrustedPolicy } from "./types.js";

/**
 * Accepted debt, per file, tool and rule: a count, so moving code does not
 * break it (docs/research/baseline/README.md). Only ever lowered, except on
 * first write and the documented exceptions in `updateBaseline`.
 */
export const BASELINE_FILE = "validate.baseline.json";

const baselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    kitVersion: z.string().min(1),
    /** The version of each tool the counts were taken with. */
    tools: z.record(z.string(), z.string()),
    /**
     * Every `tool/rule` known when written: those with a finding, and every
     * active ast-grep rule (its rules ship with the kit). A rule absent here
     * is one an upgrade added.
     */
    rules: z.array(z.string()),
    /** File (relative to the project root, POSIX) → `tool/rule` → count. */
    counts: z.record(
      z.string(),
      z.record(z.string(), z.number().int().positive()),
    ),
  })
  .strict();

export type Baseline = z.infer<typeof baselineSchema>;

/** Findings about the run itself, never accepted as debt. */
const RUN_TOOLS = new Set(["policy", "baseline"]);

/**
 * Debt is a located finding of a linter. A gate, a test suite or a formal
 * check reports one verdict however much fails, so a recorded count of one
 * would accept every later failure; a finding at the project root itself
 * (a tool that failed without saying where) is a verdict too.
 */
function recordable(finding: Finding, file: string): boolean {
  return (
    isGating(finding) &&
    !RUN_TOOLS.has(finding.tool) &&
    finding.layer !== "behavior" &&
    finding.layer !== "formal" &&
    file !== "" &&
    !file.startsWith("../")
  );
}

function ruleKey(finding: Finding): string {
  return `${finding.tool}/${finding.ruleId ?? ""}`;
}

function toolOf(key: string): string {
  return key.slice(0, key.indexOf("/"));
}

function ran(summary: RunSummary, tool: string): boolean {
  const status = summary.toolStatus[tool];
  return status === "pass" || status === "fail";
}

/**
 * Paths relative to the project root, POSIX. The tools report files in the
 * root's own spelling (probed through a symlinked root: tsc, oxlint,
 * ast-grep); a finding outside it is never debt, so it stays new.
 */
export function relativeTo(projectRoot: string): (file: string) => string {
  return (file) => toPosix(relative(projectRoot, file));
}

function parseBaseline(text: string, label: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(
      `Invalid baseline at ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = baselineSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid baseline at ${label}:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

/**
 * The project's baseline: from the trusted commit under --trusted-ref (a
 * patch must not grow its own allowance), else from the work tree.
 */
export async function loadBaseline(
  projectRoot: string,
  trusted?: TrustedPolicy,
): Promise<Baseline | undefined> {
  if (trusted) {
    const present = await pathsAtCommit(projectRoot, trusted.commit, [
      BASELINE_FILE,
    ]);
    if (!present.has(BASELINE_FILE)) return undefined;
    const text = await fileAtCommit(projectRoot, trusted.commit, BASELINE_FILE);
    return parseBaseline(
      text,
      `${trusted.commit.slice(0, 12)}:${BASELINE_FILE}`,
    );
  }
  const abs = posix.join(toPosix(projectRoot), BASELINE_FILE);
  if (!existsSync(abs)) return undefined;
  return parseBaseline(readFileSync(abs, "utf8"), abs);
}

/** File → `tool/rule` → the findings that could be debt there. */
type Counted = Map<string, Map<string, Finding[]>>;

function countFindings(
  findings: readonly Finding[],
  projectRoot: string,
): Counted {
  const toRelative = relativeTo(projectRoot);
  const byFile: Counted = new Map();
  for (const finding of findings) {
    const file = toRelative(finding.file);
    if (!recordable(finding, file)) continue;
    let byRule = byFile.get(file);
    if (!byRule) byFile.set(file, (byRule = new Map<string, Finding[]>()));
    const key = ruleKey(finding);
    const list = byRule.get(key);
    if (list) list.push(finding);
    else byRule.set(key, [finding]);
  }
  return byFile;
}

/** The findings of each file and rule that are within the recorded count. */
function acceptedBy(baseline: Baseline, current: Counted): Set<Finding> {
  const accepted = new Set<Finding>();
  for (const [file, byRule] of current) {
    for (const [key, findings] of byRule) {
      if (findings.length > (baseline.counts[file]?.[key] ?? 0)) continue;
      for (const finding of findings) accepted.add(finding);
    }
  }
  return accepted;
}

interface ApplyOptions {
  projectRoot: string;
  strict: boolean;
  /** Files (relative) a changed-file run looked at; stale counts only there. */
  checkedFiles?: ReadonlySet<string>;
}

function staleFinding(
  opts: ApplyOptions,
  file: string,
  key: string,
  allowed: number,
  now: number,
): Finding {
  return {
    tool: "baseline",
    layer: "lint",
    file: posix.join(toPosix(opts.projectRoot), file),
    line: 1,
    col: 1,
    ruleId: "stale",
    severity: opts.strict ? "error" : "info",
    message: `${BASELINE_FILE} allows ${allowed} \`${key}\` here; there ${now === 1 ? "is" : "are"} ${now} now. Run \`validate-kit baseline\` to lower it, so the fixed debt cannot come back.`,
    fixable: false,
  };
}

/**
 * Counts above today's, for tools that ran (a tool that did not run says
 * nothing about its debt) and files the run looked at.
 */
function staleCounts(
  baseline: Baseline,
  current: Counted,
  summary: RunSummary,
  opts: ApplyOptions,
): Finding[] {
  const stale: Finding[] = [];
  for (const [file, byRule] of Object.entries(baseline.counts)) {
    if (opts.checkedFiles && !opts.checkedFiles.has(file)) continue;
    for (const [key, allowed] of Object.entries(byRule)) {
      if (!ran(summary, toolOf(key))) continue;
      const now = current.get(file)?.get(key)?.length ?? 0;
      if (now < allowed)
        stale.push(staleFinding(opts, file, key, allowed, now));
    }
  }
  return stale;
}

/**
 * Mark the findings the baseline accepts, report stale counts, and judge the
 * run again on the new findings only.
 */
export function applyBaseline(
  summary: RunSummary,
  baseline: Baseline,
  opts: ApplyOptions,
): RunSummary {
  const current = countFindings(summary.findings, opts.projectRoot);
  const accepted = acceptedBy(baseline, current);
  const stale = staleCounts(baseline, current, summary, opts);
  const findings = [
    ...summary.findings.map((finding) =>
      accepted.has(finding) ? { ...finding, baselined: true } : finding,
    ),
    ...stale,
  ];
  const fresh = findings.filter((f) => !f.baselined);
  const failing = new Set(fresh.filter(isGating).map((f) => f.tool));
  const toolStatus = Object.fromEntries(
    Object.entries(summary.toolStatus).map(([tool, status]) => [
      tool,
      status === "fail" && !failing.has(tool) ? "pass" : status,
    ]),
  ) as RunSummary["toolStatus"];
  if (stale.length > 0) toolStatus["baseline"] = opts.strict ? "fail" : "pass";
  return {
    ...summary,
    findings,
    toolStatus,
    ranTools:
      stale.length > 0 ? [...summary.ranTools, "baseline"] : summary.ranTools,
    baseline: { baselined: accepted.size, stale: stale.length },
    exitCode: exitCodeOf(fresh, summary.crashed, summary.incomplete),
  };
}

export interface BaselineUpdate {
  baseline: Baseline;
  /** `file tool/rule: before → now` for each count that would grow. */
  refused: string[];
  adopted: string[];
  lowered: number;
  /** Tools the previous baseline recorded that the kit and config no longer have. */
  dropped: string[];
  /** Gating findings that cannot be debt (gates, formal checks, verdicts). */
  unrecordable: number;
}

interface UpdateOptions {
  projectRoot: string;
  kitVersion: string;
  adoptNewRules: boolean;
  includeSecurity: boolean;
  /** Every `tool/rule` the run could report, where known (ast-grep's). */
  knownRules: readonly string[];
  /**
   * Every tool the kit and the config have, run or not: recorded, so a tool
   * missing from a baseline is one the kit did not have when it was written.
   */
  knownTools: readonly string[];
}

/** What happens to one count: kept (or lowered), adopted, or refused. */
function verdictFor(
  previous: Baseline | undefined,
  key: string,
  now: number,
  before: number | undefined,
  summary: RunSummary,
  opts: UpdateOptions,
): "keep" | "adopt" | "refuse" {
  if (previous === undefined || now <= (before ?? 0)) return "keep";
  if (!opts.adoptNewRules || previous.rules.includes(key)) return "refuse";
  const recorded = previous.tools[toolOf(key)];
  const live = summary.toolVersions[toolOf(key)];
  // An upgrade: of the kit, of this tool, or a tool the kit did not have
  // when the baseline was written (a new adapter's rules are all new). Every
  // tool the kit has is recorded, "" until it ran and printed a version, so a
  // tool that was not installed, not planned or left out with --only is not
  // new later.
  const upgraded =
    previous.kitVersion !== opts.kitVersion ||
    recorded === undefined ||
    (live !== undefined && recorded !== "" && recorded !== live);
  return upgraded ? "adopt" : "refuse";
}

/**
 * The baseline after a complete run: created when there is none; otherwise
 * every count can only go down. Growth is refused except, with
 * `adoptNewRules`, for a `tool/rule` the baseline did not know, once the kit
 * or that tool changed version or the tool is new to the baseline: a rule an
 * upgrade added. Security-layer
 * findings are added only with `includeSecurity` (an accepted one is kept,
 * and can only shrink). A tool this run did not run keeps its counts and its
 * recorded version; one the kit and the config no longer have loses them.
 */
export function updateBaseline(
  previous: Baseline | undefined,
  summary: RunSummary,
  opts: UpdateOptions,
): BaselineUpdate {
  const current = countFindings(summary.findings, opts.projectRoot);
  const counts: Baseline["counts"] = {};
  const refused: string[] = [];
  const adopted: string[] = [];
  let securitySkipped = 0;
  for (const [file, byRule] of current) {
    for (const [key, findings] of byRule) {
      const now = findings.length;
      const before = previous?.counts[file]?.[key];
      if (
        findings[0]?.layer === "security" &&
        !opts.includeSecurity &&
        before === undefined
      ) {
        securitySkipped += now;
        continue;
      }
      const verdict = verdictFor(previous, key, now, before, summary, opts);
      if (verdict === "refuse") {
        refused.push(`${file} ${key}: ${before ?? 0} → ${now}`);
        continue;
      }
      if (verdict === "adopt") adopted.push(`${file} ${key}`);
      (counts[file] ??= {})[key] = now;
    }
  }
  // A tool neither the kit nor the config has any more (a removed invariant)
  // can never run again: its records and counts go, which only lowers.
  const known = new Set(opts.knownTools);
  const gone = (key: string): boolean => !known.has(toolOf(key));
  for (const [file, byRule] of Object.entries(previous?.counts ?? {})) {
    for (const [key, before] of Object.entries(byRule))
      if (!ran(summary, toolOf(key)) && !gone(key))
        (counts[file] ??= {})[key] ??= before;
  }
  const lowered = Object.entries(previous?.counts ?? {}).flatMap(
    ([file, byRule]) =>
      Object.entries(byRule).filter(
        ([key, before]) => (counts[file]?.[key] ?? 0) < before,
      ),
  ).length;
  const rules = new Set([
    ...(previous?.rules ?? []).filter((key) => !gone(key)),
    ...opts.knownRules,
  ]);
  for (const byRule of Object.values(counts))
    for (const key of Object.keys(byRule)) rules.add(key);
  const dropped = Object.keys(previous?.tools ?? {})
    .filter((tool) => !known.has(tool))
    .toSorted();
  const tools: Record<string, string> = Object.fromEntries(
    Object.entries(previous?.tools ?? {}).filter(([tool]) => known.has(tool)),
  );
  for (const tool of opts.knownTools) {
    if (RUN_TOOLS.has(tool)) continue;
    // A run that printed no version keeps the one recorded.
    const live = ran(summary, tool) ? summary.toolVersions[tool] : undefined;
    tools[tool] = live ?? tools[tool] ?? "";
  }
  let debt = 0;
  for (const byRule of current.values())
    for (const list of byRule.values()) debt += list.length;
  return {
    baseline: {
      schemaVersion: 1,
      kitVersion: opts.kitVersion,
      tools,
      rules: [...rules].toSorted(),
      counts,
    },
    refused,
    adopted,
    lowered,
    dropped,
    // Stale counts are the baseline's own; everything else not counted as
    // debt still fails the run.
    unrecordable:
      summary.findings.filter((f) => isGating(f) && f.tool !== "baseline")
        .length -
      debt +
      securitySkipped,
  };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Stable text: sorted keys, so a rewrite with nothing changed is no diff;
 * and the layout prettier gives JSON (an array on one line when it fits in
 * 80 columns), so a formatter on save does not rewrite it either.
 */
export function serializeBaseline(baseline: Baseline): string {
  const text = JSON.stringify(
    {
      ...baseline,
      tools: sortedRecord(baseline.tools),
      counts: sortedRecord(
        Object.fromEntries(
          Object.entries(baseline.counts).map(([file, byRule]) => [
            file,
            sortedRecord(byRule),
          ]),
        ),
      ),
    },
    null,
    2,
  );
  const oneLine = `  "rules": ${JSON.stringify(baseline.rules).replaceAll('","', '", "')},`;
  return `${oneLine.length <= 80 ? text.replace(/ {2}"rules": \[[^\]]*\],/, oneLine) : text}\n`;
}
