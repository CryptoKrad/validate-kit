import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { RunSummary } from "../core/runner.js";
import type { Finding } from "../core/types.js";

const INFORMATION_URI = "https://github.com/CryptoKrad/validate-kit";

// GitHub code scanning silently drops results beyond this per-run soft cap.
const MAX_RESULTS_PER_RUN = 5000;

function level(sev: Finding["severity"]): "error" | "warning" | "note" {
  if (sev === "error") return "error";
  if (sev === "warning") return "warning";
  return "note";
}

/**
 * Repo-relative POSIX URI. GitHub code scanning cannot map an absolute
 * `file://` URI (e.g. /home/runner/work/repo/repo/src/a.ts) to a tracked path,
 * so it drops the result — findings computed correctly then vanish on the PR.
 */
function relUri(file: string, projectRoot?: string): string {
  let rel = file;
  if (projectRoot && isAbsolute(file)) {
    rel = relative(projectRoot, file);
  }
  return rel.split(sep).join("/");
}

/** SARIF regions are 1-based; endLine must be >= startLine, endColumn 1-based. */
function region(f: Finding): Record<string, number> {
  const out: Record<string, number> = {
    startLine: f.line,
    startColumn: f.col,
  };
  if (typeof f.endLine === "number" && f.endLine >= f.line) {
    out.endLine = f.endLine;
    if (typeof f.endCol === "number" && f.endCol >= 1) out.endColumn = f.endCol;
  }
  return out;
}

function fingerprint(f: Finding, uri: string): string {
  return createHash("sha256")
    .update(`${f.tool}\0${f.ruleId ?? ""}\0${uri}\0${f.message}`)
    .digest("hex")
    .slice(0, 32);
}

/** Hand-rolled SARIF 2.1.0 (no external dep). One run per tool. */
export function toSarif(summary: RunSummary, projectRoot?: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- public API: a summary from an older kit has no `crashed`
  const crashedTools = summary.crashed ?? [];
  const byTool = new Map<string, Finding[]>();
  for (const f of summary.findings) {
    const list = byTool.get(f.tool) ?? [];
    list.push(f);
    byTool.set(f.tool, list);
  }

  const runs = [...byTool.entries()].map(([tool, findings]) => {
    const capped = findings.slice(0, MAX_RESULTS_PER_RUN);
    const ruleIds = [...new Set(capped.map((f) => f.ruleId ?? tool))];
    // A crashed tool must NOT serialize as an empty successful run — GitHub would
    // read "present before, empty now" as "fixed" and auto-close real alerts.
    const crashed = crashedTools.some((c) => c.id === tool);
    return {
      tool: {
        driver: {
          name: tool,
          informationUri: INFORMATION_URI,
          rules: ruleIds.map((id) => ({ id })),
        },
      },
      // Distinct category per tool: GitHub (2025-07-22) no longer auto-combines
      // same tool+category runs, so each tool gets its own automation id.
      automationDetails: { id: `validate-kit/${tool}` },
      invocations: [{ executionSuccessful: !crashed }],
      results: capped.map((f) => {
        const uri = relUri(f.file, projectRoot);
        return {
          ruleId: f.ruleId ?? tool,
          level: level(f.severity),
          message: { text: f.message },
          // SARIF 2.1.0 §3.27.24: judged against the project's baseline.
          baselineState: summary.baseline
            ? f.baselined
              ? "unchanged"
              : "new"
            : undefined,
          // For consumers that read suppressions, not baselineState.
          suppressions: f.baselined
            ? [
                {
                  kind: "external",
                  justification: "accepted debt in validate.baseline.json",
                },
              ]
            : undefined,
          partialFingerprints: { primaryLocationLineHash: fingerprint(f, uri) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri },
                region: region(f),
              },
            },
          ],
        };
      }),
    };
  });

  // Surface crashed tools that produced no findings so their failure is visible
  // (and GitHub does not treat their prior alerts as resolved).
  for (const c of crashedTools) {
    if (byTool.has(c.id)) continue;
    runs.push({
      tool: {
        driver: { name: c.id, informationUri: INFORMATION_URI, rules: [] },
      },
      automationDetails: { id: `validate-kit/${c.id}` },
      invocations: [{ executionSuccessful: false }],
      results: [],
    });
  }

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs:
        runs.length > 0
          ? runs
          : [
              {
                tool: {
                  driver: {
                    name: "validate-kit",
                    informationUri: INFORMATION_URI,
                    rules: [],
                  },
                },
                automationDetails: { id: "validate-kit/validate-kit" },
                invocations: [{ executionSuccessful: true }],
                results: [],
              },
            ],
    },
    null,
    2,
  );
}
