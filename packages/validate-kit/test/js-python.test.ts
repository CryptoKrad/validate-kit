import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attw } from "../src/adapters/attw.js";
import { basedpyright } from "../src/adapters/basedpyright.js";
import { crosshair } from "../src/adapters/crosshair.js";
import { PACK_ENV } from "../src/adapters/npm-package.js";
import { publint } from "../src/adapters/publint.js";
import { sizeLimit } from "../src/adapters/size-limit.js";
import { ty } from "../src/adapters/ty.js";
import { vulture } from "../src/adapters/vulture.js";
import type { PlanEnv, RawOutput, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// Every output below was captured from a real run on 2026-10-18 (size-limit
// 14.2.0, publint 0.3.25, attw 0.18.5, basedpyright 1.40.2, ty 0.0.86,
// vulture 2.16, crosshair-tool 0.0.111) against a fixture with one problem
// planted, then trimmed; <TMP> is the run's folder
// (docs/research/lint-toolchain/sota-2026-10-18/js-python.md and its assets).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, fix: false, extraArgs: [], ...extra };
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

function env(root: string, more: Partial<PlanEnv> = {}): PlanEnv {
  return {
    projectRoot: root,
    scopedFiles: [],
    toolConfig: {},
    config: { ignore: [], tools: {} },
    ...more,
  } as unknown as PlanEnv;
}

/** A folder with these files (relative path to contents). */
function project(prefix: string, files: Record<string, string>): string {
  const root = tmp(prefix);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A basedpyright diagnostic as 1.40.2 printed it (over-json.stdout). */
const diagnostic = (file: string, severity: string) => ({
  file,
  severity,
  message:
    'Argument of type "Literal[\'x\']" cannot be assigned to parameter "a" of type "int" in function "add"\n  "Literal[\'x\']" is not assignable to "int"',
  range: {
    start: { line: 4, character: 4 },
    end: { line: 4, character: 7 },
  },
  rule: "reportArgumentType",
});

/** basedpyright's whole `--outputjson` report. */
const report = (...diagnostics: unknown[]) =>
  `\n${JSON.stringify({ version: "1.40.2", time: "1792311579821", generalDiagnostics: diagnostics, summary: {} }, null, 4)}\n`;

/** A ty issue as 0.0.86 printed it (over-gitlab.stdout), at a severity. */
const issue = (severity: string) =>
  `[\n  {\n    "check_name": "invalid-argument-type",\n    "description": "invalid-argument-type: Argument to function \`add\` is incorrect: Expected \`int\`, found \`Literal[\\"x\\"]\`",\n    "severity": "${severity}",\n    "fingerprint": "f5e2380913859577",\n    "location": {\n      "path": "mod.py",\n      "positions": {\n        "begin": {\n          "line": 5,\n          "column": 5\n        },\n        "end": {\n          "line": 5,\n          "column": 8\n        }\n      }\n    }\n  }\n]`;

describe("size-limit", () => {
  const config =
    '[ { "name": "index", "path": "dist/index.js", "limit": "1 kB", "gzip": true } ]\n';

  it("reports a check over its limit as an error at the check in the config", () => {
    const root = project("vk-sl-", { ".size-limit.json": config });
    const over =
      '[\n  {\n    "name": "index",\n    "passed": false,\n    "size": 3559,\n    "sizeLimit": 1000\n  }\n]\n';
    const { findings } = sizeLimit.parseOutput(ran(1, over), ctx(root));
    expect(findings).toMatchObject([
      {
        file: `${root}/.size-limit.json`,
        line: 1,
        severity: "error",
        message:
          "index is 3559 B, over its limit of 1000 B: make it smaller, or raise the limit in .size-limit.json",
      },
    ]);
    const clean =
      '[\n  {\n    "name": "index",\n    "passed": true,\n    "size": 3559,\n    "sizeLimit": 10000\n  }\n]\n';
    expect(sizeLimit.parseOutput(ran(0, clean), ctx(root)).findings).toEqual(
      [],
    );
  });

  it("is a crash, never a pass, when the build is missing or the config is", () => {
    const root = project("vk-sl-", { ".size-limit.json": config });
    // No dist/: the check passes at 0 bytes, and size-limit exits 1.
    const nofile =
      '[\n  {\n    "name": "index",\n    "passed": true,\n    "size": 0\n  }\n]\n';
    expect(() => sizeLimit.parseOutput(ran(1, nofile), ctx(root))).toThrow(
      /build first/,
    );
    const noconfig =
      '{\n  "error": "SizeLimitError: Create Size Limit config in *package.json*\\n    at getConfig (file:///private<TMP>/fixture/node_modules/size-limit/get-config.js:205:32)"\n}\n';
    expect(() => sizeLimit.parseOutput(ran(1, noconfig), ctx(root))).toThrow(
      "size-limit failed: SizeLimitError: Create Size Limit config in *package.json*",
    );
    expect(sizeLimit.refuseArgs?.(["--ignore-missing"])).toBeDefined();
    expect(sizeLimit.refuseArgs?.(["dist/index.js"])).toBeDefined();
  });

  it("runs from each package with a size-limit config, and in a changed run only for a package the change touched", () => {
    const root = project("vk-sl-", {
      "package.json": '{ "name": "root", "private": true }',
      "a/package.json": '{ "name": "a" }',
      "a/.size-limit.json": config,
      "b/package.json": '{ "name": "b", "size-limit": [] }',
      "c/package.json": '{ "name": "c" }',
    });
    const scopedFiles = ["package.json", "a/package.json", "b/package.json"]
      .concat("c/package.json")
      .map((f) => `${root}/${f}`);
    const seed = { cwd: root };
    expect(sizeLimit.expand?.(seed, env(root, { scopedFiles }))).toEqual([
      { cwd: `${root}/a` },
      { cwd: `${root}/b` },
    ]);
    expect(
      sizeLimit.expand?.(
        seed,
        env(root, { scopedFiles, changedPaths: ["b/src/x.ts"] }),
      ),
    ).toEqual([{ cwd: `${root}/b` }]);
  });
});

describe("publint", () => {
  const header =
    "Running publint v0.3.25 for publint-fixture...\nPacking files with `npm pack`...\nLinting...\n";

  it("reports errors, warnings and suggestions by section, at the package.json field they name", () => {
    const root = project("vk-pl-", {
      "package.json":
        '{\n  "name": "publint-fixture",\n  "version": "1.0.0",\n  "type": "module",\n  "exports": { ".": { "default": "./dist/missing.js" } },\n  "files": ["dist"]\n}\n',
    });
    const error = `${header}Errors:\n1. pkg.exports["."].default is ./dist/missing.js but the file does not exist.\n`;
    const [f] = publint.parseOutput(ran(1, error), ctx(root)).findings;
    expect(f).toMatchObject({
      file: `${root}/package.json`,
      line: 5,
      severity: "error",
      message:
        'pkg.exports["."].default is ./dist/missing.js but the file does not exist.',
    });
    const warn = `${header}Warnings:\n1. pkg.main is ./dist/index.js and is written in ESM, but is interpreted as CJS. Consider using the .mjs extension, e.g. ./dist/index.mjs\n2. /dist/index.js is written in ESM, but is interpreted as CJS. Consider using the .mjs extension, e.g. /dist/index.mjs\nSuggestions:\n1. The package does not specify the "type" field. Node.js may attempt to detect the package type causing a small performance hit. Consider adding "type": "commonjs".\n`;
    expect(
      publint
        .parseOutput(ran(0, warn), ctx(root))
        .findings.map((x) => [x.severity, x.line]),
    ).toEqual([
      ["warning", 1],
      ["warning", 1],
      ["info", 1],
    ]);
    expect(
      publint.parseOutput(ran(0, `${header}All good!\n`), ctx(root)).findings,
    ).toEqual([]);
  });

  it("is a crash when it did not lint, or prints a line it never printed", () => {
    const root = tmp("vk-pl-");
    expect(() =>
      publint.parseOutput(
        ran(1, "Unable to read package.json at <TMP>/fixture/nonexistent\n"),
        ctx(root),
      ),
    ).toThrow(/did not lint the package: Unable to read package.json/);
    // A package npm will not pack: its reason is quoted in publint's trace.
    const failed = `Error: Failed to find packed tarball file in <TMP>/publint-pack-bPu86P. Command output:\n{\n  "stderr": "npm error Invalid package, must have name and version\\nnpm error A complete log of this run can be found in: <HOME>/.npm/_logs/x-debug-0.log\\n",\n  "stdout": "",\n  "exitCode": 1\n}\n`;
    expect(() =>
      publint.parseOutput(
        ran(
          1,
          "Running publint v0.3.25 for mono-root...\nPacking files with `npm pack`...\n",
          failed,
        ),
        ctx(root),
      ),
    ).toThrow(
      "publint did not lint the package: npm error Invalid package, must have name and version",
    );
    expect(() =>
      publint.parseOutput(ran(0, `${header}Problems:\n`), ctx(root)),
    ).toThrow(/output format may have changed/);
  });

  it("runs on each package it could publish that it or a package above lists, or on all when enabled; never on a private root or a folder's type marker", () => {
    const mono = project("vk-pl-", {
      "package.json":
        '{ "name": "mono", "version": "0.0.0", "private": true, "devDependencies": { "publint": "0.3.25" } }',
      "packages/a/package.json": '{ "name": "a", "version": "1.0.0" }',
      "packages/a/src/esm/package.json": '{ "type": "commonjs" }',
    });
    const monoFiles = [
      "package.json",
      "packages/a/package.json",
      "packages/a/src/esm/package.json",
    ].map((f) => `${mono}/${f}`);
    expect(
      publint.expand?.({ cwd: mono }, env(mono, { scopedFiles: monoFiles })),
    ).toEqual([{ cwd: `${mono}/packages/a` }]);
    const root = project("vk-pl-", {
      "a/package.json":
        '{ "name": "a", "version": "1.0.0", "devDependencies": { "publint": "0.3.25" } }',
      "b/package.json": '{ "name": "b", "version": "1.0.0" }',
      "c/package.json": '{ "name": "c" }',
    });
    const scopedFiles = ["a", "b", "c"].map((d) => `${root}/${d}/package.json`);
    const seed = { cwd: root };
    expect(publint.expand?.(seed, env(root, { scopedFiles }))).toEqual([
      { cwd: `${root}/a` },
    ]);
    expect(
      publint.expand?.(
        seed,
        env(root, { scopedFiles, toolConfig: { enabled: true } }),
      ),
    ).toEqual([{ cwd: `${root}/a` }, { cwd: `${root}/b` }]);
  });
});

describe("packing (publint, attw)", () => {
  it("runs no script of the package: npm runs `prepare` on pack even with scripts ignored", () => {
    const root = project("vk-pack-", {
      "package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        scripts: { prepare: "touch PREPARED", prepack: "touch PREPACKED" },
      }),
    });
    const out = tmp("vk-pack-out-");
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--pack-destination", out],
      {
        cwd: root,
        env: { ...process.env, ...PACK_ENV },
        stdio: "ignore",
        // A .cmd shim is a batch file, which only cmd.exe can start.
        shell: process.platform === "win32",
      },
    );
    expect(readdirSync(root).toSorted()).toEqual(["package.json"]);
    expect(readdirSync(out)).toEqual(["p-1.0.0.tgz"]);
  });
});

