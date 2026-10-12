import { relative } from "node:path";
import pc from "picocolors";
import { EXIT } from "../core/exit-codes.js";
import { isGating, type RunSummary } from "../core/runner.js";
import { countsBySeverity } from "./json.js";
import type { Severity } from "../core/types.js";
import { groupBy } from "../core/group.js";

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  error: pc.red,
  warning: pc.yellow,
  info: pc.blue,
  hint: pc.gray,
};
const SEV_LABEL: Record<Severity, string> = {
  error: "error",
  warning: "warn",
  info: "info",
  hint: "hint",
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** `tool/rule`; formal rule ids already name their tool (tlc/deadlock). */
function ruleName(f: RunSummary["findings"][number]): string {
  if (!f.ruleId) return f.tool;
  return f.ruleId.startsWith(`${f.tool}/`) ? f.ruleId : `${f.tool}/${f.ruleId}`;
}

/** Human-facing report: per-tool status line + findings grouped by file + footer. */
export function renderPretty(
  summary: RunSummary,
  projectRoot: string,
  opts: { quiet?: boolean } = {},
): string {
  const out: string[] = [];
  // Accepted debt is not shown, except security errors: those are printed on
  // every run, so a baselined leak is never out of sight.
  const shown = summary.findings.filter(
    (f) => !f.baselined || (f.layer === "security" && f.severity === "error"),
  );
  const fresh = summary.findings.filter((f) => !f.baselined);
  const byTool = groupBy(fresh, (f) => f.tool);
  const gatingTools = new Set<string>();

  out.push("");
  for (const id of summary.ranTools) {
    const fs = byTool.get(id) ?? [];
    const gating = fs.filter(
      (f) => f.severity === "error" || f.severity === "warning",
    ).length;
    const fixed = summary.fixesByTool[id] ?? 0;
    if (gating > 0) gatingTools.add(id);
    const icon = gating > 0 ? pc.red("✗") : pc.green("✔");
    const detail =
      gating > 0
        ? pc.red(`${gating} issue${gating === 1 ? "" : "s"}`)
        : fixed > 0
          ? pc.green(`fixed ${fixed}`)
          : pc.dim("ok");
    out.push(`  ${pad(id, 16)} ${icon}  ${detail}`);
  }

  for (const inc of summary.incomplete) {
    out.push(
      inc.problem
        ? `  ${pad(inc.id, 16)} ${pc.red("✗ cannot run")}  ${pc.dim(inc.problem)}`
        : `  ${pad(inc.id, 16)} ${pc.red("✗ not found")}  ${pc.dim("install: " + inc.hint)}`,
    );
  }
  for (const sk of summary.skippedOptional) {
    out.push(
      `  ${pad(sk.id, 16)} ${pc.gray(sk.problem ? "○ skipped" : "○ skipped (optional)")}  ${pc.dim(sk.problem ?? sk.hint)}`,
    );
  }
  for (const cr of summary.crashed) {
    // The whole first line: it carries the cause and, often, the remedy.
    const first = cr.stderr.split("\n").find(Boolean) ?? "";
    out.push(`  ${pad(cr.id, 16)} ${pc.bgRed(" CRASH ")}  ${pc.dim(first)}`);
  }

  // findings detail grouped by file
  if (!opts.quiet && shown.length > 0) {
    out.push("");
    const byFile = groupBy(shown, (f) => f.file);
    for (const [file, fs] of byFile) {
      out.push(pc.underline(relative(projectRoot, file) || file));
      for (const f of fs.toSorted((a, b) => a.line - b.line || a.col - b.col)) {
        const loc = pc.dim(`${f.line}:${f.col}`);
        const sev = SEV_COLOR[f.severity](SEV_LABEL[f.severity]);
        const rule = pc.dim(` ${ruleName(f)}`);
        const fix = f.fixable ? pc.green(" [fixable]") : "";
        const debt = f.baselined ? pc.dim(" [baselined]") : "";
        out.push(
          `  ${pad(loc, 18)} ${pad(sev, 16)} ${f.message}${rule}${fix}${debt}`,
        );
      }
      out.push("");
    }
  }

  // footer
  const counts = countsBySeverity(fresh);
  const secs = (summary.durationMs / 1000).toFixed(2);
  const parts: string[] = [];
  if (counts.error)
    parts.push(pc.red(`${counts.error} error${counts.error === 1 ? "" : "s"}`));
  if (counts.warning)
    parts.push(
      pc.yellow(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`),
    );
  if (counts.info) parts.push(pc.blue(`${counts.info} info`));
  const totalFixed = Object.values(summary.fixesByTool).reduce(
    (a, b) => a + b,
    0,
  );
  if (summary.fixMode && totalFixed)
    parts.push(pc.green(`${totalFixed} fixed`));
  const baselined = summary.baseline?.baselined ?? 0;
  const debt = baselined > 0 ? `, ${baselined} baselined` : "";

  if (
    parts.length === 0 &&
    summary.incomplete.length === 0 &&
    summary.crashed.length === 0
  ) {
    // Skipped optional tools mean a whole layer (e.g. security) never ran —
    // the headline must not overstate coverage.
    const skipped =
      summary.skippedOptional.length > 0
        ? `, ${summary.skippedOptional.length} optional skipped`
        : "";
    out.push(
      pc.green(`✔ All clear`) +
        pc.dim(
          `  (${summary.ranTools.length} tools${skipped}${debt}, ${secs}s)`,
        ),
    );
  } else {
    out.push(parts.join(pc.dim(" · ")) + pc.dim(`  (${secs}s${debt})`));
  }
  if (summary.crashed.length > 0) {
    out.push(
      pc.red(
        `✗ ${summary.crashed.length} tool(s) crashed or timed out (${summary.crashed.map((c) => c.id).join(", ")}): the run cannot vouch for the code (exit 4). Fix the tool, or --disable it.`,
      ),
    );
  }
  if (summary.incomplete.length > 0) {
    out.push(
      pc.red(
        `✗ ${summary.incomplete.length} planned tool(s) missing — coverage incomplete (exit 3)`,
      ),
    );
  }
  out.push("");
  return out.join("\n");
}

/** Above this many, the rest are counted: `--ai-json -` lists them all. */
const QUIET_FINDINGS = 50;

/**
 * For hooks and agents (`--quiet`): nothing when the run passes. When it
 * fails, one plain line per gating finding (errors first), per tool that
 * crashed or is missing, per tool whose --fix changed files, then the exit
 * code and what it means, so a failure costs a few lines to read and a pass
 * costs none.
 */
export function renderQuiet(summary: RunSummary, projectRoot: string): string {
  if (summary.exitCode === EXIT.CLEAN) return "";
  const gating = summary.findings
    .filter((f) => !f.baselined && isGating(f))
    .toSorted(
      (a, b) =>
        Number(b.severity === "error") - Number(a.severity === "error") ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.col - b.col,
    );
  const lines = gating
    .slice(0, QUIET_FINDINGS)
    .map(
      (f) =>
        `${relative(projectRoot, f.file) || f.file}:${f.line}:${f.col} ${f.severity} ${ruleName(f)} ${f.message.replace(/\s+/g, " ").trim()}${f.fixable ? " [fixable]" : ""}`,
    );
  if (gating.length > QUIET_FINDINGS)
    lines.push(
      `... ${gating.length - QUIET_FINDINGS} more: run with --ai-json - for all`,
    );
  for (const cr of summary.crashed)
    lines.push(
      `${cr.id}: crashed: ${cr.stderr.split("\n").find(Boolean) ?? "no output"}`,
    );
  for (const inc of summary.incomplete)
    lines.push(
      inc.problem
        ? `${inc.id}: cannot run: ${inc.problem}`
        : `${inc.id}: not found; install: ${inc.hint}`,
    );
  for (const [id, n] of Object.entries(summary.fixesByTool))
    if (n > 0)
      lines.push(`${id}: fixed ${n} finding(s), files changed on disk`);
  const errors = gating.filter((f) => f.severity === "error").length;
  const meaning =
    summary.exitCode === EXIT.INTERNAL
      ? `${summary.crashed.length} tool(s) crashed or timed out, so the run cannot vouch for the code`
      : summary.exitCode === EXIT.INCOMPLETE
        ? `${summary.incomplete.length} planned tool(s) missing, so coverage is incomplete`
        : `${errors} error(s), ${gating.length - errors} warning(s)`;
  lines.push(`validate-kit: exit ${summary.exitCode}: ${meaning}`);
  return `${lines.join("\n")}\n`;
}
