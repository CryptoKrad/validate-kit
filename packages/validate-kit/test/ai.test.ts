import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXIT } from "../src/core/exit-codes.js";
import type { RunSummary } from "../src/core/runner.js";
import { toAiReport, type AiAssistReport } from "../src/report/ai.js";
import { createMcpServer } from "../src/commands/mcp.js";

function summaryWith(
  findings: RunSummary["findings"],
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    scope: { profile: "default", mode: "full", files: null },
    findings,
    incomplete: [],
    skippedOptional: [],
    crashed: [],
    fixesByTool: {},
    filesByTool: {},
    ranTools: ["oxlint"],
    toolStatus: { oxlint: findings.length > 0 ? "fail" : "pass" },
    toolVersions: {},
    durationMs: 10,
    exitCode: findings.length > 0 ? EXIT.FINDINGS : EXIT.CLEAN,
    fixMode: false,
    ...overrides,
  };
}

function seededRepo(): { root: string; file: string } {
  const root = mkdtempSync(resolve(tmpdir(), "vk-ai-"));
  mkdirSync(resolve(root, "src"));
  const file = resolve(root, "src", "app.ts");
  writeFileSync(
    file,
    [
      "const before = 1;",
      'console.log("debug");',
      "const after = 2;",
      'const password = "hunter2secret";',
      "export { before, after };",
      "",
    ].join("\n"),
  );
  return { root, file };
}

describe("AI-assist report (ai-json projection)", () => {
  it("projects findings with repo-relative paths, real snippets, context, and stable fingerprints", () => {
    const { root, file } = seededRepo();
    const summary = summaryWith([
      {
        tool: "ast-grep",
        layer: "custom-rules",
        language: "ts",
        file,
        line: 2,
        col: 1,
        endLine: 2,
        endCol: 22,
        ruleId: "ts-no-console",
        severity: "warning",
        message: "Remove leftover console.log",
        fixable: false,
      },
      {
        tool: "oxlint",
        layer: "lint",
        language: "ts",
        file,
        line: 3,
        col: 7,
        ruleId: "eslint(no-unused-vars)",
        severity: "info",
        message: "unused",
        fixable: true,
      },
    ]);

    const report: AiAssistReport = toAiReport(summary, root);

    expect(report.schemaVersion).toBe("1.0");
    expect(report.totalFindings).toBe(2);
    const [first, second] = report.findings;
    if (!first || !second) throw new Error("expected two findings");

    // repo-relative POSIX path, never absolute
    expect(first.file).toBe("src/app.ts");
    // the exact offending line from disk is the drift-proof anchor
    expect(first.snippet).toBe('console.log("debug");');
    expect(first.range).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 22,
    });
    expect(first.context?.beforeLines).toEqual(["const before = 1;"]);
    expect(first.context?.afterLines).toEqual([
      "const after = 2;",
      'const password = "«redacted»";',
    ]);
    // fingerprint is stable across runs (pure function of rule+file+snippet)
    const again = toAiReport(summary, root);
    expect(again.findings[0]?.fingerprint).toBe(first.fingerprint);
    expect(first.id).not.toBe(second.id);

    // fixable via a tool-native autofix => safe (applied by apply_safe_fixes)
    expect(first.fixApplicability).toBe("manual");
    expect(second.fixApplicability).toBe("safe");
    // severity mapping: info/hint collapse to note
    expect(second.severity).toBe("note");
  });

  it("redacts credential-shaped values from snippets and context", () => {
    const { root, file } = seededRepo();
    const summary = summaryWith([
      {
        tool: "semgrep",
        layer: "security",
        language: "ts",
        file,
        line: 4,
        col: 1,
        ruleId: "vk-hardcoded-credential",
        severity: "warning",
        message: "Possible hardcoded credential",
        fixable: false,
      },
    ]);

    const report = toAiReport(summary, root);
    const finding = report.findings[0];
    if (!finding) throw new Error("expected a finding");
    expect(finding.snippet).toContain("«redacted»");
    expect(finding.snippet).not.toContain("hunter2secret");
    expect(JSON.stringify(report)).not.toContain("hunter2secret");
  });
});

describe("MCP server (check mcp)", () => {
  it("serves run_check, list_findings, and get_finding over a real MCP transport", async () => {
    const { root } = seededRepo();

    const server = createMcpServer();
    const client = new Client({ name: "vk-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // The server identifies as Tester.MCP to every connecting agent.
    expect(client.getServerVersion()?.name).toBe("Tester.MCP");

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "apply_safe_fixes",
      "get_finding",
      "list_findings",
      "run_check",
    ]);

    // get_finding before any run must fail loud, not return stale data
    const early = await client.callTool({
      name: "list_findings",
      arguments: {},
    });
    expect(early.isError).toBe(true);

    const run = (await client.callTool({
      name: "run_check",
      arguments: { path: root, tools: ["ast-grep"] },
    })) as {
      isError?: boolean;
      structuredContent?: {
        totalFindings: number;
        findings: Array<{ id: string; ruleId?: string; file: string }>;
      };
    };
    expect(run.isError ?? false).toBe(false);
    const structured = run.structuredContent;
    if (!structured) throw new Error("run_check returned no structuredContent");
    expect(structured.totalFindings).toBeGreaterThanOrEqual(1);
    const consoleFinding = structured.findings.find(
      (f) => f.ruleId === "ts-no-console",
    );
    if (!consoleFinding) throw new Error("expected a ts-no-console finding");
    expect(consoleFinding.file).toBe("src/app.ts");

    const detail = (await client.callTool({
      name: "get_finding",
      arguments: { id: consoleFinding.id },
    })) as {
      structuredContent?: { snippet: string; fingerprint: string };
    };
    expect(detail.structuredContent?.snippet).toBe('console.log("debug");');

    await client.close();
    await server.close();
  }, 60_000);
});