/** An attw problem at the `./sub` entrypoint. */
const problem = (kind: string, resolutionKind: string) => ({
  kind,
  entrypoint: "./sub",
  resolutionKind,
});

describe("attw", () => {
  const manifest =
    '{ "name": "attw-fixture", "version": "1.0.0", "type": "module",\n  "main": "./index.js", "types": "./index.d.ts", "files": ["index.js", "index.d.ts"] }\n';
  // bad-json.stdout without the resolutions' traces.
  const bad = JSON.stringify({
    analysis: {
      packageName: "attw-fixture",
      packageVersion: "1.0.0",
      types: { kind: "included" },
      problems: [
        {
          kind: "CJSResolvesToESM",
          entrypoint: ".",
          resolutionKind: "node16-cjs",
        },
      ],
    },
    problems: {
      CJSResolvesToESM: [
        {
          kind: "CJSResolvesToESM",
          entrypoint: ".",
          resolutionKind: "node16-cjs",
        },
      ],
    },
  });

  it("reports each problem as an error at the package.json field, and none when the exit code says the profile hides them", () => {
    const root = project("vk-attw-", { "package.json": manifest });
    const { findings } = attw.parseOutput(ran(1, bad), ctx(root));
    expect(findings).toMatchObject([
      {
        file: `${root}/package.json`,
        line: 2,
        ruleId: "CJSResolvesToESM",
        severity: "error",
        message: 'Entrypoint is ESM-only at "." under node16-cjs resolution',
      },
    ]);
    // --profile esm-only: the same JSON, exit 0.
    expect(attw.parseOutput(ran(0, bad), ctx(root)).findings).toEqual([]);
    const clean = JSON.stringify({
      analysis: { types: { kind: "included" }, problems: [] },
      problems: {},
    });
    expect(attw.parseOutput(ran(0, clean), ctx(root)).findings).toEqual([]);
  });

  it("leaves out the problems the project's profile or ignore-rules hide, from its flags and its .attw.json", () => {
    const root = project("vk-attw-", { "package.json": manifest });
    const both = JSON.stringify({
      analysis: {
        types: { kind: "included" },
        problems: [
          problem("NoResolution", "node10"),
          problem("CJSResolvesToESM", "node16-cjs"),
        ],
      },
    });
    const kinds = (c: ToolContext) =>
      attw.parseOutput(ran(1, both), c).findings.map((f) => f.ruleId);
    expect(kinds(ctx(root))).toEqual(["NoResolution", "CJSResolvesToESM"]);
    expect(kinds(ctx(root, { extraArgs: ["--profile", "node16"] }))).toEqual([
      "CJSResolvesToESM",
    ]);
    writeFileSync(
      join(root, ".attw.json"),
      '{ "ignoreRules": ["cjs-resolves-to-esm"] }',
    );
    expect(kinds(ctx(root))).toEqual(["NoResolution"]);
  });

  it("is a crash on a usage error, and packs offline with npm's scripts off", () => {
    const root = project("vk-attw-", { "package.json": manifest });
    expect(() =>
      attw.parseOutput(
        ran(1, "", "error: unknown option '--bogus'\n"),
        ctx(root),
      ),
    ).toThrow(
      "attw produced no JSON output on exit code 1: error: unknown option '--bogus'",
    );
    // Packed into the task's scratch folder, never beside the user's own
    // tarball, by the repository's package manager.
    const scratch = tmp("vk-attw-scratch-");
    const built = attw.buildArgs(
      ctx(root, { options: { packer: "pnpm" }, tempDir: () => scratch }),
    );
    expect(built.bin).toBe("sh");
    expect(built.args.slice(3, 5)).toEqual([`${scratch}/pack`, "pnpm"]);
    expect(built.args.slice(-2)).toEqual(["--format", "json"]);
    expect(built.env).toBe(PACK_ENV);
    expect(attw.refuseArgs?.(["--from-npm"])).toBeDefined();
  });

  it("runs where a package it could publish lists it, one above does, or it has an .attw.json; packs with pnpm under a pnpm lockfile", () => {
    const root = project("vk-attw-", {
      "package.json":
        '{ "name": "mono", "version": "0.0.0", "private": true, "devDependencies": { "@arethetypeswrong/cli": "0.18.5" } }',
      "pnpm-lock.yaml": "",
      "a/package.json": '{ "name": "a", "version": "1.0.0" }',
    });
    const other = project("vk-attw-", {
      "b/package.json": '{ "name": "b", "version": "1.0.0" }',
      "b/.attw.json": '{ "profile": "node16" }',
      "c/package.json": '{ "name": "c", "version": "1.0.0" }',
    });
    expect(
      attw.expand?.(
        { cwd: root },
        env(root, {
          scopedFiles: [`${root}/package.json`, `${root}/a/package.json`],
        }),
      ),
    ).toEqual([{ cwd: `${root}/a`, options: { packer: "pnpm" } }]);
    expect(
      attw.expand?.(
        { cwd: other },
        env(other, {
          scopedFiles: ["b", "c"].map((d) => `${other}/${d}/package.json`),
        }),
      ),
    ).toEqual([{ cwd: `${other}/b`, options: { packer: "npm" } }]);
  });
});

