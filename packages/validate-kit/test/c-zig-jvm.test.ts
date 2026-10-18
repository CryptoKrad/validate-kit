import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clangFormat } from "../src/adapters/clang-format.js";
import { clangTidy } from "../src/adapters/clang-tidy.js";
import { cppcheck } from "../src/adapters/cppcheck.js";
import { detekt } from "../src/adapters/detekt.js";
import { googleJavaFormat } from "../src/adapters/google-java-format.js";
import { ktlint } from "../src/adapters/ktlint.js";
import { pmd } from "../src/adapters/pmd.js";
import { scalafmt } from "../src/adapters/scalafmt.js";
import { zigAstCheck, zigFmt } from "../src/adapters/zig.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// Every output below was captured from a real run on 2026-10-18 against a
// fixture with one problem planted, then trimmed
// (docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md; the bytes in
// its assets folder, clang-format, zig and google-java-format re-recorded
// with their record.sh, whose out/ is not committed).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-czj-scratch-");
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
    config: { ignore: [], tools: {}, languages: { kotlin: {} } },
    ...more,
  } as unknown as PlanEnv;
}

/** Write `files` (path → text) under `root`. */
function plant(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

async function expand(
  adapter: ToolAdapter,
  seed: TaskSeed,
  planEnv: PlanEnv,
): Promise<TaskSeed[]> {
  return (await adapter.expand?.(seed, planEnv)) ?? [];
}

const where = (
  findings: { file: string; line: number; col: number }[],
  root: string,
) => findings.map((f) => `${f.file.slice(root.length + 1)}:${f.line}:${f.col}`);

describe("clang-format", () => {
  // out/finding: one diagnostic per replacement, all in one file.
  const FINDING = `src/bad.c:1:11: error: code should be clang-formatted [-Wclang-format-violations]
int main(){
          ^
src/bad.c:1:12: error: code should be clang-formatted [-Wclang-format-violations]
int main(){
           ^
src/bad.c:2:7: error: code should be clang-formatted [-Wclang-format-violations]
return   0;
      ^
`;

  it("reports one finding per file, at its first difference; a missing file is a crash", () => {
    const root = tmp("vk-cf-");
    const { findings } = clangFormat.parseOutput(
      ran(1, "", FINDING),
      ctx(root),
    );
    expect(where(findings, root)).toEqual(["src/bad.c:1:11"]);
    expect(findings[0]).toMatchObject({ language: "c", fixable: true });
    expect(() =>
      clangFormat.parseOutput(
        ran(1, "", "src/nope.c: No such file or directory\n"),
        ctx(root),
      ),
    ).toThrow(/src\/nope.c: No such file or directory/);
    // The reviewer's cf1: a config clang-format cannot read, beside another
    // file's finding; that folder's files were never checked.
    expect(() =>
      clangFormat.parseOutput(
        ran(
          1,
          "",
          `${FINDING}${root}/sub/.clang-format:1:1: error: Unknown value for BasedOnStyle: Nope\nBasedOnStyle: Nope\n^\nError reading ${root}/sub/.clang-format: Invalid argument\n`,
        ),
        ctx(root),
      ),
    ).toThrow(/did not check every file: .*Unknown value for BasedOnStyle/);
  });

  it("checks only the files a .clang-format reaches, unless enabled", async () => {
    const root = tmp("vk-cf-");
    plant(root, { "lib/.clang-format": "IndentWidth: 4\n" });
    const seed = { cwd: root, files: [`${root}/lib/a/x.c`, `${root}/app/y.c`] };
    expect((await expand(clangFormat, seed, env(root)))[0]?.files).toEqual([
      `${root}/lib/a/x.c`,
    ]);
    expect(
      (
        await expand(
          clangFormat,
          seed,
          env(root, { toolConfig: { enabled: true } }),
        )
      )[0]?.files,
    ).toHaveLength(2);
    expect(
      clangFormat.buildArgs(ctx(root, { files: [`${root}/x.c`] })).args,
    ).toEqual(["--dry-run", "--Werror", "--style=file", `${root}/x.c`]);
  });
});

describe("clang-tidy", () => {
  // out/two-files plus out/finding-warnings-as-errors and out/syntax-error.
  const STDOUT = `src/bad.c:2:3: error: if with identical then and else branches [bugprone-branch-clone,-warnings-as-errors]
    2 |   if (x > 0) {
      |   ^
src/bad.c:4:5: note: else branch starts here
    4 |   } else {
      |     ^
src/brace.c:2:9: warning: statement should be inside braces [readability-braces-around-statements]
    2 |   if (x) return 1;
      |         ^
      |          {
src/syntaxerr.c:1:13: error: expected ')' [clang-diagnostic-error]
    1 | int broken( { return 1 }
      |             ^
`;

  it("reads each diagnostic, skipping notes and excerpts, a path from its entry's folder", () => {
    const root = tmp("vk-ct-");
    const db = `${root}/build`;
    plant(root, {
      "build/compile_commands.json": "[]",
      "src/bad.c": "",
      "src/brace.c": "",
      "src/syntaxerr.c": "",
    });
    const stdout = STDOUT.replace(/^src\//gm, "../src/");
    const { findings } = clangTidy.parseOutput(
      ran(1, stdout),
      ctx(root, { options: { db, dirs: [db] } }),
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
      ["src/bad.c", 2, 3, "bugprone-branch-clone", "error"],
      ["src/brace.c", 2, 9, "readability-braces-around-statements", "warning"],
      ["src/syntaxerr.c", 1, 13, "clang-diagnostic-error", "error"],
    ]);
    expect(findings.map((f) => clangTidy.masks?.(f))).toEqual([
      false,
      false,
      true,
    ]);
    // out/no-checks-enabled: the usage on stdout, exit 1.
    expect(() =>
      clangTidy.parseOutput(
        ran(
          1,
          "USAGE: clang-tidy [options] <source0> [... <sourceN>]\n",
          "Error: no checks enabled.\n",
        ),
        ctx(root, { options: { db, dirs: [db] } }),
      ),
    ).toThrow(/no checks enabled/);
    // out/missing-file.
    expect(() =>
      clangTidy.parseOutput(
        ran(1, "error: no input files [clang-diagnostic-error]\n"),
        ctx(root, { options: { db, dirs: [db] } }),
      ),
    ).toThrow(/could not check a file: no input files/);
    // The reviewer's ct5: a nested .clang-tidy that does not parse, exit 0.
    expect(() =>
      clangTidy.parseOutput(
        ran(0, "", `Error parsing ${root}/sub/.clang-tidy: Invalid argument\n`),
        ctx(root, { options: { db, dirs: [db] } }),
      ),
    ).toThrow(/could not read a config: Error parsing/);
  });

  it("places a finding in the file of that name it checked (two a.c, one per folder)", async () => {
    const root = tmp("vk-ct-");
    plant(root, {
      ".clang-tidy": "Checks: '-*,bugprone-branch-clone'\n",
      "lib1/a.c": "",
      "lib2/a.c": "",
      "compile_commands.json": JSON.stringify([
        { directory: `${root}/lib1`, file: "a.c" },
        { directory: `${root}/lib2`, file: "a.c" },
      ]),
    });
    const [task] = await expand(
      clangTidy,
      { cwd: root, files: [`${root}/lib2/a.c`] },
      env(root),
    );
    const { findings } = clangTidy.parseOutput(
      ran(
        0,
        "a.c:2:3: warning: if with identical then and else branches [bugprone-branch-clone]\n",
      ),
      ctx(root, { files: task?.files ?? [], options: task?.options }),
    );
    expect(findings[0]?.file).toBe(`${root}/lib2/a.c`);
  });

  it("checks a changed header through the sources that include it, one run each", async () => {
    const root = tmp("vk-ct-");
    plant(root, {
      ".clang-tidy": "Checks: '-*,bugprone-branch-clone'\n",
      "include/h.h": "static inline int hb(int x) { return x; }\n",
      "include/wrap.h": '#include "h.h"\n',
      "include/lone.h": "int lone(void);\n",
      "src/a.c": '#include "wrap.h"\nint f(void) { return hb(1); }\n',
      "src/b.c": "int g(void) { return 2; }\n",
      "build/compile_commands.json": JSON.stringify([
        { directory: `${root}/build`, file: "../src/a.c" },
        { directory: `${root}/build`, file: "../src/b.c" },
      ]),
    });
    const tasks = await expand(
      clangTidy,
      {
        cwd: root,
        files: [`${root}/include/h.h`, `${root}/include/lone.h`],
      },
      env(root, {
        scopedFiles: [`${root}/include/h.h`, `${root}/include/wrap.h`],
      }),
    );
    // One no source includes is checked by itself.
    expect(tasks.map((t) => t.files)).toEqual([
      [`${root}/src/a.c`],
      [`${root}/include/lone.h`],
    ]);
  });

  it("runs where a .clang-tidy reaches a source, with the database; without one it cannot", async () => {
    const root = tmp("vk-ct-");
    plant(root, { ".clang-tidy": "Checks: '-*,bugprone-branch-clone'\n" });
    const seed = {
      cwd: `${root}/native/src`,
      files: [`${root}/native/src/a.c`],
    };
    const [lacking] = await expand(clangTidy, seed, env(root));
    expect(lacking?.cannotRun).toMatch(/no compile_commands.json/);
    // The reviewer's ct2: the C root is native/src, the database native/build.
    plant(root, { "native/build/compile_commands.json": "[]" });
    const [task] = await expand(clangTidy, seed, env(root));
    expect(task?.files).toEqual([`${root}/native/src/a.c`]);
    expect(task?.options).toMatchObject({ db: `${root}/native/build` });
    plant(root, { "out/debug/compile_commands.json": "[]" });
    const named = env(root, {
      config: {
        tools: { "clang-tidy": { options: { compileCommands: "out/debug" } } },
      },
    } as unknown as Partial<PlanEnv>);
    expect((await expand(clangTidy, seed, named))[0]?.options).toMatchObject({
      db: `${root}/out/debug`,
    });
    // A database whose folder is gone: clang-tidy would abort and hang.
    plant(root, {
      "native/build/compile_commands.json": JSON.stringify([
        { directory: `${root}/gone`, file: "a.c" },
      ]),
    });
    expect((await expand(clangTidy, seed, env(root)))[0]?.cannotRun).toMatch(
      /gone, which does not exist/,
    );
    const other = tmp("vk-ct-");
    expect(
      await expand(
        clangTidy,
        { cwd: other, files: [`${other}/a.c`] },
        env(other),
      ),
    ).toEqual([]);
    const args = clangTidy.buildArgs(
      ctx(root, {
        files: [`${root}/src/a.c`],
        options: { db: `${root}/build`, sdk: "/SDK" },
      }),
    ).args;
    expect(args).toEqual([
      "--quiet",
      "-p",
      `${root}/build`,
      "--extra-arg-before=-isysroot/SDK",
      `${root}/src/a.c`,
    ]);
  });
});

describe("cppcheck", () => {
  // out/finding-template, the template the kit passes.
  const STDERR =
    "src/bad.c\t5\t3\terror\tmemleak\t401\tMemory leak: p\n" +
    "src/bad.c\t4\t3\twarning\tnullPointerOutOfMemory\t476\tIf memory allocation fails, then there is a possible null pointer dereference: p\n" +
    "src/st.c\t1\t26\tstyle\tunreadVariable\t563\tVariable 'b' is assigned a value that is never used.\n";

  it("keeps cppcheck's severity, which its SARIF loses; another shape is a crash", () => {
    const root = tmp("vk-cc-");
    const { findings } = cppcheck.parseOutput(ran(3, "", STDERR), ctx(root));
    expect(findings.map((f) => [f.ruleId, f.line, f.col, f.severity])).toEqual([
      ["memleak", 5, 3, "error"],
      ["nullPointerOutOfMemory", 4, 3, "warning"],
      // Shown only under --enable=style, and then cppcheck's run fails.
      ["unreadVariable", 1, 26, "warning"],
    ]);
    expect(findings[0]?.file).toBe(`${root}/src/bad.c`);
    expect(() =>
      cppcheck.parseOutput(
        ran(3, "", "src/bad.c:5:3: error: Memory leak: p [memleak]\n"),
        ctx(root),
      ),
    ).toThrow(/not the kit's template/);
  });

  it("runs where chosen; database files through --project, the rest by name", async () => {
    const root = tmp("vk-cc-");
    const seed = {
      cwd: root,
      files: [`${root}/src/a.c`, `${root}/src/new.c`, `${root}/src/a.h`],
    };
    expect(await expand(cppcheck, seed, env(root))).toEqual([]);
    plant(root, {
      "build/compile_commands.json": JSON.stringify([
        { directory: `${root}/build`, file: "../src/a.c" },
      ]),
    });
    const tasks = await expand(
      cppcheck,
      seed,
      env(root, { toolConfig: { enabled: true } }),
    );
    expect(tasks.map((t) => [t.files, t.options])).toEqual([
      [[`${root}/src/a.c`], { db: `${root}/build` }],
      [[`${root}/src/new.c`, `${root}/src/a.h`], {}],
    ]);
    const args = cppcheck.buildArgs(
      ctx(root, { files: tasks[0]?.files ?? [], options: tasks[0]?.options }),
    ).args;
    expect(args.slice(-2)).toEqual([
      `--project=${root}/build/compile_commands.json`,
      `--file-filter=${root}/src/a.c`,
    ]);
    // The project's `// cppcheck-suppress` comments hold.
    expect(args).toContain("--inline-suppr");
    // cppcheck reads a cppcheck.cfg only from its own install folder.
    plant(root, { "cppcheck.cfg": "{}" });
    expect(await expand(cppcheck, seed, env(root))).toEqual([]);
    plant(root, { justfile: "lint:\n\tcppcheck src\n" });
    expect(await expand(cppcheck, seed, env(root))).toHaveLength(2);
  });
});

describe("zig", () => {
  it("zig fmt reports a file that differs, and as info one that does not parse (zig-ast-check gates on it); a missing file is a crash", () => {
    const root = tmp("vk-zig-");
    // out/fmt-finding-dir.
    const { findings } = zigFmt.parseOutput(
      ran(
        1,
        "src/bad.zig\n",
        "src/syntax.zig:2:15: error: expected expression, found ';'\n    const x = ;\n              ^\n",
      ),
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
      ["src/syntax.zig", 2, 15, "syntax-error", "info"],
      ["src/bad.zig", 1, 1, undefined, "warning"],
    ]);
    expect(() =>
      zigFmt.parseOutput(
        ran(1, "", 'error: formatting "src/nope.zig": FileNotFound\n'),
        ctx(root),
      ),
    ).toThrow(/FileNotFound/);
    expect(zigFmt.buildArgs(ctx(root, { files: ["a.zig"] })).args).toEqual([
      "fmt",
      "--check",
      "a.zig",
    ]);
  });

  it("zig ast-check runs once per file and reports its errors, not their notes", async () => {
    const root = tmp("vk-zig-");
    expect(
      (
        await expand(
          zigAstCheck,
          { cwd: root, files: ["a.zig", "b.zon"] },
          env(root),
        )
      ).map((s) => s.files),
    ).toEqual([["a.zig"], ["b.zon"]]);
    // out/astcheck-dup.
    const { findings } = zigAstCheck.parseOutput(
      ran(
        1,
        "",
        "src/dup.zig:3:11: error: redeclaration of local constant 'x'\n    const x = 2;\n          ^\nsrc/dup.zig:2:11: note: previous declaration here\n    const x = 1;\n          ^\n",
      ),
      ctx(root, { files: ["src/dup.zig"] }),
    );
    expect(findings.map((f) => [f.line, f.col, f.message])).toEqual([
      [3, 11, "redeclaration of local constant 'x'"],
    ]);
    expect(() =>
      zigAstCheck.parseOutput(
        ran(
          1,
          "",
          'error: unable to open file "src/nope.zig" for ast-check: FileNotFound\n',
        ),
        ctx(root),
      ),
    ).toThrow(/unable to open file/);
  });
});

describe("google-java-format", () => {
  it("lists each file that differs and reports a syntax error; a missing file is a crash", () => {
    const root = tmp("vk-gjf-");
    // out/finding and out/syntax-error.
    const { findings } = googleJavaFormat.parseOutput(
      ran(
        1,
        "src/Bad.java\nsrc/Imports.java\n",
        "src/Syn.java:2:11: error: illegal start of type\n  void f( {\n          ^\n",
      ),
      ctx(root),
    );
    expect(where(findings, root)).toEqual([
      "src/Syn.java:2:11",
      "src/Bad.java:1:1",
      "src/Imports.java:1:1",
    ]);
    expect(() =>
      googleJavaFormat.parseOutput(
        ran(1, "", "src/Nope.java: could not read file: src/Nope.java\n"),
        ctx(root),
      ),
    ).toThrow(/could not read file/);
    // Run here: it goes on to the other files, whose findings hid it.
    expect(() =>
      googleJavaFormat.parseOutput(
        ran(
          1,
          "src/Bad.java\n",
          "src/Nope.java: could not read file: src/Nope.java\n",
        ),
        ctx(root),
      ),
    ).toThrow(/did not check a file/);
  });

  it("runs only where chosen, in the configured style", async () => {
    const root = tmp("vk-gjf-");
    expect(googleJavaFormat.adoptedAt?.(root, root)).toBe(false);
    plant(root, {
      justfile: "fmt:\n\tgoogle-java-format --replace src/*.java\n",
    });
    expect(googleJavaFormat.adoptedAt?.(root, root)).toBe(true);
    const aosp = env(root, {
      config: {
        tools: { "google-java-format": { options: { style: "aosp" } } },
      },
    } as unknown as Partial<PlanEnv>);
    const [task] = await expand(
      googleJavaFormat,
      { cwd: root, files: ["A.java"] },
      aosp,
    );
    expect(
      googleJavaFormat.buildArgs(
        ctx(root, { files: ["A.java"], options: task?.options }),
      ).args,
    ).toEqual(["--dry-run", "--set-exit-if-changed", "--aosp", "A.java"]);
    const typo = env(root, {
      config: {
        tools: { "google-java-format": { options: { style: "android" } } },
      },
    } as unknown as Partial<PlanEnv>);
    await expect(
      expand(googleJavaFormat, { cwd: root, files: ["A.java"] }, typo),
    ).rejects.toThrow(/options.style/);
  });
});

describe("pmd", () => {
  // out/finding-json and out/parse-error, the detail trace cut.
  const FOUND = {
    formatVersion: 0,
    pmdVersion: "7.28.0",
    timestamp: "2026-10-18T01:21:02.807-07:00",
    files: [
      {
        filename: "src/Bad.java",
        violations: [
          {
            beginline: 3,
            begincolumn: 12,
            endline: 3,
            endcolumn: 13,
            description: "Avoid unused local variables such as 's'.",
            rule: "UnusedLocalVariable",
            ruleset: "Best Practices",
            priority: 3,
            externalInfoUrl:
              "https://docs.pmd-code.org/snapshot/pmd_rules_java_bestpractices.html#unusedlocalvariable",
          },
        ],
      },
    ],
    suppressedViolations: [],
    processingErrors: [
      {
        filename: "src/Syn.java",
        message:
          'ParseException: Parse exception in file \'src/Syn.java\' at line 2, column 11: Encountered "{".\nWas expecting:\n    ")" ...',
        detail: "net.sourceforge.pmd.lang.ast.ParseException: ...",
      },
    ],
    configurationErrors: [],
  };

  it("reports each violation and each file it could not parse; another shape is a crash", () => {
    const root = tmp("vk-pmd-");
    const { findings } = pmd.parseOutput(
      ran(4, JSON.stringify(FOUND)),
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
      ["src/Bad.java", 3, 12, "UnusedLocalVariable", "warning"],
      ["src/Syn.java", 2, 11, "processing-error", "error"],
    ]);
    expect(findings[1]?.message).toBe(
      "PMD could not check this file: ParseException: Parse exception in file 'src/Syn.java' at line 2, column 11: Encountered \"{\".",
    );
    expect(() =>
      pmd.parseOutput(
        ran(4, JSON.stringify({ ...FOUND, files: null })),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
    // The reviewer's pmd2: `Removed misconfigured rule: NoFoo`, exit 0.
    const dropped = {
      ...FOUND,
      files: [],
      processingErrors: [],
      configurationErrors: [
        { rule: "NoFoo", ruleset: "r", message: "Missing XPath expression" },
      ],
    };
    expect(() =>
      pmd.parseOutput(ran(0, JSON.stringify(dropped)), ctx(root)),
    ).toThrow(/misconfigured rule NoFoo: Missing XPath expression/);
  });

  it("runs where a ruleset is, on an absolute file list", async () => {
    const root = tmp("vk-pmd-");
    const seed = { cwd: `${root}/app`, files: [`${root}/app/A.java`] };
    expect(await expand(pmd, seed, env(root))).toEqual([]);
    expect(
      (await expand(pmd, seed, env(root, { toolConfig: { enabled: true } })))[0]
        ?.cannotRun,
    ).toMatch(/needs a ruleset/);
    plant(root, { ".pmd/ruleset.xml": "<ruleset/>" });
    const [task] = await expand(pmd, seed, env(root));
    expect(task?.options).toEqual({ ruleset: join(root, ".pmd/ruleset.xml") });
    const c = ctx(`${root}/app`, { files: ["A.java"], options: task?.options });
    const args = pmd.buildArgs(c).args;
    expect(readFileSync(args.at(-1) ?? "", "utf8")).toBe(
      `${root}/app/A.java\n`,
    );
  });
});

describe("ktlint", () => {
  // out/json-log-level-none, cut to two errors, and a syntax error (run
  // here: the note recorded it with the plain reporter only).
  const STDOUT = `[
    {
        "file": "src/Bad.kt",
        "errors": [
            { "line": 3, "column": 1, "message": "Wildcard import", "rule": "standard:no-wildcard-imports" },
            { "line": 5, "column": 11, "message": "Missing spacing before \\"{\\"", "rule": "standard:curly-spacing" }
        ]
    },
    {
        "file": "src/Syn.kt",
        "errors": [
            { "line": 3, "column": 12, "message": "Not a valid Kotlin file (3:12 expecting ')')", "rule": "" }
        ]
    }
]
`;

  it("reports each error; a file that does not parse masks; log lines in the JSON are a crash", () => {
    const root = tmp("vk-kt-");
    const { findings } = ktlint.parseOutput(ran(1, STDOUT), ctx(root));
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
      ]),
    ).toEqual([
      ["src/Bad.kt", 3, 1, "standard:no-wildcard-imports"],
      ["src/Bad.kt", 5, 11, "standard:curly-spacing"],
      ["src/Syn.kt", 3, 12, "syntax-error"],
    ]);
    expect(findings.map((f) => ktlint.masks?.(f))).toEqual([
      false,
      false,
      true,
    ]);
    // out/finding-json: without --log-level=none.
    const logged = `01:22:14.657 [main] WARN com.pinterest.ktlint.cli.internal.KtlintCommandLine -- Lint has found errors than can be autocorrected using 'ktlint --format'\n${STDOUT}`;
    expect(() => ktlint.parseOutput(ran(1, logged), ctx(root))).toThrow(
      /invalid JSON/,
    );
  });

  it("runs where an .editorconfig names a ktlint_ setting; where only detekt runs, it checks only that each file parses", async () => {
    const root = tmp("vk-kt-");
    const seed = { cwd: `${root}/app`, files: [`${root}/app/A.kt`] };
    plant(root, {
      ".editorconfig": "root = true\n\n[*.{kt,kts}]\nindent_size = 4\n",
    });
    expect(await expand(ktlint, seed, env(root))).toEqual([]);
    // The reviewer's dk2: detekt passes a file that does not parse.
    plant(root, { "detekt.yml": "build:\n  maxIssues: 0\n" });
    const [guard] = await expand(ktlint, seed, env(root));
    const c = ctx(seed.cwd, { files: seed.files, options: guard?.options });
    const off = ktlint
      .buildArgs(c)
      .args.find((a) => a.startsWith("--editorconfig="));
    expect(
      readFileSync(off?.slice("--editorconfig=".length) ?? "", "utf8"),
    ).toBe("[*.{kt,kts}]\nktlint_standard = disabled\n");
    plant(root, {
      ".editorconfig":
        "[*.kt]\nktlint_standard_no-wildcard-imports = disabled\n",
    });
    const [own] = await expand(ktlint, seed, env(root));
    expect(
      ktlint.buildArgs(
        ctx(seed.cwd, { files: seed.files, options: own?.options }),
      ).args,
    ).not.toContainEqual(expect.stringMatching(/^--editorconfig=/));
  });
});

