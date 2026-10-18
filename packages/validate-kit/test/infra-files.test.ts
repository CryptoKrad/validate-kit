import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hadolint } from "../src/adapters/hadolint.js";
import { lsLint } from "../src/adapters/ls-lint.js";
import { lychee } from "../src/adapters/lychee.js";
import { markdownlint } from "../src/adapters/markdownlint.js";
import { reuse } from "../src/adapters/reuse.js";
import { taplo } from "../src/adapters/taplo.js";
import { yamllint } from "../src/adapters/yamllint.js";
import { resolveConfig } from "../src/config/resolve.js";
import { buildPlan } from "../src/core/plan.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolContext,
} from "../src/core/types.js";
import { detectFromFiles, toPosix } from "../src/detect/languages.js";

// Every output below was captured from a real run on 2026-10-18 (hadolint
// 2.15.1, taplo 0.10.0, yamllint 1.38.0, markdownlint-cli2 0.23.3, lychee
// 0.24.2, ls-lint 2.3.1, reuse 6.2.0) against a fixture with the problem
// planted, then trimmed; the recording folder's path is `<ASSETS>`
// (docs/research/lint-toolchain/sota-2026-10-18/infra-files.md and its
// assets).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-infra-scratch-");
  return { cwd, fix: false, extraArgs: [], tempDir: () => scratch, ...extra };
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
    config: { ignore: [] },
    ...more,
  } as unknown as PlanEnv;
}

/** `files` (relative to `root`) written, each with `text`. */
function write(root: string, files: Record<string, string>): string[] {
  return Object.entries(files).map(([name, text]) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
    return `${root}/${name}`;
  });
}