describe("basedpyright", () => {
  it("reports each diagnostic 1-based at its file, by severity", () => {
    const root = tmp("vk-bp-");
    const { findings } = basedpyright.parseOutput(
      ran(1, report(diagnostic(`${root}/mod.py`, "error"))),
      ctx(root),
    );
    expect(findings).toEqual([
      {
        tool: "basedpyright",
        layer: "type-check",
        language: "python",
        file: `${root}/mod.py`,
        line: 5,
        col: 5,
        endLine: 5,
        endCol: 8,
        ruleId: "reportArgumentType",
        severity: "error",
        message:
          'Argument of type "Literal[\'x\']" cannot be assigned to parameter "a" of type "int" in function "add"',
        fixable: false,
      },
    ]);
    expect(
      basedpyright
        .parseOutput(
          ran(0, report(diagnostic(`${root}/mod.py`, "warning"))),
          ctx(root),
        )
        .findings.map((f) => f.severity),
    ).toEqual(["warning"]);
    expect(
      basedpyright.parseOutput(ran(0, report()), ctx(root)).findings,
    ).toEqual([]);
  });

  it("is a crash when it could not read its config, or rejected a value in it, and checked without it", () => {
    const root = tmp("vk-bp-");
    const stderr =
      'Pyproject file parse attempt 1 Error: Invalid TOML document: incomplete key-value: cannot find end of key\n\n1:  [tool.basedpyright\n     ^\n\nConfig file "<TMP>/bad/pyproject.toml" could not be parsed. Verify that format is correct.\n';
    expect(() =>
      basedpyright.parseOutput(
        ran(1, report(diagnostic(`${root}/mod.py`, "error")), stderr),
        ctx(root),
      ),
    ).toThrow(
      'basedpyright did not check on the project\'s settings: Config file "<TMP>/bad/pyproject.toml" could not be parsed. Verify that format is correct.',
    );
    // A value it rejects: it runs on "recommended" and exits by its findings.
    const rejected =
      'invalid "typeCheckingMode" value: "strcit". expected: "off", "basic", "standard", "strict", "recommended", or "all"\nConfig "reportUnusedCallResult" entry must be true, false, "none", "hint", "information", "warning", or "error". (received: "nope")\n';
    expect(() =>
      basedpyright.parseOutput(ran(0, report(), rejected), ctx(root)),
    ).toThrow(/Config "reportUnusedCallResult" entry must be/);
  });

  it("runs where pyrightconfig.json, [tool.basedpyright] or [tool.pyright] is, not on its own defaults", () => {
    const none = project("vk-bp-", {
      "pyproject.toml": '[project]\nname = "a"\n',
    });
    expect(basedpyright.adoptedAt?.(none, none)).toBe(false);
    const pyright = project("vk-bp-", {
      "pyproject.toml": '[tool.pyright]\ntypeCheckingMode = "standard"\n',
    });
    expect(basedpyright.adoptedAt?.(pyright, pyright)).toBe(true);
    const based = project("vk-bp-", {
      "pyproject.toml": '[tool.basedpyright]\ntypeCheckingMode = "standard"\n',
    });
    expect(basedpyright.adoptedAt?.(based, based)).toBe(true);
    const json = project("vk-bp-", { "pyrightconfig.json": "{}" });
    expect(basedpyright.adoptedAt?.(json, json)).toBe(true);
  });
});