// out/finding-report-sarif, the rule list cut.
const SARIF = (root: string) =>
  JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        results: [
          {
            level: "warning",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: `file://${root}/src/Bad.kt` },
                  region: {
                    endColumn: 14,
                    endLine: 1,
                    startColumn: 12,
                    startLine: 1,
                  },
                },
              },
            ],
            message: { text: "This empty block of code can be removed." },
            ruleId: "detekt.empty-blocks.EmptyFunctionBlock",
          },
        ],
        tool: { driver: { name: "detekt", rules: [] } },
      },
    ],
  });

describe("detekt", () => {
  it("reads its SARIF report; within maxIssues it is info; no report is a crash", () => {
    const root = tmp("vk-dt-");
    const c = ctx(root, { files: [`${root}/src/Bad.kt`], options: {} });
    const report =
      detekt
        .buildArgs(c)
        .args.find((a) => a.startsWith("sarif:"))
        ?.slice(6) ?? "";
    expect(() => detekt.parseOutput(ran(0), c)).toThrow(/wrote no report/);
    writeFileSync(report, SARIF(root));
    const { findings } = detekt.parseOutput(ran(2, "", ""), c);
    expect(
      findings.map((f) => [f.file, f.line, f.col, f.ruleId, f.severity]),
    ).toEqual([[`${root}/src/Bad.kt`, 1, 12, "EmptyFunctionBlock", "warning"]]);
    expect(detekt.parseOutput(ran(0), c).findings[0]?.severity).toBe("info");
  });

  it("runs where a detekt config is, building on the defaults", async () => {
    const root = tmp("vk-dt-");
    const seed = { cwd: root, files: [`${root}/A.kt`] };
    expect(await expand(detekt, seed, env(root))).toEqual([]);
    plant(root, { "config/detekt/detekt.yml": "build:\n  maxIssues: 0\n" });
    const [task] = await expand(detekt, seed, env(root));
    const args = detekt.buildArgs(
      ctx(root, { files: seed.files, options: task?.options }),
    ).args;
    expect(args.slice(0, 5)).toEqual([
      "--input",
      `${root}/A.kt`,
      "--config",
      join(root, "config/detekt/detekt.yml"),
      "--build-upon-default-config",
    ]);
    // The reviewer's dk1: `--input` is split at commas.
    const tasks = await expand(
      detekt,
      { cwd: root, files: [`${root}/A.kt`, `${root}/a,b/D.kt`] },
      env(root),
    );
    expect(tasks.map((t) => [t.files, t.cannotRun])).toEqual([
      [[`${root}/A.kt`], undefined],
      [
        [`${root}/a,b/D.kt`],
        `detekt splits --input at commas, so it cannot be given ${root}/a,b/D.kt`,
      ],
    ]);
  });
});

