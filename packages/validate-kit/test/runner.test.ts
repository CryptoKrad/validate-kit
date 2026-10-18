import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { astgrep } from "../src/adapters/astgrep.js";
import { clippy } from "../src/adapters/clippy.js";
import { eslint } from "../src/adapters/eslint.js";
import { gofumpt } from "../src/adapters/gofumpt.js";
import { golangci } from "../src/adapters/golangci.js";
import { oxlint } from "../src/adapters/oxlint.js";
import { prettier } from "../src/adapters/prettier.js";
import { ruff } from "../src/adapters/ruff.js";
import { ruffFormat } from "../src/adapters/ruff-format.js";
import { rustfmt } from "../src/adapters/rustfmt.js";
import { semgrep } from "../src/adapters/semgrep.js";
import { tsc } from "../src/adapters/tsc.js";
import { hookIndex, run } from "../src/core/exec.js";
import { toPosix } from "../src/detect/languages.js";
import { renderPretty } from "../src/report/pretty.js";
import { execute } from "../src/core/runner.js";
import { EXIT } from "../src/core/exit-codes.js";
import type {
  Finding,
  RawOutput,
  ResolvedConfig,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";
import type { PlannedTask } from "../src/core/plan.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    languages: {
      ts: { enabled: true },
      js: { enabled: true },
      rust: { enabled: true },
      go: { enabled: true },
      python: { enabled: true },
      shell: { enabled: true },
      sql: { enabled: true },
      solidity: { enabled: true },
    },
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

function finding(partial: Partial<Finding> = {}): Finding {
  return {
    tool: partial.tool ?? "fake",
    layer: partial.layer ?? "lint",
    language: partial.language ?? "ts",
    file: partial.file ?? resolve(process.cwd(), "b.ts"),
    line: partial.line ?? 1,
    col: partial.col ?? 1,
    ruleId: partial.ruleId ?? "fake-rule",
    severity: partial.severity ?? "warning",
    message: partial.message ?? "fake finding",
    fixable: partial.fixable ?? false,
  };
}

