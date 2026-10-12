import type { RunSummary } from "../core/runner.js";
import type { Finding, Severity } from "../core/types.js";

export function countsBySeverity(
  findings: Finding[],
): Record<Severity, number> {
  const c: Record<Severity, number> = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
  };
  for (const f of findings) c[f.severity]++;
  return c;
}

/**
 * Stable machine-readable summary (schemaVersion pinned). A finding carries
 * `baselined: true` when the project's baseline accepts it.
 * v2: a finding's `language` is absent when its file belongs to no language,
 * and `evidence` names the commit, config and kit the run was produced from.
 */
export function toJson(summary: RunSummary): string {
  return JSON.stringify(
    {
      schemaVersion: 2,
      evidence: summary.evidence ?? null,
      exitCode: summary.exitCode,
      scope: summary.scope,
      fixMode: summary.fixMode,
      durationMs: summary.durationMs,
      ranTools: summary.ranTools,
      toolStatus: summary.toolStatus,
      // New findings only; baselined ones are accepted debt.
      counts: countsBySeverity(summary.findings.filter((f) => !f.baselined)),
      baseline: summary.baseline ?? null,
      incomplete: summary.incomplete,
      skippedOptional: summary.skippedOptional,
      crashed: summary.crashed,
      fixesByTool: summary.fixesByTool,
      findings: summary.findings,
    },
    null,
    2,
  );
}