describe("scalafmt", () => {
  it("reads --list: files that differ and parse errors (exit 3); exit 1 with neither is a crash", () => {
    const root = tmp("vk-sf-");
    // out/list-dir.
    const { findings } = scalafmt.parseOutput(
      ran(
        3,
        "src/Bad.scala\n",
        `${root}/src/Syn.scala:2: error: [dialect scala3] \`identifier\` expected but \`=\` found\n  def f( = \n         ^\n`,
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["src/Syn.scala", 2, "syntax-error", "error"],
      ["src/Bad.scala", 1, undefined, "warning"],
    ]);
    expect(() => scalafmt.parseOutput(ran(1), ctx(root))).toThrow(
      /reported nothing the kit reads/,
    );
  });

  it("decodes --list's URI-encoded paths, and says when it downloaded the pinned version", () => {
    const root = tmp("vk-sf-");
    const c = ctx(root, { options: { config: `${root}/.scalafmt.conf` } });
    // The reviewer's sf1.
    const { findings } = scalafmt.parseOutput(
      ran(1, "src/my%20dir/B%20C.scala\nsrc/%C3%BC/U%25.scala\n"),
      c,
    );
    expect(where(findings, root)).toEqual([
      "src/my dir/B C.scala:1:1",
      "src/ü/U%.scala:1:1",
    ]);
    // out/other-version-first-run, cut.
    const fetched = scalafmt.parseOutput(
      ran(
        1,
        "src/Bad.scala\n",
        "Downloading https://repo1.maven.org/maven2/org/scalameta/scalafmt-core_2.13/3.9.0/scalafmt-core_2.13-3.9.0.pom\nDownloaded 1 missing file(s) / 64\n",
      ),
      c,
    ).findings;
    expect(fetched.map((f) => [f.file, f.ruleId, f.severity])).toEqual([
      [`${root}/src/Bad.scala`, undefined, "warning"],
      [`${root}/.scalafmt.conf`, "download", "info"],
    ]);
  });

  it("runs where a .scalafmt.conf is at or above the root, with it", async () => {
    const root = tmp("vk-sf-");
    const seed = { cwd: `${root}/mod`, files: [`${root}/mod/A.scala`] };
    expect(await expand(scalafmt, seed, env(root))).toEqual([]);
    plant(root, {
      ".scalafmt.conf": "version = 3.11.5\nrunner.dialect = scala3\n",
    });
    const [task] = await expand(scalafmt, seed, env(root));
    expect(
      scalafmt.buildArgs(
        ctx(root, { files: seed.files, options: task?.options }),
      ).args,
    ).toEqual([
      "--list",
      "--non-interactive",
      "--respect-project-filters",
      "--config",
      join(root, ".scalafmt.conf"),
      `${root}/mod/A.scala`,
    ]);
  });
});
