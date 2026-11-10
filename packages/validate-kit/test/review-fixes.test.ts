import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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

/** A folder holding a script named probe-tool that prints `says`. */
function probeTool(dir: string, says: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe-tool"), `#!/bin/sh\necho ${says}\n`, {
    mode: 0o755,
  });
  return dir;
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

  // A project's pre-push hook, 2026-11-09: the shell exported one Go's GOROOT
  // (a version manager's), the hook put another go first on PATH, and every
  // Go tool crashed: compile: version "go1.26.10" does not match go tool
  // version "go1.27.3". The fake go is a POSIX script.
  it.skipIf(process.platform === "win32")(
    "runs a tool with one Go: GOROOT's when it can build the module, else the one on PATH",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vk-goroot-"));
      try {
        const go = (name: string, version: string): string => {
          const dir = join(root, name);
          mkdirSync(join(dir, "bin"), { recursive: true });
          writeFileSync(join(dir, "bin", "go"), "#!/bin/sh\n", { mode: 0o755 });
          writeFileSync(join(dir, "VERSION"), `go${version}\ntime 2026\n`);
          return dir;
        };
        const hooks = go("hooks-go", "1.27.3");
        const pinned = go("pinned-go", "1.26.10");
        const stale = go("stale-go", "1.25.4");
        const module = (name: string, text: string | undefined): string => {
          const dir = join(root, name, "pkg");
          mkdirSync(dir, { recursive: true });
          if (text !== undefined)
            writeFileSync(join(root, name, "go.mod"), `module m\n\n${text}\n`);
          return dir;
        };
        // What a tool sees: its GOROOT, and the folder of the first go on PATH.
        const seen = async (cwd: string, goroot: string): Promise<string> => {
          const raw = await run(
            process.execPath,
            [
              "-e",
              "const p=require('node:path');process.stdout.write(`${p.basename(process.env.GOROOT??'unset')} ${p.basename(p.dirname(process.env.PATH.split(p.delimiter)[0]))}`)",
            ],
            {
              cwd,
              env: {
                PATH: `${join(hooks, "bin")}${delimiter}${join(pinned, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
                GOROOT: goroot,
              },
            },
          );
          return raw.stdout;
        };
        const builds = module("builds", "go 1.26.10");
        // The project's pinned Go, shadowed on PATH by the hook's: reunited.
        expect(await seen(builds, pinned)).toBe("pinned-go pinned-go");
        // A GOROOT left over from elsewhere, too old for this module: left out.
        expect(await seen(builds, stale)).toBe("unset hooks-go");
        // go.mod's toolchain line counts when it is the newer one.
        expect(
          await seen(module("newer", "go 1.26\n\ntoolchain go1.27.0"), pinned),
        ).toBe("unset hooks-go");
        // No go.mod to say: the go on PATH, with its own root.
        expect(await seen(module("none", undefined), pinned)).toBe(
          "unset hooks-go",
        );
        // Already one toolchain: nothing changes.
        expect(await seen(builds, hooks)).toBe("hooks-go hooks-go");
        // A version manager's shim would part the two again (mise rebuilds
        // the environment): where they were apart, the tool itself is run.
        const shims = probeTool(join(root, "mise", "shims"), "shim");
        const real = probeTool(join(root, "gobin"), "real");
        const ran = async (goroot: string | undefined): Promise<string> => {
          const raw = await run("probe-tool", [], {
            cwd: builds,
            env: {
              PATH: `${join(hooks, "bin")}${delimiter}${shims}${delimiter}${real}${delimiter}${process.env["PATH"] ?? ""}`,
              ...(goroot === undefined ? {} : { GOROOT: goroot }),
            },
          });
          return raw.stdout.trim();
        };
        expect(await ran(pinned)).toBe("real");
        expect(await ran(hooks)).toBe("shim");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // C2 — oxlint schema drift (missing `diagnostics`) must fail loud, not CLEAN.
  it("oxlint throws when its output is missing the diagnostics key", () => {
    const raw: RawOutput = {
      stdout: JSON.stringify({ messages: [] }),
      stderr: "",
      exitCode: 1,
    };
    expect(() => oxlint.parseOutput(raw, ctx())).toThrow(/diagnostics/);
  });

  // oxlint 1.92.0 on a .js that is not UTF-8, recorded 2026-11-09 in a
  // repository of saved pages (assets/sota-2026-11-09/oxlint-unreadable): the
  // diagnostic has no filename, and the adapter crashed the whole run on it.
  it("oxlint reports a file it could not read as a finding, and refuses any other diagnostic without a file", () => {
    const unreadable = {
      message:
        'Failed to open file /repo/saved/latin.js with error "stream did not contain valid UTF-8"',
      severity: "error",
      labels: [],
    };
    const { findings } = oxlint.parseOutput(
      {
        stdout: JSON.stringify({
          diagnostics: [unreadable],
          number_of_files: 2,
        }),
        stderr: "",
        exitCode: 1,
      },
      ctx({ cwd: "/repo" }),
    );
    expect(findings).toMatchObject([
      {
        file: "/repo/saved/latin.js",
        line: 1,
        ruleId: "unreadable",
        severity: "warning",
        message:
          "oxlint could not read this file, so nothing in it is linted: stream did not contain valid UTF-8",
      },
    ]);
    expect(() =>
      oxlint.parseOutput(
        {
          stdout: JSON.stringify({
            diagnostics: [{ message: "something new", severity: "error" }],
          }),
          stderr: "",
          exitCode: 1,
        },
        ctx(),
      ),
    ).toThrow(/without a file \("something new"\)/);
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