function adapter(opts: {
  id: string;
  layer?: ToolAdapter["layer"];
  optional?: boolean;
  supportsFix?: boolean;
  fixWriteBack?: boolean;
  bin?: string;
  argsFor?: (ctx: ToolContext) => string[];
  env?: Record<string, string>;
  runBinFor?: (ctx: ToolContext) => string;
  findings?: Finding[];
  crash?: boolean;
  parseError?: string;
  onBuild?: (ctx: ToolContext) => void;
}): ToolAdapter {
  return {
    id: opts.id,
    layer: opts.layer ?? "lint",
    languages: ["ts"],
    bin: opts.bin ?? process.execPath,
    versionArgs: ["--version"],
    supportsFix: opts.supportsFix ?? false,
    fixWriteBack: opts.fixWriteBack ?? false,
    optional: opts.optional,
    minVersion: "0.0.0",
    installHint: "install fake",
    detect: () => true,
    buildArgs(ctx) {
      opts.onBuild?.(ctx);
      return {
        bin: opts.runBinFor?.(ctx) ?? opts.bin ?? process.execPath,
        args:
          opts.argsFor?.(ctx) ??
          (opts.crash ? ["-e", "process.exit(7)"] : ["-e", ""]),
        ...(opts.env ? { env: opts.env } : {}),
      };
    },
    parseOutput: (raw) => {
      if (opts.parseError) throw new Error(opts.parseError);
      return {
        findings: opts.findings ?? [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    },
  };
}

function task(
  fake: ToolAdapter,
  cwd = process.cwd(),
  files?: string[],
): PlannedTask {
  return {
    adapter: fake,
    cwd,
    ...(files ? { files } : {}),
    toolConfig: {},
  };
}

function sleepingNodeArgs(id: string, ms = 80): string[] {
  return [
    "-e",
    `const fs=require("node:fs");const log=process.env.LOG;fs.appendFileSync(log,"${id} start "+Date.now()+"\\n");setTimeout(()=>{fs.appendFileSync(log,"${id} end "+Date.now()+"\\n");},${ms});`,
  ];
}

function readIntervals(
  logPath: string,
): Record<string, { start: number; end: number }> {
  const intervals: Record<string, { start: number; end: number }> = {};
  for (const line of readFileSync(logPath, "utf8").trim().split("\n")) {
    const [id, phase, ms] = line.split(" ");
    if (!id || !phase || !ms) continue;
    const entry = intervals[id] ?? { start: 0, end: 0 };
    if (phase === "start") entry.start = Number(ms);
    else entry.end = Number(ms);
    intervals[id] = entry;
  }
  return intervals;
}

/**
 * A fake tool in `binDir`, as a package manager installs one: a POSIX sh
 * script, and on Windows a .cmd beside it (execa runs only PATHEXT files there).
 */
function fakeTool(binDir: string, name: string, script: string): void {
  const path = resolve(binDir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  if (process.platform === "win32")
    writeFileSync(`${path}.cmd`, `@sh "%~dp0${name}" %*\r\n`);
}

describe("runner", () => {
  it("runs a tool without the git hook's repository variables, and git itself with them", async () => {
    // A worktree's pre-push exports GIT_DIR, every pre-commit GIT_INDEX_FILE.
    // A tool's `git init` in a sub-folder (lake does) then set core.bare=true
    // in the config every checkout shares, and its `git add` wrote into the
    // index being committed.
    const root = toPosix(mkdtempSync(resolve(tmpdir(), "vk-gitdir-")));
    const main = `${root}/main`;
    mkdirSync(main);
    git(main, "init", "-q");
    writeFileSync(`${main}/a.txt`, "a\n");
    git(main, "add", "a.txt");
    git(
      main,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "base",
    );
    git(main, "worktree", "add", "-q", `${root}/wt`);
    const index = `${root}/next-index.lock`;
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: main,
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
    const saved = {
      dir: process.env.GIT_DIR,
      index: process.env.GIT_INDEX_FILE,
    };
    process.env.GIT_DIR = `${main}/.git/worktrees/wt`;
    process.env.GIT_INDEX_FILE = index;
    try {
      const tool = await run(
        process.execPath,
        [
          "-e",
          'const fs = require("node:fs"); const { execFileSync } = require("node:child_process"); fs.mkdirSync("pkg"); fs.writeFileSync("pkg/p.txt", "p"); execFileSync("git", ["init", "-q"], { cwd: "pkg" }); execFileSync("git", ["add", "p.txt"], { cwd: "pkg" });',
        ],
        { cwd: `${root}/wt` },
      );
      expect(tool.exitCode).toBe(0);
      // The kit's own git still reads the hook's repository, and a tool that
      // reads its staged files is handed the index.
      const own = await run("git", ["rev-parse", "--git-dir"], { cwd: root });
      expect(own.stdout.trim()).toBe(`${main}/.git/worktrees/wt`);
      const handed = await run(
        process.execPath,
        ["-e", "process.stdout.write(process.env.GIT_INDEX_FILE ?? '')"],
        { cwd: root, env: hookIndex() },
      );
      expect(handed.stdout).toBe(index);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.index;
    }
    expect(git(main, "config", "core.bare")).toBe("false");
    expect(git(`${root}/wt/pkg`, "ls-files")).toBe("p.txt");
    expect(
      execFileSync("git", ["ls-files"], {
        cwd: main,
        encoding: "utf8",
        env: { ...process.env, GIT_INDEX_FILE: index },
      }).trim(),
    ).toBe("a.txt");
  });

  it("runs a pythonEnv tool from the project's .venv, where its probe found it", async () => {
    const cwd = toPosix(mkdtempSync(resolve(tmpdir(), "vk-venv-run-")));
    const binDir = resolve(cwd, ".venv", "bin");
    mkdirSync(binDir, { recursive: true });
    // Only in .venv: not on PATH, not in any node_modules.
    fakeTool(
      binDir,
      "vk-venv-only-tool",
      '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "vk-venv-only-tool 1.0.0"; exit 0; fi\necho ran-from-venv\n',
    );
    const venvTool: ToolAdapter = {
      ...adapter({ id: "venv-tool" }),
      bin: "vk-venv-only-tool",
      pythonEnv: true,
      buildArgs: () => ({ bin: "vk-venv-only-tool", args: [] }),
      parseOutput: (raw) => ({
        findings: raw.stdout.includes("ran-from-venv")
          ? [finding({ tool: "venv-tool" })]
          : [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      }),
    };
    const summary = await execute({
      projectRoot: cwd,
      config: config(),
      tasks: [task(venvTool, cwd)],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });
    expect(summary.findings.map((f) => f.tool)).toEqual(["venv-tool"]);
  });

  it("reports required missing tools and skips missing optional tools distinctly", async () => {
    const required = adapter({
      id: "missing-required",
      bin: "/definitely/not/a/tool",
    });
    const optional = adapter({
      id: "missing-optional",
      bin: "/definitely/not/a/tool",
      optional: true,
    });

    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [task(required), task(optional)],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INCOMPLETE);
    expect(summary.incomplete.map((issue) => issue.id)).toEqual([
      "missing-required",
    ]);
    expect(summary.skippedOptional.map((issue) => issue.id)).toEqual([
      "missing-optional",
    ]);
  });

  it("classifies unexpected tool exits as adapter crashes", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [task(adapter({ id: "crashy", crash: true }))],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed[0]?.id).toBe("crashy");
  });

  it("classifies execution-time spawn failures as incomplete coverage", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [
        task(
          adapter({
            id: "runtime-missing",
            runBinFor: () => "/definitely/not/a/runtime/tool",
          }),
        ),
      ],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INCOMPLETE);
    expect(summary.incomplete).toEqual([
      { id: "runtime-missing", hint: "install fake" },
    ]);
    expect(summary.ranTools).not.toContain("runtime-missing");
  });

  it("does not misreport an oversized argv (E2BIG) as a missing binary", async () => {
    // ARG_MAX is ~1MB on macOS/Linux; a 3MB single arg reliably trips E2BIG.
    const raw = await run("echo", ["x".repeat(3 * 1024 * 1024)], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    // E2BIG means the binary EXISTS but the invocation failed — reporting it
    // as spawnError would mark an optional tool "not installed" and, for
    // optional tools, silently skip it (false CLEAN). It must surface as a
    // crash-classifiable failure instead.
    expect(raw.spawnError).toBe(false);
    expect(raw.exitCode).not.toBe(0);
  });

  it("classifies buildArgs throws as adapter crashes without aborting the run", async () => {
    const healthy = adapter({
      id: "healthy",
      findings: [finding({ tool: "healthy", ruleId: "keep" })],
    });
    const broken = adapter({
      id: "broken-buildargs",
      onBuild: () => {
        throw new Error("buildArgs exploded");
      },
    });

    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [task(broken), task(healthy)],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed).toEqual([
      { id: "broken-buildargs", stderr: "buildArgs exploded" },
    ]);
    // the healthy adapter still ran and reported its finding
    expect(summary.findings.map((f) => f.tool)).toContain("healthy");
    expect(summary.ranTools).toContain("healthy");
    expect(summary.ranTools).not.toContain("broken-buildargs");
  });

  it("classifies adapter parse failures as adapter crashes", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [
        task(
          adapter({
            id: "bad-parser",
            argsFor: () => ["-e", 'process.stdout.write("{not-json")'],
            parseError: "bad-parser produced invalid JSON",
          }),
        ),
      ],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed[0]).toEqual({
      id: "bad-parser",
      stderr: "bad-parser produced invalid JSON",
    });
    expect(summary.findings).toEqual([]);
  });

  it("rejects malformed non-empty JSON from whole-output JSON adapters", () => {
    const raw: RawOutput = {
      stdout: "{not-json",
      stderr: "",
      exitCode: 1,
    };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    for (const adapterUnderTest of [oxlint, eslint, ruff, golangci, semgrep]) {
      expect(() => adapterUnderTest.parseOutput(raw, ctx)).toThrow(
        `${adapterUnderTest.id} produced invalid JSON output`,
      );
    }
  });

  it("rejects missing JSON from nonzero whole-output JSON adapters", () => {
    const raw: RawOutput = {
      stdout: "",
      stderr: "simulated tool failure\n",
      exitCode: 1,
    };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    for (const adapterUnderTest of [oxlint, eslint, ruff, semgrep]) {
      expect(() => adapterUnderTest.parseOutput(raw, ctx)).toThrow(
        `${adapterUnderTest.id} produced no JSON output on exit code 1`,
      );
    }
  });

  it("rejects malformed JSON lines from line-stream adapters", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(() =>
      astgrep.parseOutput(
        { stdout: "{not-json\n", stderr: "", exitCode: 1 },
        ctx,
      ),
    ).toThrow("ast-grep produced invalid JSON output");

    expect(() =>
      clippy.parseOutput(
        { stdout: "{not-json\n", stderr: "", exitCode: 101 },
        ctx,
      ),
    ).toThrow("clippy produced invalid JSON output");
  });

  it("keeps clippy human output lines non-fatal", () => {
    const result = clippy.parseOutput(
      {
        stdout: "Checking crate v0.1.0\nFinished dev profile\n",
        stderr: "",
        exitCode: 0,
      },
      {
        cwd: process.cwd(),
        fix: false,
        extraArgs: [],
      },
    );

    expect(result.findings).toEqual([]);
  });

  it("rejects nonzero clippy output without diagnostic JSON", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(() =>
      clippy.parseOutput(
        {
          stdout: "",
          stderr: "error: could not load cargo metadata\n",
          exitCode: 101,
        },
        ctx,
      ),
    ).toThrow("clippy failed without diagnostic JSON output");
  });

  it("rejects rustfmt nonzero output without a diff", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(
      rustfmt.parseOutput(
        {
          stdout: "Diff in src/lib.rs:1:\n-old\n+new\n",
          stderr: "",
          exitCode: 1,
        },
        ctx,
      ).findings,
    ).toHaveLength(1);

    expect(() =>
      rustfmt.parseOutput(
        {
          stdout: "",
          stderr: "error: this file contains an unclosed delimiter\n",
          exitCode: 1,
        },
        ctx,
      ),
    ).toThrow("rustfmt failed without diff output");
  });

  it("parses pretty-printed golangci JSON with a trailing human summary", () => {
    const pretty = `Checking packages...\n{\n  "Issues": [\n    {\n      "FromLinter": "ineffassign",\n      "Text": "ineffectual assignment",\n      "Pos": { "Filename": "main.go", "Line": 4, "Column": 2 }\n    }\n  ],\n  "Report": {}\n}\n1 issue.\n`;
    // An issue must name a file of the module it ran in (DV7).
    const cwd = mkdtempSync(resolve(tmpdir(), "validate-kit-golangci-"));
    writeFileSync(resolve(cwd, "main.go"), "package main\n");
    const result = golangci.parseOutput(
      { stdout: pretty, stderr: "", exitCode: 1 },
      { cwd, fix: false, extraArgs: [] },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("ineffassign");
  });

  it("crashes golangci runs on failure exit codes instead of passing them", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "validate-kit-golangci-"));
    const binDir = resolve(cwd, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(cwd, "main.go"), "package main\nfunc main() {}\n");
    // exit 3 = golangci "failure" (e.g. compilation error). It can still emit
    // valid JSON with zero Issues plus a Report.Error — treating exit 3 as ok
    // would parse that as a clean run (false CLEAN).
    fakeTool(
      binDir,
      "golangci-lint",
      '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "golangci-lint has version v2.0.0"; exit 0; fi\necho \'{"Issues":[],"Report":{"Error":"typechecking error"}}\'\nexit 3\n',
    );

    const summary = await execute({
      projectRoot: cwd,
      config: config(),
      tasks: [task(golangci, cwd)],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed[0]?.id).toBe("golangci-lint");
  });

  it("fails loud when semgrep reports scan errors instead of dropping them", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };
    const withErrors = JSON.stringify({
      results: [],
      errors: [
        {
          level: "error",
          message: "Syntax error in skipped.py — file not analyzed",
          path: "skipped.py",
        },
      ],
    });
    expect(() =>
      semgrep.parseOutput({ stdout: withErrors, stderr: "", exitCode: 0 }, ctx),
    ).toThrow(/skipped\.py/);

    const warnOnly = JSON.stringify({
      results: [],
      errors: [{ level: "warn", message: "rule skipped", path: "x.py" }],
    });
    expect(
      semgrep.parseOutput({ stdout: warnOnly, stderr: "", exitCode: 0 }, ctx)
        .findings,
    ).toEqual([]);
  });

  it("maps ruff security and syntax findings to error severity", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };
    const issues = JSON.stringify([
      {
        code: "S608",
        message: "possible SQL injection",
        filename: "q.py",
        location: { row: 1, column: 1 },
        fix: null,
      },
      {
        code: null,
        message: "SyntaxError: invalid syntax",
        filename: "broken.py",
        location: { row: 2, column: 1 },
        fix: null,
      },
      {
        code: "F401",
        message: "unused import",
        filename: "a.py",
        location: { row: 3, column: 1 },
        fix: null,
      },
      {
        code: "FBT001",
        message: "boolean positional arg",
        filename: "b.py",
        location: { row: 4, column: 1 },
        fix: null,
      },
    ]);
    const result = ruff.parseOutput(
      { stdout: issues, stderr: "", exitCode: 1 },
      ctx,
    );
    expect(result.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["S608", "error"],
      [undefined, "error"],
      ["F401", "error"],
      ["FBT001", "warning"],
    ]);
  });

  it("parses golangci JSON before its trailing human summary", () => {
    const result = golangci.parseOutput(
      {
        stdout: '{"Issues":[],"Report":{}}\n0 issues.\n',
        stderr: "",
        exitCode: 0,
      },
      {
        cwd: process.cwd(),
        fix: false,
        extraArgs: [],
      },
    );

    expect(result.findings).toEqual([]);
  });

  it("rejects nonzero golangci output without JSON", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(() =>
      golangci.parseOutput(
        {
          stdout: "",
          stderr:
            "Error: can't load config: open missing.yml: no such file or directory\n",
          exitCode: 3,
        },
        ctx,
      ),
    ).toThrow("golangci-lint failed without JSON output");
  });

  it("treats gofumpt exit 1 as a crash", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "validate-kit-gofumpt-"));
    const binDir = resolve(cwd, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(resolve(cwd, "main.go"), "package main\nfunc main() {}\n");
    fakeTool(
      binDir,
      "gofumpt",
      // Answers --version like the real tool: the failure under test is the run.
      '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "v0.10.0"; exit 0; fi\necho "simulated gofumpt infrastructure failure" >&2\nexit 1\n',
    );

    const summary = await execute({
      projectRoot: cwd,
      config: config(),
      tasks: [task(gofumpt, cwd)],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed[0]?.id).toBe("gofumpt");
    expect(summary.crashed[0]?.stderr.trim()).toBe(
      "simulated gofumpt infrastructure failure",
    );
    expect(summary.findings).toEqual([]);
  });

  it("rejects ruff-format exit 1 without file-level reformat output", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(
      ruffFormat.parseOutput(
        {
          stdout: "Would reformat: good.py\n1 file would be reformatted\n",
          stderr: "",
          exitCode: 1,
        },
        ctx,
      ).findings,
    ).toHaveLength(1);

    expect(() =>
      ruffFormat.parseOutput(
        {
          stdout: "1 file would be reformatted\n",
          stderr: "",
          exitCode: 1,
        },
        ctx,
      ),
    ).toThrow("ruff-format failed without file-level reformat output");
  });

  it("parses tsc diagnostics in paths containing parentheses", () => {
    const result = tsc.parseOutput(
      {
        stdout:
          "src/app (legacy)/main.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        stderr: "",
        exitCode: 2,
      },
      { cwd: process.cwd(), fix: false, extraArgs: [] },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "TS2322",
      line: 4,
      col: 7,
    });
    expect(result.findings[0]?.file.endsWith("src/app (legacy)/main.ts")).toBe(
      true,
    );
  });

  it("does not headline All clear when an optional tool was skipped", () => {
    const summary = {
      scope: { profile: "dev", mode: "full" as const, files: null },
      findings: [],
      incomplete: [],
      skippedOptional: [{ id: "semgrep", hint: "brew install semgrep" }],
      crashed: [],
      fixesByTool: {},
      filesByTool: {},
      ranTools: ["oxlint"],
      toolStatus: { oxlint: "pass" as const, semgrep: "not_run" as const },
      toolVersions: {},
      durationMs: 1200,
      exitCode: EXIT.CLEAN,
      fixMode: false,
    };
    const text = renderPretty(summary, process.cwd());
    expect(text).toContain("1 optional skipped");
  });

  it("parses tsc global diagnostics instead of returning a clean result", () => {
    const result = tsc.parseOutput(
      {
        stdout: "error TS5023: Unknown compiler option '--badFlag'.\n",
        stderr: "",
        exitCode: 1,
      },
      {
        cwd: process.cwd(),
        fix: false,
        extraArgs: [],
      },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      tool: "tsc",
      layer: "type-check",
      language: "ts",
      file: toPosix(process.cwd()),
      line: 1,
      col: 1,
      ruleId: "TS5023",
      severity: "error",
      message: "Unknown compiler option '--badFlag'.",
      fixable: false,
    });
  });

  it("rejects prettier exit 2 errors while preserving no-match output", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };

    expect(() =>
      prettier.parseOutput(
        {
          stdout: "",
          stderr: '[error] Invalid configuration for file "index.ts".\n',
          exitCode: 2,
        },
        ctx,
      ),
    ).toThrow("prettier failed");

    expect(
      prettier.parseOutput(
        {
          stdout: "",
          stderr:
            '[error] No files matching the pattern were found: "no-match/**/*.ts".\n',
          exitCode: 2,
        },
        ctx,
      ).findings,
    ).toEqual([]);
  });

  it("applies severity overrides, deduplicates findings, and sorts output", async () => {
    const duplicate = finding({
      tool: "fake",
      file: resolve(process.cwd(), "z.ts"),
      line: 2,
      col: 1,
      ruleId: "noisy",
      message: "duplicate",
    });
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config({
        severityOverrides: [
          { tool: "fake", ruleId: "noisy", severity: "off" },
          { tool: "fake", ruleId: "keep", severity: "error" },
        ],
      }),
      tasks: [
        task(
          adapter({
            id: "fake",
            findings: [
              duplicate,
              finding({
                tool: "fake",
                file: resolve(process.cwd(), "b.ts"),
                line: 3,
                col: 1,
                ruleId: "keep",
              }),
              finding({
                tool: "fake",
                file: resolve(process.cwd(), "a.ts"),
                line: 1,
                col: 1,
                ruleId: "keep",
              }),
              duplicate,
            ],
          }),
        ),
      ],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.findings.map((item) => item.file.endsWith("a.ts"))).toEqual([
      true,
      false,
    ]);
    expect(summary.findings).toHaveLength(2);
    expect(summary.findings.every((item) => item.severity === "error")).toBe(
      true,
    );
    expect(summary.exitCode).toBe(EXIT.FINDINGS);
  });

  it("runs writeback fixes before formatters within the same root", async () => {
    const calls: string[] = [];
    const lint = adapter({
      id: "lint-fix",
      layer: "lint",
      supportsFix: true,
      fixWriteBack: true,
      onBuild: (ctx) => calls.push(`lint:${ctx.fix ? "fix" : "read"}`),
    });
    const format = adapter({
      id: "format-fix",
      layer: "format",
      supportsFix: true,
      fixWriteBack: true,
      onBuild: (ctx) => calls.push(`format:${ctx.fix ? "fix" : "read"}`),
    });

    await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [task(format), task(lint)],
      fix: true,
      scope: { profile: "test", mode: "full", files: null },
    });

    const fixCalls = calls.filter((call) => call.endsWith(":fix"));
    expect(fixCalls).toEqual(["lint:fix", "format:fix"]);
  });

  it("classifies writeback fix-pass failures as adapter crashes", async () => {
    const summary = await execute({
      projectRoot: process.cwd(),
      config: config(),
      tasks: [
        task(
          adapter({
            id: "fix-crashy",
            supportsFix: true,
            fixWriteBack: true,
            argsFor: (ctx) =>
              ctx.fix
                ? [
                    "-e",
                    'process.stderr.write("fix pass exploded\\n");process.exit(7)',
                  ]
                : ["-e", ""],
          }),
        ),
      ],
      fix: true,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.exitCode).toBe(EXIT.INTERNAL);
    expect(summary.crashed).toEqual([
      { id: "fix-crashy", stderr: "fix pass exploded\n" },
    ]);
    expect(summary.ranTools).not.toContain("fix-crashy");
  });

  it("serializes fix write-backs when a project-scoped fixer nests a sub-dir formatter", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-fixrace-"));
    const sub = resolve(root, "sub");
    mkdirSync(sub);
    const logPath = resolve(root, "fix-events.log");

    // ast-grep-shaped task: cwd = project root, no file list → writes anywhere
    // under root, including sub/.
    const projectFixer = adapter({
      id: "project-fixer",
      layer: "lint",
      supportsFix: true,
      fixWriteBack: true,
      argsFor: (ctx) =>
        ctx.fix ? sleepingNodeArgs("project-fixer", 150) : ["-e", ""],
      env: { LOG: logPath },
    });
    // prettier-shaped task: cwd = sub-dir inside the fixer's write scope.
    const subFormatter = adapter({
      id: "sub-formatter",
      layer: "format",
      supportsFix: true,
      fixWriteBack: true,
      argsFor: (ctx) =>
        ctx.fix ? sleepingNodeArgs("sub-formatter", 150) : ["-e", ""],
      env: { LOG: logPath },
    });

    await execute({
      projectRoot: root,
      config: config(),
      tasks: [task(subFormatter, sub), task(projectFixer, root)],
      fix: true,
      scope: { profile: "test", mode: "full", files: null },
    });

    const intervals = readIntervals(logPath);
    const fixer = intervals["project-fixer"];
    const formatter = intervals["sub-formatter"];
    if (!fixer || !formatter)
      throw new Error("fix pass did not log both tasks");
    // Overlapping write scopes must never run concurrently, and the formatter
    // must run LAST so it normalizes the structural fixer's edits.
    expect(fixer.end).toBeLessThanOrEqual(formatter.start);
  });

  it("serializes fix write-backs whose explicit file lists overlap across roots", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-fixrace-files-"));
    const sub = resolve(root, "sub");
    mkdirSync(sub);
    const logPath = resolve(root, "fix-events.log");
    const shared = resolve(sub, "a.ts");
    writeFileSync(shared, "export {};\n");

    // changed-mode shape: project-scoped tool gets cwd=root + explicit files.
    const rootFixer = adapter({
      id: "root-fixer",
      layer: "lint",
      supportsFix: true,
      fixWriteBack: true,
      argsFor: (ctx) =>
        ctx.fix ? sleepingNodeArgs("root-fixer", 150) : ["-e", ""],
      env: { LOG: logPath },
    });
    const subFixer = adapter({
      id: "sub-fixer",
      layer: "format",
      supportsFix: true,
      fixWriteBack: true,
      argsFor: (ctx) =>
        ctx.fix ? sleepingNodeArgs("sub-fixer", 150) : ["-e", ""],
      env: { LOG: logPath },
    });

    await execute({
      projectRoot: root,
      config: config(),
      tasks: [task(subFixer, sub, [shared]), task(rootFixer, root, [shared])],
      fix: true,
      scope: { profile: "test", mode: "changed", files: 1 },
    });

    const intervals = readIntervals(logPath);
    const fixer = intervals["root-fixer"];
    const formatter = intervals["sub-fixer"];
    if (!fixer || !formatter)
      throw new Error("fix pass did not log both tasks");
    expect(fixer.end).toBeLessThanOrEqual(formatter.start);
  });

  it("clears a before-pass crash when the post-fix passes prove the tool healthy", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-transient-"));
    const flagPath = resolve(root, "crashed-once");
    // First invocation crashes (exit 7), every later one succeeds — a
    // transient failure in the before pass. The fix + after passes prove the
    // tool healthy, so the final summary must NOT report INTERNAL.
    const transient = adapter({
      id: "transient",
      supportsFix: true,
      fixWriteBack: true,
      argsFor: () => [
        "-e",
        `const fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(flagPath)})){fs.writeFileSync(${JSON.stringify(flagPath)},"1");process.exit(7);}`,
      ],
    });

    const summary = await execute({
      projectRoot: root,
      config: config(),
      tasks: [task(transient, root)],
      fix: true,
      scope: { profile: "test", mode: "full", files: null },
    });

    expect(summary.crashed).toEqual([]);
    expect(summary.exitCode).toBe(EXIT.CLEAN);
  });

  it("honors concurrency one by serializing runnable tasks", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-runner-"));
    const logPath = resolve(root, "events.log");

    await execute({
      projectRoot: root,
      config: config({ concurrency: 1 }),
      tasks: [
        task(
          adapter({
            id: "one",
            argsFor: () => sleepingNodeArgs("one"),
            env: { LOG: logPath },
          }),
          root,
        ),
        task(
          adapter({
            id: "two",
            argsFor: () => sleepingNodeArgs("two"),
            env: { LOG: logPath },
          }),
          root,
        ),
      ],
      fix: false,
      scope: { profile: "test", mode: "full", files: null },
    });

    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [id, phase, ms] = line.split(" ");
        return { id, phase, ms: Number(ms) };
      });
    const firstEnd = events.find(
      (event) => event.id === "one" && event.phase === "end",
    );
    const secondStart = events.find(
      (event) => event.id === "two" && event.phase === "start",
    );
    expect(firstEnd?.ms).toBeLessThanOrEqual(secondStart?.ms ?? 0);
  });
});
