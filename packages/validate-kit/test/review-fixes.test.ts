import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { astgrep } from "../src/adapters/astgrep.js";
import { oxlint } from "../src/adapters/oxlint.js";
import { run } from "../src/core/exec.js";
import { EXIT } from "../src/core/exit-codes.js";
import { execute, type RunSummary } from "../src/core/runner.js";
import { toSarif } from "../src/report/sarif.js";
import type {
  Finding,
  RawOutput,
  ResolvedConfig,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";
import { LANGUAGES } from "../src/core/types.js";
import type { PlannedTask } from "../src/core/plan.js";

// Behavioral regressions for the 2026-07-01 full-surface review fixes.
// Each test reproduces a real false-CLEAN (or spurious crash) the review found.

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    languages: Object.fromEntries(
      LANGUAGES.map((lang) => [lang, { enabled: true }]),
    ) as ResolvedConfig["languages"],
    layers: {
      format: { enabled: true },
      lint: { enabled: true },
      "type-check": { enabled: true },
      "custom-rules": { enabled: true },
      security: { enabled: true },
      formal: { enabled: true },
      behavior: { enabled: true },
      mutation: { enabled: true },
    },
    include: [],
    ignore: [],
    maxFileBytes: 1_048_576,
    skipMinified: true,
    astGrep: { ruleDirs: [], ruleIds: [] },
    vulnAudit: { enabled: false, scanPaths: ["."], offline: false },
    apiDiff: { enabled: false, specs: [], baseRef: "origin/main" },
    concurrency: 4,
    tools: {},
    adapters: [],
    invariants: [],
    severityOverrides: [],
    policyFiles: [],
    ...overrides,
  };
}

function errorFinding(): Finding {
  return {
    tool: "fake",
    layer: "lint",
    language: "ts",
    file: resolve(process.cwd(), "b.ts"),
    line: 1,
    col: 1,
    ruleId: "no-eval",
    severity: "error",
    message: "eval is dangerous",
    fixable: false,
  };
}

function fakeAdapter(findings: Finding[]): ToolAdapter {
  return {
    id: "fake",
    layer: "lint",
    languages: ["ts"],
    bin: process.execPath,
    versionArgs: ["--version"],
    supportsFix: false,
    fixWriteBack: false,
    minVersion: "0.0.0",
    installHint: "install fake",
    detect: () => true,
    buildArgs: () => ({ bin: process.execPath, args: ["-e", ""] }),
    parseOutput: (raw): RunResult => ({
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    }),
  };
}

function task(adapter: ToolAdapter): PlannedTask {
  return { adapter, cwd: process.cwd(), toolConfig: {} };
}

function ctx(partial: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), fix: false, extraArgs: [], ...partial };
}

describe("review fixes (2026-07-01)", () => {
  // C1 — wildcard severity override must NOT shadow a later specific re-enable.
  it("keeps a specific-rule override winning over a '*' off entry (no false CLEAN)", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config({
        severityOverrides: [
          { tool: "fake", ruleId: "*", severity: "off" },
          { tool: "fake", ruleId: "no-eval", severity: "error" },
        ],
      }),
      tasks: [task(fakeAdapter([errorFinding()]))],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });
    // The specific no-eval:error must survive → gating → FINDINGS, not CLEAN.
    expect(summary.exitCode).toBe(EXIT.FINDINGS);
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.ruleId).toBe("no-eval");
  });

  it("still lets a '*' off suppress rules that have no specific override", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config({
        severityOverrides: [{ tool: "fake", ruleId: "*", severity: "off" }],
      }),
      tasks: [task(fakeAdapter([errorFinding()]))],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });
    expect(summary.exitCode).toBe(EXIT.CLEAN);
    expect(summary.findings).toHaveLength(0);
  });

  // H1 — a run timeout must be distinct from a spawn failure.
  it("marks a timed-out process as timedOut, not spawnError", async () => {
    const raw = await run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      { cwd: process.cwd(), timeoutMs: 150 },
    );
    expect(raw.timedOut).toBe(true);
    expect(raw.spawnError).toBe(false);
  });

  // A tool that asks on stdin (Mix: "Shall I install Hex? [Yn]") reads its
  // end at once, instead of waiting out the timeout on an open pipe.
  it("gives a tool an empty stdin when it has no input", async () => {
    const raw = await run(
      process.execPath,
      ["-e", "process.stdin.on('end', () => console.log('eof')).resume()"],
      { cwd: process.cwd(), timeoutMs: 3000 },
    );
    expect(raw.timedOut).not.toBe(true);
    expect(raw.stdout).toBe("eof\n");
  });

  // C2 — oxlint schema drift (missing `diagnostics`) must fail loud, not CLEAN.
  it("oxlint throws when its output is missing the diagnostics key", () => {
    const raw: RawOutput = {
      stdout: JSON.stringify({ messages: [] }),
      stderr: "",
      exitCode: 1,
    };
    expect(() => oxlint.parseOutput(raw, ctx())).toThrow(/diagnostics/);
  });

  // H2 — ast-grep fix mode returns human text; must not be JSON-parsed → crash.
  it("ast-grep fix mode ignores human stdout instead of crashing", () => {
    const raw: RawOutput = {
      stdout: "Applied 3 fixes across 2 files\n",
      stderr: "",
      exitCode: 0,
    };
    expect(() => astgrep.parseOutput(raw, ctx({ fix: true }))).not.toThrow();
    expect(astgrep.parseOutput(raw, ctx({ fix: true })).findings).toHaveLength(
      0,
    );
  });

  // H3 — a rule/config error (non-zero exit, empty stdout, stderr) must fail loud.
  it("ast-grep throws on a config error exit with no findings", () => {
    const raw: RawOutput = {
      stdout: "",
      stderr: "Error: could not parse rule file foo.yml",
      exitCode: 2,
    };
    expect(() => astgrep.parseOutput(raw, ctx())).toThrow(/rule\/config error/);
  });

  // Reporter C1 — SARIF must emit repo-relative POSIX URIs, not absolute file://.
  it("SARIF emits repo-relative POSIX URIs", () => {
    const summary = {
      findings: [
        {
          tool: "oxlint",
          layer: "lint",
          language: "ts",
          file: resolve(process.cwd(), "src/deep/a.ts"),
          line: 3,
          col: 2,
          ruleId: "no-eval",
          severity: "error",
          message: "x",
          fixable: false,
        },
      ],
      crashed: [],
    } as unknown as RunSummary;
    const sarif = JSON.parse(toSarif(summary, process.cwd())) as {
      runs: Array<{
        results: Array<{
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string } };
          }>;
        }>;
      }>;
    };
    const uri =
      sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation
        .uri;
    expect(uri).toBe("src/deep/a.ts");
  });

  // Reporter C3 — a crashed tool must serialize executionSuccessful:false so
  // GitHub does not auto-close its prior alerts.
  it("SARIF marks a crashed tool's run as unsuccessful", () => {
    const summary = {
      findings: [],
      crashed: [{ id: "semgrep", stderr: "boom" }],
    } as unknown as RunSummary;
    const sarif = JSON.parse(toSarif(summary, process.cwd())) as {
      runs: Array<{
        tool: { driver: { name: string } };
        invocations: Array<{ executionSuccessful: boolean }>;
      }>;
    };
    const semgrepRun = sarif.runs.find((r) => r.tool.driver.name === "semgrep");
    expect(semgrepRun?.invocations[0]?.executionSuccessful).toBe(false);
  });
});