describe("hadolint", () => {
  it("reports each finding at its line, info (ShellCheck on RUN) as a warning and style as info", () => {
    const root = tmp("vk-hadolint-");
    const stdout = JSON.stringify([
      ...(JSON.parse(
        '[{"code":"DL3018","column":1,"file":"Dockerfile","level":"warning","line":2,"message":"Pin versions in apk add. Instead of `apk add <package>` use `apk add <package>=<version>`"},{"code":"DL3019","column":1,"file":"Dockerfile","level":"info","line":2,"message":"Use the `--no-cache` switch to avoid the need to use `--update` and remove `/var/cache/apk/*` when done installing packages"}]',
      ) as unknown[]),
      ...(JSON.parse(
        '[{"code":"SC2086","column":1,"file":"Dockerfile","level":"info","line":2,"message":"Double quote to prevent globbing and word splitting."}]',
      ) as unknown[]),
      {
        code: "DL3006",
        column: 1,
        file: "Dockerfile",
        level: "style",
        line: 1,
        message: "Always tag the version of an image explicitly",
      },
    ]);
    const { findings } = hadolint.parseOutput(ran(1, stdout), ctx(root));
    expect(findings.map((f) => [f.ruleId, f.line, f.col, f.severity])).toEqual([
      ["DL3018", 2, 1, "warning"],
      ["DL3019", 2, 1, "warning"],
      ["SC2086", 2, 1, "warning"],
      ["DL3006", 1, 1, "info"],
    ]);
    expect(findings[0]).toMatchObject({
      file: `${root}/Dockerfile`,
      url: "https://github.com/hadolint/hadolint/wiki/DL3018",
    });
    expect(findings[2]?.url).toBe("https://www.shellcheck.net/wiki/SC2086");
    expect(hadolint.parseOutput(ran(0, "[]"), ctx(root)).findings).toEqual([]);
    // Below the config's failure-threshold, a finding is info.
    write(root, { ".hadolint.yaml": "failure-threshold: error\n" });
    expect(
      hadolint
        .parseOutput(ran(0, stdout), ctx(root))
        .findings.map((f) => f.severity),
    ).toEqual(["info", "info", "info", "info"]);
  });

  it("is a crash when it exits 1 with nothing on stdout (a missing file or config) or prints an unknown level", () => {
    const root = tmp("vk-hadolint-");
    const stderr =
      "hadolint: Uncaught exception ghc-internal:GHC.Internal.IO.Exception.IOException:\n\nNope: withBinaryFile: does not exist (No such file or directory)\n\nHasCallStack backtrace:\n";
    expect(() => hadolint.parseOutput(ran(1, "", stderr), ctx(root))).toThrow(
      "hadolint could not run: Nope: withBinaryFile: does not exist (No such file or directory)",
    );
    expect(() =>
      hadolint.parseOutput(
        ran(
          1,
          '[{"code":"DL1","column":1,"file":"Dockerfile","level":"fatal","line":1,"message":"x"}]',
        ),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
    // A config it cannot parse is a line on stderr and a clean run.
    expect(() =>
      hadolint.parseOutput(
        ran(
          0,
          "[]",
          "\"Error parsing your config file in  '.hadolint.yaml':\n",
        ),
        ctx(root),
      ),
    ).toThrow(/could not read its config/);
    // A key it does not know, it skips without a word.
    write(root, { ".hadolint.yaml": "ignore: [DL3018]\n" });
    expect(() => hadolint.parseOutput(ran(0, "[]"), ctx(root))).toThrow(
      /the key "ignore"/,
    );
  });

  it("runs wherever a Dockerfile is in scope, from the folder of its nearest .hadolint.yaml, named", async () => {
    const root = tmp("vk-hadolint-");
    const files = write(root, {
      Dockerfile: "FROM alpine\n",
      "web/Containerfile.dev": "FROM alpine\n",
      "README.md": "# x\n",
    });
    const { config } = await resolveConfig(root);
    const tasks = await buildPlan(
      detectFromFiles(root, files),
      config,
      root,
      [hadolint, markdownlint],
      { scopedFiles: files },
    );
    // markdownlint-cli2 has no config here: it is not planned.
    expect(tasks.map((t) => [t.adapter.id, t.files])).toEqual([
      ["hadolint", [`${root}/Dockerfile`, `${root}/web/Containerfile.dev`]],
    ]);
    writeFileSync(join(root, ".hadolint.yaml"), "ignored: [DL3018]\n");
    const built = hadolint.buildArgs(ctx(root, { files: [files[0] ?? ""] }));
    expect(built.args).toEqual([
      "--format",
      "json",
      "--config",
      join(root, ".hadolint.yaml"),
      `${root}/Dockerfile`,
    ]);
    // A nested config's folder runs the files under it, with that config.
    write(root, { "web/.hadolint.yaml": "failure-threshold: error\n" });
    expect(
      hadolint.expand?.({ cwd: root, files: files.slice(0, 2) }, env(root)),
    ).toEqual([
      { cwd: root, files: [`${root}/Dockerfile`] },
      { cwd: `${root}/web`, files: [`${root}/web/Containerfile.dev`] },
    ]);
  });
});

describe("taplo", () => {
  it("reports an unformatted file at line 1 (fixable) and a syntax error where it stops, in the kit's spelling of the folder", () => {
    const root = tmp("vk-taplo-");
    // taplo prints the real path (/private/var for /var on macOS).
    const real = toPosix(realpathSync(root));
    const stderr = [
      `ERROR the file is not properly formatted path="${real}/fixture/unformatted.toml"`,
      "error: invalid TOML",
      `  ┌─ ${real}/fixture/syntax.toml:1:9`,
      "  │  ",
      "1 │   [package",
      "  │ ╭────────^",
      '2 │ │ name = "x"',
      '  │ ╰^ expected "]"',
      "",
      "ERROR operation failed error=some files were not formatted due to syntax errors",
      "",
    ].join("\n");
    const { findings } = taplo.parseOutput(ran(1, "", stderr), ctx(root));
    expect(
      findings.map((f) => [
        f.file,
        f.line,
        f.col,
        f.severity,
        f.message,
        f.fixable,
      ]),
    ).toEqual([
      [
        `${root}/fixture/unformatted.toml`,
        1,
        1,
        "warning",
        "File is not taplo-formatted",
        true,
      ],
      [
        `${root}/fixture/syntax.toml`,
        1,
        9,
        "error",
        'invalid TOML: expected "]"',
        false,
      ],
    ]);
    // A failure it does not name, a config it skips, a file it skips.
    expect(() =>
      taplo.parseOutput(
        ran(1, "", "ERROR operation failed error=x\n"),
        ctx(root),
      ),
    ).toThrow("taplo could not run: x");
    write(root, { "latin.toml": "k = 1\n" });
    writeFileSync(join(root, "latin.toml"), Buffer.from([0x6b, 0x3d, 0xff]));
    expect(
      taplo
        .parseOutput(ran(0), ctx(root, { files: [`${root}/latin.toml`] }))
        .findings.map((f) => [f.file, f.ruleId]),
    ).toEqual([[`${root}/latin.toml`, "syntax"]]);
    write(root, { ".taplo.toml": "[formatting\n" });
    expect(() => taplo.parseOutput(ran(0), ctx(root))).toThrow(
      /config .*\.taplo\.toml is not valid TOML/,
    );
    expect(taplo.findingExitCodes).toContain(1);
  });

  it("runs each existing file from the folder of its nearest taplo config, or not at all", () => {
    const root = tmp("vk-taplo-");
    const files = write(root, {
      "a.toml": "a = 1\n",
      "sub/b.toml": "b = 1\n",
    });
    const seed: TaskSeed = {
      cwd: root,
      files: [...files, `${root}/gone.toml`],
    };
    expect(taplo.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(join(root, "sub", ".taplo.toml"), "");
    expect(taplo.expand?.(seed, env(root))).toEqual([
      { cwd: `${root}/sub`, files: [`${root}/sub/b.toml`] },
    ]);
    expect(
      taplo.expand?.(seed, env(root, { toolConfig: { enabled: true } })),
    ).toEqual([
      { cwd: root, files: [`${root}/a.toml`] },
      { cwd: `${root}/sub`, files: [`${root}/sub/b.toml`] },
    ]);
    const check = taplo.buildArgs(
      ctx(`${root}/sub`, { files: [`${root}/sub/b.toml`] }),
    );
    expect(check.args).toEqual([
      "fmt",
      "--check",
      "--colors",
      "never",
      "--",
      "b.toml",
    ]);
    const fix = taplo.buildArgs(
      ctx(`${root}/sub`, { fix: true, files: [`${root}/sub/b.toml`] }),
    );
    expect(fix.args).not.toContain("--check");
  });
});

describe("yamllint", () => {
  it("reports each parsable problem at its position, errors as errors and warnings as info (yamllint passes on them)", () => {
    const root = tmp("vk-yamllint-");
    const stdout = [
      'bad.yaml:1:1: [warning] missing document start "---" (document-start)',
      "bad.yaml:4:6: [error] too many spaces after hyphen (hyphens)",
      'bad.yaml:5:1: [error] duplication of key "key" in mapping (key-duplicates)',
      "syntax.yaml:3:1: [error] syntax error: expected ',' or ']', but got '<stream end>' (syntax)",
      "",
    ].join("\n");
    const { findings } = yamllint.parseOutput(ran(1, stdout), ctx(root));
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["bad.yaml", 1, 1, "document-start", "info"],
      ["bad.yaml", 4, 6, "hyphens", "error"],
      ["bad.yaml", 5, 1, "key-duplicates", "error"],
      ["syntax.yaml", 3, 1, "syntax", "error"],
    ]);
    expect(findings[1]?.message).toBe("too many spaces after hyphen");
  });

  it("is a crash on a config it cannot read (exit 1, a traceback, no problem) or a line it cannot read", () => {
    const root = tmp("vk-yamllint-");
    const traceback =
      "Traceback (most recent call last):\n  File \"/opt/homebrew/bin/yamllint\", line 6, in <module>\n    sys.exit(run())\nFileNotFoundError: [Errno 2] No such file or directory: 'nope.yml'\n";
    expect(() =>
      yamllint.parseOutput(ran(1, "", traceback), ctx(root)),
    ).toThrow(
      "yamllint could not run: FileNotFoundError: [Errno 2] No such file or directory: 'nope.yml'",
    );
    expect(() =>
      yamllint.parseOutput(ran(1, "bad.yaml: something else\n"), ctx(root)),
    ).toThrow(/output format may have changed/);
    // A file it cannot decode, while another file's problems print.
    expect(() =>
      yamllint.parseOutput(
        ran(
          1,
          "a.yaml:1:1: [error] syntax error (syntax)\n",
          "Traceback (most recent call last):\nUnicodeDecodeError: 'utf-8' codec can't decode byte 0xff\n",
        ),
        ctx(root),
      ),
    ).toThrow(/UnicodeDecodeError/);
    // Exit 1 is for errors: warnings alone do not explain it.
    expect(() =>
      yamllint.parseOutput(
        ran(
          1,
          'a.yaml:1:1: [warning] missing document start "---" (document-start)\n',
        ),
        ctx(root),
      ),
    ).toThrow(/yamllint could not run/);
  });

  it("runs only where a yamllint config reaches the file, from that config's folder", () => {
    const root = tmp("vk-yamllint-");
    const files = write(root, { "a.yaml": "a: 1\n", "ci/b.yml": "b: 1\n" });
    const seed: TaskSeed = { cwd: root, files };
    expect(yamllint.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(join(root, ".yamllint.yml"), "extends: default\n");
    expect(yamllint.expand?.(seed, env(root))).toEqual([{ cwd: root, files }]);
    expect(
      yamllint.buildArgs(ctx(root, { files: [`${root}/ci/b.yml`] })).args,
    ).toEqual(["-f", "parsable", "--", "ci/b.yml"]);
  });
});

/** The banner and summary markdownlint-cli2 prints on stdout. */
function banner(summary: string): string {
  return `markdownlint-cli2 v0.23.3 (markdownlint v0.41.1)\nFinding: :bad.md\nLinting: 1 file\nSummary: ${summary}\n`;
}

describe("markdownlint-cli2", () => {
  it("reports each problem on stderr at its line (and column, when it has one), checked against the summary", () => {
    const root = tmp("vk-mdl-");
    const stderr = [
      "bad.md:5 error MD012/no-multiple-blanks Multiple consecutive blank lines [Expected: 1; Actual: 2]",
      "bad.md:6 error MD012/no-multiple-blanks Multiple consecutive blank lines [Expected: 1; Actual: 3]",
      'c.md:3:7 warning MD037/no-space-in-emphasis Spaces inside emphasis markers [Context: "x *"]',
      "",
    ].join("\n");
    const { findings } = markdownlint.parseOutput(
      ran(1, banner("3 issues in 2 files"), stderr),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["bad.md", 5, 1, "MD012", "error"],
      ["bad.md", 6, 1, "MD012", "error"],
      ["c.md", 3, 7, "MD037", "warning"],
    ]);
    expect(findings[0]).toMatchObject({
      message: "Multiple consecutive blank lines [Expected: 1; Actual: 2]",
      url: "https://github.com/DavidAnson/markdownlint/blob/main/doc/md012.md",
    });
    expect(
      markdownlint.parseOutput(ran(0, banner("0 issues in 0 files")), ctx(root))
        .findings,
    ).toEqual([]);
  });

  it("is a crash when the problems it printed do not add up to its summary, or a failed run printed none", () => {
    const root = tmp("vk-mdl-");
    expect(() =>
      markdownlint.parseOutput(
        ran(1, banner("2 issues in 1 file"), "bad.md:5 MD012 changed\n"),
        ctx(root),
      ),
    ).toThrow(/counted 2 issues but printed 0/);
    // `noProgress` drops the summary: exit 0 is a pass, exit 1 needs problems.
    expect(markdownlint.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
    expect(() => markdownlint.parseOutput(ran(1, "", ""), ctx(root))).toThrow(
      /no summary .*outputFormatters/,
    );
  });

  it("runs from the project root on the existing files a config reaches, as literal paths", () => {
    const root = tmp("vk-mdl-");
    const files = write(root, { "a.md": "# a\n", "docs/b.md": "# b\n" });
    const seed: TaskSeed = { cwd: root, files: [...files, `${root}/gone.md`] };
    expect(markdownlint.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(join(root, "docs", ".markdownlint.yaml"), "MD013: false\n");
    expect(markdownlint.expand?.(seed, env(root))).toEqual([
      { cwd: root, files: [`${root}/docs/b.md`] },
    ]);
    expect(
      markdownlint.buildArgs(
        ctx(root, { fix: true, files: [`${root}/docs/b.md`] }),
      ).args,
    ).toEqual(["--no-globs", "--fix", ":docs/b.md"]);
  });
});

/** lychee finding-json.stdout, durations and empty maps trimmed. */
function report(real: string): string {
  return JSON.stringify({
    total: 5,
    successful: 1,
    excludes: 1,
    errors: 3,
    error_map: {
      "README.md": [
        {
          url: `file://${real}/README.md#nope`,
          status: {
            text: "Cannot find fragment",
            details: "Cannot find fragment",
          },
          span: { line: 5, column: 79 },
        },
        {
          url: `file://${real}/docs/missing.md`,
          status: {
            text: "File not found. Check if file exists and path is correct",
            details: "File not found. Check if file exists and path is correct",
          },
          span: { line: 5, column: 1 },
        },
        {
          url: `file://${real}/docs/other.md#no-such-heading`,
          status: {
            text: "Cannot find fragment",
            details: "Cannot find fragment",
          },
          span: { line: 5, column: 34 },
        },
      ],
    },
    excluded_map: {
      "README.md": [
        {
          url: "http://127.0.0.1:8766/web",
          status: { text: "Excluded" },
          span: { line: 5, column: 98 },
        },
      ],
    },
  });
}

describe("lychee", () => {
  it("reports each broken link or anchor at its place in the document, naming the target", () => {
    const root = tmp("vk-lychee-");
    const real = toPosix(realpathSync(root));
    const { findings } = lychee.parseOutput(
      ran(2, report(real)),
      ctx(root, { options: { files: ["README.md"] } }),
    );
    expect(
      findings.map((f) => [f.file, f.line, f.col, f.severity, f.message]),
    ).toEqual([
      [
        `${root}/README.md`,
        5,
        79,
        "error",
        "broken link to README.md#nope: Cannot find fragment",
      ],
      [
        `${root}/README.md`,
        5,
        1,
        "error",
        "broken link to docs/missing.md: File not found. Check if file exists and path is correct",
      ],
      [
        `${root}/README.md`,
        5,
        34,
        "error",
        "broken link to docs/other.md#no-such-heading: Cannot find fragment",
      ],
    ]);
  });

  it("is a crash when the error count and the listed links differ, or a usage error prints no report", () => {
    const root = tmp("vk-lychee-");
    const options = { options: { files: ["README.md"] } };
    const short = JSON.parse(report(root)) as { errors: number };
    short.errors = 4;
    expect(() =>
      lychee.parseOutput(ran(2, JSON.stringify(short)), ctx(root, options)),
    ).toThrow(/counted 4 failed links but listed 3/);
    expect(() =>
      lychee.parseOutput(
        ran(2, "", "error: unexpected argument '--bogus' found\n"),
        ctx(root, options),
      ),
    ).toThrow(/unexpected argument '--bogus'/);
  });

  it("runs offline where lychee.toml is, on every document, and in a changed run only when a link can have broken", () => {
    const root = tmp("vk-lychee-");
    const scopedFiles = write(root, {
      "README.md": "[a](docs/a.md)\n",
      "docs/a.md": "# A\n",
      "site/index.html": "<a href='x.html'>x</a>\n",
      "src/a.ts": "export {};\n",
    });
    const seed: TaskSeed = { cwd: root };
    expect(lychee.expand?.(seed, env(root, { scopedFiles }))).toEqual([]);
    writeFileSync(join(root, "lychee.toml"), "");
    expect(lychee.expand?.(seed, env(root, { scopedFiles }))).toEqual([
      {
        cwd: root,
        options: { files: ["README.md", "docs/a.md", "site/index.html"] },
      },
    ]);
    expect(
      lychee.expand?.(
        seed,
        env(root, { scopedFiles, changedPaths: ["src/a.ts"] }),
      ),
    ).toEqual([]);
    expect(
      lychee.expand?.(
        seed,
        env(root, { scopedFiles, changedPaths: ["docs/moved.md"] }),
      ),
    ).toHaveLength(1);
    const built = lychee.buildArgs(
      ctx(root, { options: { files: ["README.md"] } }),
    );
    expect(built.args.slice(0, 7)).toEqual([
      "--offline",
      "--no-progress",
      "--include-fragments",
      "--format",
      "json",
      "--cache=false",
      "--files-from",
    ]);
    expect(readFileSync(built.args[7] ?? "", "utf8")).toBe("README.md\n");
  });
});

describe("ls-lint", () => {
  it("reports each file or folder whose name breaks a rule, only for the paths it was given", () => {
    const root = tmp("vk-ls-lint-");
    const stderr =
      '{"src/BadName.ts":{".ts":["kebabcase"]},"Bad_Dir":{".dir":["kebabcase"]},"node_modules/X_Y":{".dir":["kebabcase"]},"fixtures/Bad.ts":{".ts":["kebabcase"]}}\n';
    const { findings } = lsLint.parseOutput(
      ran(1, "", stderr),
      ctx(root, { options: { keep: ["src/BadName.ts", "src", "Bad_Dir"] } }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
        f.message,
      ]),
    ).toEqual([
      [
        "src/BadName.ts",
        1,
        "kebabcase",
        "error",
        "the .ts file name breaks .ls-lint.yml (kebabcase): rename it, or add it to the config's ignore list",
      ],
      [
        "Bad_Dir",
        1,
        "kebabcase",
        "error",
        "the folder name breaks .ls-lint.yml (kebabcase): rename it, or add it to the config's ignore list",
      ],
    ]);
    expect(lsLint.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
  });

  it("is a crash when it exits 1 with no report (a missing config) or an empty one", () => {
    const root = tmp("vk-ls-lint-");
    expect(() =>
      lsLint.parseOutput(
        ran(
          1,
          "",
          "2026/10/18 01:20:34 open .ls-lint.yml: no such file or directory\n",
        ),
        ctx(root),
      ),
    ).toThrow(
      "ls-lint could not run: 2026/10/18 01:20:34 open .ls-lint.yml: no such file or directory",
    );
    expect(() => lsLint.parseOutput(ran(1, "", "{}\n"), ctx(root))).toThrow(
      /output format may have changed/,
    );
    // A config with no `ls` rules checks nothing.
    write(root, { ".ls-lint.yml": "lss:\n  .ts: kebab-case\n" });
    expect(() => lsLint.parseOutput(ran(0), ctx(root))).toThrow(
      /no `ls` mapping/,
    );
  });

  it("runs where .ls-lint.yml is at the project root, on the scope or the changed files and their folders", () => {
    const root = tmp("vk-ls-lint-");
    const seed: TaskSeed = { cwd: root };
    const scopedFiles = [`${root}/a/b/c.ts`, `${root}/d.ts`];
    expect(lsLint.expand?.(seed, env(root, { scopedFiles }))).toEqual([]);
    writeFileSync(join(root, ".ls-lint.yml"), "ls:\n  .ts: kebab-case\n");
    expect(lsLint.expand?.(seed, env(root, { scopedFiles }))).toEqual([
      { cwd: root, options: { keep: ["a/b/c.ts", "d.ts", "a/b", "a"] } },
    ]);
    expect(
      lsLint.expand?.(seed, env(root, { scopedFiles, changedPaths: ["d.ts"] })),
    ).toEqual([{ cwd: root, options: { keep: ["d.ts"] } }]);
    expect(
      lsLint.expand?.(seed, env(root, { scopedFiles, changedPaths: [] })),
    ).toEqual([]);
    expect(lsLint.buildArgs(ctx(root)).args).toEqual([
      "-error-output-format",
      "json",
    ]);
  });
});

/** reuse finding-json.stdout and its twins, the parts the kit reads. */
function lint(
  problems: Record<string, string[]>,
  files: unknown[] = [],
): string {
  return JSON.stringify({
    lint_version: "1.0",
    reuse_spec_version: "3.3",
    reuse_tool_version: "6.2.0",
    files,
    non_compliant: {
      bad_licenses: [],
      deprecated_licenses: [],
      licenses_without_extension: [],
      missing_licenses: [],
      unused_licenses: [],
      read_errors: [],
      missing_copyright_info: [],
      missing_licensing_info: [],
      ...problems,
    },
    summary: { compliant: false },
  });
}

describe("reuse", () => {
  it("reports each file without a copyright notice or licence, and each licence text missing or unused", () => {
    const root = tmp("vk-reuse-");
    write(root, { "LICENSES/MIT.txt": "MIT\n" });
    const keep = ["bad.py", "a.py", "dep.py", "LICENSES/MIT.txt"];
    const found = (stdout: string) =>
      reuse
        .parseOutput(ran(1, stdout), ctx(root, { options: { keep } }))
        .findings.map((f) => [f.file.slice(root.length + 1), f.ruleId]);
    expect(
      found(
        lint({
          missing_copyright_info: ["bad.py"],
          missing_licensing_info: ["bad.py"],
        }),
      ),
    ).toEqual([
      ["bad.py", "missing-copyright"],
      ["bad.py", "missing-licence"],
    ]);
    // Under an absolute --root its lists hold absolute paths.
    expect(found(lint({ missing_copyright_info: [`${root}/bad.py`] }))).toEqual(
      [["bad.py", "missing-copyright"]],
    );
    // A missing text at each file that uses it, else where it would be.
    expect(
      found(
        lint({ missing_licenses: ["Apache-2.0"] }, [
          {
            path: "dep.py",
            spdx_expressions: [
              {
                value: "(MIT OR Apache-2.0)",
                is_valid: true,
                source: "dep.py",
              },
            ],
          },
        ]),
      ),
    ).toEqual([["dep.py", "missing-licence-text"]]);
    expect(found(lint({ missing_licenses: ["Apache-2.0"] }))).toEqual([
      ["LICENSES/Apache-2.0.txt", "missing-licence-text"],
    ]);
    // bad-spdx-json: an expression that does not parse, and MIT unused.
    expect(
      found(
        lint({ unused_licenses: ["MIT"], missing_licensing_info: ["a.py"] }, [
          {
            path: "a.py",
            spdx_expressions: [
              { value: "MIT AND", is_valid: false, source: "a.py" },
            ],
          },
        ]),
      ),
    ).toEqual([
      ["a.py", "invalid-spdx"],
      ["LICENSES/MIT.txt", "unused-licence"],
    ]);
    expect(reuse.parseOutput(ran(0, lint({})), ctx(root)).findings).toEqual([]);
  });

  it("is a crash when its exit and its report disagree, or the report lacks its lists", () => {
    const root = tmp("vk-reuse-");
    expect(() => reuse.parseOutput(ran(1, lint({})), ctx(root))).toThrow(
      /exited 1 with no problems/,
    );
    expect(() =>
      reuse.parseOutput(ran(1, '{"non_compliant": {}}'), ctx(root)),
    ).toThrow(/output format may have changed/);
  });

  it("runs where the project adopted REUSE, always confined to the project root", () => {
    const root = tmp("vk-reuse-");
    const seed: TaskSeed = { cwd: root };
    const scopedFiles = [`${root}/a.py`, `${root}/b.py`];
    // LICENSES/ alone is not REUSE: projects keep vendor notices there.
    mkdirSync(join(root, "LICENSES"));
    expect(reuse.expand?.(seed, env(root, { scopedFiles }))).toEqual([]);
    writeFileSync(join(root, "REUSE.toml"), "version = 1\n");
    expect(reuse.expand?.(seed, env(root, { scopedFiles }))).toEqual([
      { cwd: root, options: { keep: ["a.py", "b.py"] } },
    ]);
    // A changed run counts the changed files, or all when REUSE.toml changed.
    expect(
      reuse.expand?.(seed, env(root, { scopedFiles, changedPaths: ["b.py"] })),
    ).toEqual([{ cwd: root, options: { keep: ["b.py"] } }]);
    expect(
      reuse.expand?.(
        seed,
        env(root, { scopedFiles, changedPaths: ["REUSE.toml"] }),
      ),
    ).toEqual([{ cwd: root, options: { keep: ["a.py", "b.py"] } }]);
    expect(reuse.buildArgs(ctx(root)).args).toEqual([
      "--root",
      root,
      "lint",
      "--json",
    ]);
    expect(reuse.tier).toBe("verify");
  });
});
