import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "../src/index.js";
import type { RunSummary } from "../src/core/runner.js";
import { toJson } from "../src/report/json.js";
import { renderPretty } from "../src/report/pretty.js";
import { toSarif } from "../src/report/sarif.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../samples");

describe("report formats on a real findings run", () => {
  let summary: RunSummary;

  beforeAll(async () => {
    ({ summary } = await runCheck({ cwd: samples }));
  }, 60_000);

  it("seeded samples produce findings to report on", () => {
    expect(summary.findings.length).toBeGreaterThan(0);
  });

  it("toSarif emits schema-valid SARIF 2.1.0 with rule-reference integrity", () => {
    const sarif = JSON.parse(toSarif(summary, samples)) as {
      $schema: string;
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        automationDetails: { id: string };
        invocations: Array<{ executionSuccessful: boolean }>;
        results: Array<{
          ruleId: string;
          level: string;
          message: { text: string };
          partialFingerprints: { primaryLocationLineHash: string };
          locations: Array<{
            physicalLocation: {
              artifactLocation: { uri: string };
              region: { startLine: number; startColumn: number };
            };
          }>;
        }>;
      }>;
    };

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toMatch(/sarif-2\.1\.0/);
    expect(sarif.runs.length).toBeGreaterThan(0);

    let totalResults = 0;
    for (const run of sarif.runs) {
      expect(typeof run.tool.driver.name).toBe("string");
      // Distinct automation category per tool (GitHub 2025-07-22 no-auto-combine).
      expect(run.automationDetails.id).toBe(
        `validate-kit/${run.tool.driver.name}`,
      );
      expect(run.invocations[0]?.executionSuccessful).toBe(true);
      const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
      for (const res of run.results) {
        totalResults += 1;
        expect(typeof res.ruleId).toBe("string");
        expect(["error", "warning", "note"]).toContain(res.level);
        expect(typeof res.message.text).toBe("string");
        expect(res.partialFingerprints.primaryLocationLineHash).toMatch(
          /^[0-9a-f]{32}$/,
        );
        const loc = res.locations[0]?.physicalLocation;
        // GitHub code scanning needs repo-relative POSIX URIs, never file://.
        expect(loc?.artifactLocation.uri).not.toMatch(/^file:\/\//);
        expect(loc?.artifactLocation.uri).not.toMatch(/^\//);
        expect(loc?.artifactLocation.uri).not.toContain("\\");
        expect(loc?.region.startLine).toBeGreaterThanOrEqual(1);
        expect(loc?.region.startColumn).toBeGreaterThanOrEqual(1);
        // SARIF integrity: every result rule is declared by the driver
        expect(ruleIds.has(res.ruleId)).toBe(true);
      }
    }
    expect(totalResults).toBe(summary.findings.length);
  });

  it("toJson mirrors the summary (counts + findings + exitCode)", () => {
    const json = JSON.parse(toJson(summary)) as {
      schemaVersion: number;
      exitCode: number;
      counts: { error: number };
      findings: unknown[];
    };
    expect(json.schemaVersion).toBe(2);
    expect(json.exitCode).toBe(summary.exitCode);
    expect(json.findings).toHaveLength(summary.findings.length);
    const errs = summary.findings.filter((f) => f.severity === "error").length;
    expect(json.counts.error).toBe(errs);
  });

  it("renderPretty shows each finding's message + tool/rule", () => {
    const out = renderPretty(summary, samples);
    const first = summary.findings[0];
    expect(first).toBeDefined();
    if (first) {
      expect(out).toContain(first.message);
      if (first.ruleId) expect(out).toContain(`${first.tool}/${first.ruleId}`);
    }
  });
});

describe("toSarif with no findings", () => {
  it("emits one valid empty SARIF run", () => {
    const empty = JSON.parse(
      toSarif({ findings: [] } as unknown as RunSummary),
    ) as { version: string; runs: Array<{ results: unknown[] }> };
    expect(empty.version).toBe("2.1.0");
    expect(empty.runs).toHaveLength(1);
    expect(empty.runs[0]?.results).toHaveLength(0);
  });
});