describe("ty", () => {
  it("reports each issue at its position, an error as an error and a warning as a warning", () => {
    const root = tmp("vk-ty-");
    const { findings } = ty.parseOutput(ran(1, issue("major")), ctx(root));
    expect(findings).toMatchObject([
      {
        file: `${root}/mod.py`,
        line: 5,
        col: 5,
        endLine: 5,
        endCol: 8,
        ruleId: "invalid-argument-type",
        severity: "error",
        message:
          'Argument to function `add` is incorrect: Expected `int`, found `Literal["x"]`',
      },
    ]);
    expect(
      ty.parseOutput(ran(1, issue("minor")), ctx(root)).findings[0]?.severity,
    ).toBe("warning");
    expect(ty.parseOutput(ran(0, "[]"), ctx(root)).findings).toEqual([]);
  });

  it("is a crash on another output shape, and exit 2 (a bad config) is never a pass", () => {
    const root = tmp("vk-ty-");
    expect(() =>
      ty.parseOutput(
        ran(
          1,
          "mod.py:5:5: error[invalid-argument-type] Argument\nFound 1 diagnostic\n",
        ),
        ctx(root),
      ),
    ).toThrow(/invalid JSON/);
    expect(() => ty.parseOutput(ran(1, issue("blocker")), ctx(root))).toThrow(
      /known severity/,
    );
    expect(ty.buildArgs(ctx(root)).okExitCodes).toEqual([0, 1]);
  });

  it("runs where ty.toml or [tool.ty] is, at the folder or above", () => {
    const root = project("vk-ty-", {
      "pyproject.toml": "[tool.ty.rules]\n",
      "pkg/pyproject.toml": '[project]\nname = "pkg"\n',
      "other/ty.toml": "[rules]\n",
    });
    expect(ty.adoptedAt?.(`${root}/pkg`, root)).toBe(true);
    const bare = project("vk-ty-", { "pyproject.toml": "[tool.ruff]\n" });
    expect(ty.adoptedAt?.(bare, bare)).toBe(false);
    const own = project("vk-ty-", { "ty.toml": "[rules]\n" });
    expect(ty.adoptedAt?.(own, own)).toBe(true);
  });
});

describe("vulture", () => {
  it("reports each line as a warning with its confidence, the path relative or absolute", () => {
    const root = tmp("vk-vulture-");
    const { findings } = vulture.parseOutput(
      ran(
        3,
        `mod.py:5: unused function 'unused_helper' (60% confidence)\n${root}/sub/conf.py:1: unused import 'os' (90% confidence)\n${root}/sub/conf.py:9: unreachable code after 'return' (100% confidence, 2 lines)\nmod.py:13: unsatisfiable 'if' condition (100% confidence)\n`,
      ),
      ctx(root),
    );
    expect(findings.map((f) => [f.file, f.line, f.ruleId, f.severity])).toEqual(
      [
        [`${root}/mod.py`, 5, "unused-function", "warning"],
        [`${root}/sub/conf.py`, 1, "unused-import", "warning"],
        [`${root}/sub/conf.py`, 9, "unreachable-code", "warning"],
        [`${root}/mod.py`, 13, "unsatisfiable-condition", "warning"],
      ],
    );
    expect(findings[0]?.message).toBe(
      "unused function 'unused_helper' (60% confidence): remove it, or name it in a whitelist file vulture reads",
    );
    // A whitelist cannot hold a condition.
    expect(findings[3]?.message).toBe(
      "unsatisfiable 'if' condition (100% confidence): fix the condition, or remove the code it decides",
    );
    expect(() =>
      vulture.parseOutput(ran(3, "Scanning mod.py\n"), ctx(root)),
    ).toThrow(/output format may have changed/);
  });

  it("runs where the folder's own pyproject has [tool.vulture], on the package's files unless its config names paths", () => {
    const root = project("vk-vulture-", {
      "pyproject.toml": "[tool.vulture]\nmin_confidence = 60\n",
      "sub/pyproject.toml": '[project]\nname = "sub"\n',
    });
    expect(vulture.adoptedAt?.(root, root)).toBe(true);
    expect(vulture.adoptedAt?.(`${root}/sub`, root)).toBe(false);
    const scopedFiles = [
      "mod.py",
      "pkg/a.py",
      "pkg/a.pyi",
      "sub/pyproject.toml",
      "sub/b.py",
    ].map((f) => `${root}/${f}`);
    const [task] = (vulture.expand?.(
      { cwd: root },
      env(root, { scopedFiles }),
    ) ?? []) as {
      options?: unknown;
    }[];
    expect(task?.options).toEqual({ files: ["mod.py", "pkg/a.py"] });
    expect(
      vulture.buildArgs(ctx(root, { options: task?.options })).args,
    ).toEqual(["--", "mod.py", "pkg/a.py"]);
    writeFileSync(
      join(root, "pyproject.toml"),
      '[tool.vulture]\npaths = ["mod.py"]\n',
    );
    const [own] = (vulture.expand?.(
      { cwd: root },
      env(root, { scopedFiles }),
    ) ?? []) as {
      options?: unknown;
    }[];
    expect(
      vulture.buildArgs(ctx(root, { options: own?.options })).args,
    ).toEqual([]);
  });

  it("reads a dotfile whitelist git has, which the kit's scope leaves out", () => {
    const root = project("vk-vulture-", {
      "pyproject.toml": "[tool.vulture]\nmin_confidence = 60\n",
      "pkg/core.py": "def handler(): ...\n",
      ".vulture_whitelist.py": "handler\n",
      ".venv/lib/x.py": "y = 1\n",
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const [task] = (vulture.expand?.(
      { cwd: root },
      env(root, { scopedFiles: [`${root}/pkg/core.py`] }),
    ) ?? []) as { options?: unknown }[];
    expect(task?.options).toEqual({
      files: ["pkg/core.py", ".vulture_whitelist.py"],
    });
  });
});

describe("crosshair", () => {
  it("reports a counterexample as an error at the condition's line, and counts the conditions it could not finish", () => {
    const root = tmp("vk-ch-");
    const c = ctx(root, { options: { module: "mod" } });
    const over = crosshair.parseOutput(
      ran(
        1,
        `${root}/mod.py:4: error: false when calling double(7) (which returns 0)\n`,
      ),
      c,
    );
    expect(over.findings).toMatchObject([
      {
        file: `${root}/mod.py`,
        line: 4,
        severity: "error",
        message:
          "postcondition is false when calling double(7) (which returns 0): fix the code or the contract",
      },
    ]);
    const exc = crosshair.parseOutput(
      ran(
        1,
        `${root}/mod.py:5: error: ZeroDivisionError:  when calling inv(0)\n`,
      ),
      c,
    );
    expect(exc.findings[0]?.message).toBe(
      "ZeroDivisionError: when calling inv(0): fix the code or the contract",
    );
    // --report_all: a proven condition, and one out of time (exit 0 either
    // way; the second line recorded by the adapter's author on 0.0.111).
    const timed = crosshair.parseOutput(
      ran(
        0,
        `${root}/a.py:4: info: Confirmed over all paths.\n${root}/mod.py:6: info: Not confirmed.\n`,
      ),
      c,
    );
    expect(timed.findings).toMatchObject([
      {
        file: `${root}/mod.py`,
        line: 6,
        severity: "info",
        ruleId: "unfinished",
      },
    ]);
    expect(timed.findings[0]?.message).toMatch(
      /^CrossHair could not finish 1 condition in mod /,
    );
    expect(
      crosshair.parseOutput(
        ran(0, `${root}/a.py:4: info: Confirmed over all paths.\n`),
        c,
      ).findings,
    ).toEqual([]);
  });

  it("is a crash when a listed module has no contract to check", () => {
    const root = tmp("vk-ch-");
    expect(() =>
      crosshair.parseOutput(
        ran(
          0,
          "",
          "WARNING: Targets found, but contain no checkable functions.\n",
        ),
        ctx(root, { options: { module: "mod" } }),
      ),
    ).toThrow(/no function with a contract in mod/);
  });

  it("runs only when enabled with modules, one task per module, and in a changed run only for a Python change", () => {
    const root = tmp("vk-ch-");
    const seed = { cwd: root };
    const on = (options: unknown, more: Partial<PlanEnv> = {}) =>
      env(root, {
        toolConfig: { enabled: true },
        config: {
          ignore: [],
          tools: { crosshair: { enabled: true, options } },
        },
        ...more,
      } as Partial<PlanEnv>);
    expect(crosshair.expand?.(seed, env(root))).toEqual([]);
    expect(() => crosshair.expand?.(seed, on({}))).toThrow(
      /tools\.crosshair\.options\.modules/,
    );
    expect(crosshair.expand?.(seed, on({ modules: ["a", "b.c"] }))).toEqual([
      { cwd: root, options: { module: "a" } },
      { cwd: root, options: { module: "b.c" } },
    ]);
    expect(
      crosshair.expand?.(
        seed,
        on({ modules: ["a"] }, { changedPaths: ["README.md"] }),
      ),
    ).toEqual([]);
    // Modules and their .venv in a folder of their own.
    mkdirSync(join(root, "backend"));
    expect(
      crosshair.expand?.(seed, on({ modules: ["a"], root: "backend" })),
    ).toEqual([{ cwd: `${root}/backend`, options: { module: "a" } }]);
    expect(() =>
      crosshair.expand?.(seed, on({ modules: ["a"], root: "nope" })),
    ).toThrow(/options\.root: nope is not a folder/);
    expect(
      crosshair.buildArgs(ctx(root, { options: { module: "a" } })).args,
    ).toEqual(["check", "--report_all", "--per_condition_timeout", "10", "a"]);
  });
});
