import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cargoMutants } from "../src/adapters/cargo-mutants.js";
import { gremlins } from "../src/adapters/gremlins.js";
import { mutmut } from "../src/adapters/mutmut.js";
import { planMutation } from "../src/adapters/mutation.js";
import { stryker } from "../src/adapters/stryker.js";
import { toPosix } from "../src/detect/languages.js";
import type { PlanEnv, RawOutput, ToolContext } from "../src/core/types.js";

// Every report below was captured from a real run on 2026-10-13 (Stryker
// 10.0.0, cargo-mutants 27.1.0, mutmut 3.8.0, gremlins 0.6.0) against one
// fixture per language: is_adult(age) with asserting tests, discount(total)
// with a test that calls it and asserts nothing. Trimmed, never edited
// (docs/research/lint-toolchain/mutation-testing/).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

/** A task context whose scratch folder the test can read back. */
function task(
  cwd: string,
  options: { targets?: string[]; scope: string[] },
): ToolContext & { scratch: string } {
  const scratch = tmp("vk-mutation-scratch-");
  return {
    cwd,
    fix: false,
    extraArgs: [],
    options,
    tempDir: () => scratch,
    scratch,
  };
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

describe("planMutation", () => {
  const root = "/p";
  const scope = [
    "/p/src/calc.ts",
    "/p/src/calc.test.ts",
    "/p/test/util.ts",
    "/p/lib.rs",
  ];
  const env = (changedPaths?: string[]) =>
    ({
      projectRoot: root,
      scopedFiles: scope,
      ...(changedPaths ? { changedPaths } : {}),
    }) as unknown as PlanEnv;

  it("leaves a full run to the tool's config, and plants mutants only in a change's source files", () => {
    expect(planMutation({ cwd: root }, env(), ["ts"])).toEqual([
      {
        cwd: root,
        options: {
          scope: ["/p/src/calc.ts", "/p/src/calc.test.ts", "/p/test/util.ts"],
        },
      },
    ]);
    const [changed] = planMutation(
      { cwd: root },
      env(["src/calc.ts", "src/calc.test.ts", "README.md"]),
      ["ts"],
    );
    expect(changed?.options).toMatchObject({ targets: ["src/calc.ts"] });
  });

  it("judges a changed test by the source it is named after, and plants nothing for a test of nothing", () => {
    const [named] = planMutation({ cwd: root }, env(["src/calc.test.ts"]), [
      "ts",
    ]);
    expect(named?.options).toMatchObject({ targets: ["src/calc.ts"] });
    expect(planMutation({ cwd: root }, env(["test/util.ts"]), ["ts"])).toEqual(
      [],
    );
  });

  it("leaves a nested package's files to that package's own run", () => {
    const top = tmp("vk-mutation-nested-");
    mkdirSync(join(top, "packages", "a", "src"), { recursive: true });
    writeFileSync(join(top, "packages", "a", "package.json"), "{}\n");
    const files = [`${top}/src/x.ts`, `${top}/packages/a/src/y.ts`];
    const plan = (nested: string[]) =>
      planMutation(
        { cwd: top },
        {
          projectRoot: top,
          scopedFiles: files,
          changedPaths: ["src/x.ts", "packages/a/src/y.ts"],
        } as unknown as PlanEnv,
        ["ts"],
        nested,
      )[0]?.options;
    expect(plan(["package.json"])).toMatchObject({
      targets: ["src/x.ts"],
      scope: [`${top}/src/x.ts`],
    });
    expect(plan([])).toMatchObject({
      targets: ["src/x.ts", "packages/a/src/y.ts"],
    });
  });
});

describe("stryker", () => {
  // mutation.json of run 1, files["src/calc.ts"]: four of its twelve mutants.
  const source =
    "export function isAdult(age: number): boolean {\n  return age >= 18;\n}\n\nexport function discount(total: number): number {\n  if (total > 100) {\n    return total * 0.9;\n  }\n  return total;\n}\n";
  const report = {
    schemaVersion: "1.0",
    files: {
      "src/calc.ts": {
        language: "typescript",
        source,
        mutants: [
          {
            id: "3",
            mutatorName: "EqualityOperator",
            replacement: "age > 18",
            status: "Killed",
            location: {
              end: { column: 19, line: 2 },
              start: { column: 10, line: 2 },
            },
          },
          {
            id: "9",
            mutatorName: "EqualityOperator",
            replacement: "total <= 100",
            status: "Survived",
            location: {
              end: { column: 18, line: 6 },
              start: { column: 7, line: 6 },
            },
          },
          {
            id: "11",
            mutatorName: "ArithmeticOperator",
            replacement: "total / 0.9",
            status: "Survived",
            location: {
              end: { column: 23, line: 7 },
              start: { column: 12, line: 7 },
            },
          },
        ],
      },
      // mutation-untested-nocoverage.json: a file no test imports.
      "src/untested.ts": {
        language: "typescript",
        source:
          "export function triple(n: number): number {\n  return n * 3;\n}\n",
        mutants: [
          {
            id: "15",
            mutatorName: "ArithmeticOperator",
            replacement: "n / 3",
            status: "NoCoverage",
            location: {
              end: { column: 15, line: 2 },
              start: { column: 10, line: 2 },
            },
          },
        ],
      },
    },
  };

  it("reports each survivor and uncovered mutant with the code it replaced, and nothing killed or out of scope", () => {
    const root = tmp("vk-stryker-");
    const ctx = task(root, { scope: [`${root}/src/calc.ts`] });
    stryker.buildArgs(ctx);
    writeFileSync(join(ctx.scratch, "mutation.json"), JSON.stringify(report));
    const { findings } = stryker.parseOutput(ran(0), ctx);
    expect(findings.map((f) => [f.line, f.col, f.ruleId, f.message])).toEqual([
      [
        6,
        7,
        "survived",
        "no test fails on `total > 100` → `total <= 100` (EqualityOperator)",
      ],
      [
        7,
        12,
        "survived",
        "no test fails on `total * 0.9` → `total / 0.9` (ArithmeticOperator)",
      ],
    ]);
    expect(findings[0]).toMatchObject({
      layer: "mutation",
      severity: "warning",
      language: "ts",
      endLine: 6,
      endCol: 18,
    });

    ctx.options = { scope: [`${root}/src/untested.ts`] };
    expect(stryker.parseOutput(ran(0), ctx).findings[0]).toMatchObject({
      ruleId: "no-coverage",
      message: "no test runs `n * 3` → `n / 3` (ArithmeticOperator)",
    });
  });

  it("runs once per package, on the changed files the project's own `mutate` takes, with every output moved out of the project", async () => {
    const root = tmp("vk-stryker-");
    writeFileSync(
      join(root, "stryker.conf.json"),
      JSON.stringify({
        testRunner: "vitest",
        concurrency: 2,
        mutate: ["src/**", "app/**", "!src/**/*.generated.ts"],
      }),
    );
    const changed = [
      "src/calc.ts",
      "src/api.generated.ts",
      "vite.config.ts",
      "app/[slug]/page.tsx",
    ];
    const env = {
      projectRoot: root,
      scopedFiles: changed.map((path) => `${root}/${path}`).toSorted(),
      changedPaths: changed,
      toolConfig: {},
    } as unknown as PlanEnv;
    // src/ has a tsconfig of its own: the planner starts from both folders.
    const [planned] = (await stryker.expand?.({ cwd: root }, env)) ?? [];
    expect(await stryker.expand?.({ cwd: `${root}/src` }, env)).toEqual([]);
    expect(planned?.options).toMatchObject({
      targets: ["app/[slug]/page.tsx", "src/calc.ts"],
      config: join(root, "stryker.conf.json"),
    });

    const ctx = { ...task(root, { scope: [] }), options: planned?.options };
    const built = stryker.buildArgs(ctx);
    expect(built).toMatchObject({
      args: ["run", expect.any(String)],
      processGroup: true,
    });
    const loaded = (await import(pathToFileURL(built.args[1] ?? "").href)) as {
      default: Record<string, unknown>;
    };
    expect(loaded.default).toMatchObject({
      testRunner: "vitest",
      concurrency: 2,
      // Stryker reads `mutate` as globs: `[slug]` would be a character class.
      mutate: ["app/[[]slug[]]/page.tsx", "src/calc.ts"],
      reporters: ["json"],
      jsonReporter: { fileName: join(ctx.scratch, "mutation.json") },
      cleanTempDir: "always",
      fileLogLevel: "off",
    });
    expect(loaded.default.tempDirName).toBe(join(ctx.scratch, "sandbox"));
  });

  it("is a crash, naming Stryker's error, when it wrote no report", () => {
    const root = tmp("vk-stryker-");
    const ctx = task(root, { scope: [] });
    stryker.buildArgs(ctx);
    // Run 18: an assertion that fails before any mutation.
    const stdout =
      "22:51:39 (98330) ERROR DryRunExecutor One or more tests failed in the initial test run:\n";
    expect(() => stryker.parseOutput(ran(1, stdout), ctx)).toThrow(
      /One or more tests failed/,
    );
  });
});

/** A cargo-mutants outcome's scenario, as outcomes.json writes it. */
const mutant = (
  line: number,
  column: number,
  endColumn: number,
  name: string,
  replacement: string,
  file = "src/lib.rs",
) => ({
  Mutant: {
    name: `${file}:${line}:${column}: ${name}`,
    package: "fx",
    file,
    span: { start: { line, column }, end: { line, column: endColumn } },
    replacement,
    genre: "BinaryOperator",
  },
});

describe("cargo-mutants", () => {
  const outcomes = {
    outcomes: [
      { scenario: "Baseline", summary: "Success" },
      {
        scenario: mutant(4, 9, 11, "replace >= with < in is_adult", "<"),
        summary: "CaughtMutant",
      },
      {
        scenario: mutant(8, 14, 15, "replace > with >= in discount", ">="),
        summary: "MissedMutant",
      },
      {
        scenario: mutant(
          4,
          7,
          8,
          "replace * with + in double",
          "+",
          "src/other.rs",
        ),
        summary: "MissedMutant",
      },
    ],
    total_mutants: 3,
    missed: 2,
    caught: 1,
    cargo_mutants_version: "27.1.0",
  };
  const run = (exitCode: number, written: unknown = outcomes) => {
    const root = tmp("vk-cargo-mutants-");
    const ctx = task(root, {
      targets: ["src/lib.rs"],
      scope: [`${root}/src/lib.rs`],
    });
    const built = cargoMutants.buildArgs(ctx);
    if (written !== null) {
      mkdirSync(join(ctx.scratch, "mutants.out"));
      writeFileSync(
        join(ctx.scratch, "mutants.out", "outcomes.json"),
        JSON.stringify(written),
      );
    }
    return { built, parse: () => cargoMutants.parseOutput(ran(exitCode), ctx) };
  };

  it("mutates a changed run's files, outside the project, and reports each missed mutant in scope", () => {
    const { built, parse } = run(2);
    expect(built.args).toEqual(
      expect.arrayContaining(["mutants", "--file", "src/lib.rs", "--output"]),
    );
    expect(
      parse().findings.map((f) => [
        f.file.endsWith("src/lib.rs"),
        f.line,
        f.col,
        f.message,
      ]),
    ).toEqual([
      [true, 8, 14, "no test fails on replace > with >= in discount"],
    ]);
    expect(cargoMutants.refuseArgs?.(["--in-place"])).toMatch(
      /project's own files/,
    );
  });

  it("is a crash when the tests already fail, when no outcomes were written, or exit 2 names no missed mutant", () => {
    expect(() => run(4, null).parse()).toThrow(
      /tests fail before any mutation/,
    );
    expect(() => run(0, null).parse()).toThrow(/no outcomes.json/);
    expect(() =>
      run(2, { ...outcomes, outcomes: [outcomes.outcomes[0]] }).parse(),
    ).toThrow(/no MissedMutant/);
  });
});

describe("mutmut", () => {
  const original =
    "def is_adult(age):\n    return age >= 18\n\n\ndef discount(total):\n    if total > 100:\n        return total * 0.9\n    return total\n";
  // mutants/calc.py as mutmut 3.8.0 wrote it (its trampolines trimmed to blank lines, so .spans' lines hold).
  const generated = [
    "",
    "",
    "from mutmut.mutation.trampoline import wrap_in_trampoline as _mutmut_mutated, MutantDict",
    "",
    "",
    "def is_adult(age):",
    "    return age >= 18",
    "def x_is_adult__mutmut_orig(age):",
    "    return age >= 18",
    "def x_is_adult__mutmut_1(age):",
    "    return age > 18",
    "def x_is_adult__mutmut_2(age):",
    "    return age >= 19",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "def discount(total):",
    "    if total > 100:",
    "        return total * 0.9",
    "    return total",
    "",
    "",
    "def x_discount__mutmut_orig(total):",
    "    if total > 100:",
    "        return total * 0.9",
    "    return total",
    "",
    "",
    "def x_discount__mutmut_1(total):",
    "    if total >= 100:",
    "        return total * 0.9",
    "    return total",
    "",
    "",
    "def x_discount__mutmut_2(total):",
    "    if total > 101:",
    "        return total * 0.9",
    "    return total",
    "",
    "",
    "def x_discount__mutmut_3(total):",
    "    if total > 100:",
    "        return total / 0.9",
    "    return total",
    "",
  ].join("\n");
  const spans = {
    version: 1,
    spans: {
      x_is_adult__mutmut_orig: [8, 9],
      x_is_adult__mutmut_1: [10, 11],
      x_is_adult__mutmut_2: [12, 13],
      x_discount__mutmut_orig: [26, 31],
      x_discount__mutmut_1: [32, 37],
      x_discount__mutmut_2: [38, 43],
      x_discount__mutmut_3: [44, 49],
    },
  };
  const meta = {
    exit_code_by_key: {
      "calc.x_is_adult__mutmut_1": 1,
      "calc.x_is_adult__mutmut_2": 1,
      "calc.x_discount__mutmut_1": 0,
      "calc.x_discount__mutmut_2": 0,
      "calc.x_discount__mutmut_3": null,
    },
  };

  // A git work tree: the copy is what git tracks or would.
  const project = () => {
    const root = tmp("vk-mutmut-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "calc.py"), original);
    writeFileSync(
      join(root, "pyproject.toml"),
      '[tool.mutmut]\nsource_paths = ["calc.py"]\n',
    );
    mkdirSync(join(root, "mutants"));
    writeFileSync(
      join(root, "mutants", "stale.txt"),
      "a run of the project's own\n",
    );
    return root;
  };

  it("runs in a copy of the project and reports each survivor at its line in the original", () => {
    const root = project();
    const ctx = task(root, {
      targets: ["calc.py"],
      scope: [`${root}/calc.py`],
    });
    const built = mutmut.buildArgs(ctx);
    expect(built.cwd).toBe(ctx.scratch);
    expect(built.args).toEqual(["run", "calc.x*"]);
    expect(readFileSync(join(ctx.scratch, "calc.py"), "utf8")).toBe(original);
    // The project's own mutants/ is not copied: mutmut's results are its run's.
    expect(existsSync(join(ctx.scratch, "mutants", "stale.txt"))).toBe(false);
    mkdirSync(join(ctx.scratch, "mutants"));
    writeFileSync(join(ctx.scratch, "mutants", "calc.py"), generated);
    writeFileSync(
      join(ctx.scratch, "mutants", "calc.py.spans"),
      JSON.stringify(spans),
    );
    writeFileSync(
      join(ctx.scratch, "mutants", "calc.py.meta"),
      JSON.stringify(meta),
    );
    expect(
      mutmut
        .parseOutput(ran(0), ctx)
        .findings.map((f) => [f.line, f.col, f.message]),
    ).toEqual([
      [
        6,
        15,
        "no test fails on `if total > 100:` → `if total >= 100:` (calc.x_discount__mutmut_1)",
      ],
      [
        6,
        18,
        "no test fails on `if total > 100:` → `if total > 101:` (calc.x_discount__mutmut_2)",
      ],
    ]);
  });

  it("names a changed module's mutants for any source folder, and reads its failures", () => {
    const root = project();
    const ctx = task(root, { targets: ["src/calc/ops.py"], scope: [] });
    // `calc.ops.x_twice__mutmut_1` is how mutmut names a mutant of src/calc/ops.py.
    expect(mutmut.buildArgs(ctx).args).toContain("calc.ops.x*");
    expect(
      mutmut.parseOutput(
        ran(
          1,
          "AssertionError: Filtered for specific mutants, but nothing matches\n",
        ),
        ctx,
      ).findings,
    ).toEqual([]);
    expect(() =>
      mutmut.parseOutput(
        ran(
          1,
          "⠋ Generating mutants\nfailed to collect stats. runner returned 1\n",
        ),
        ctx,
      ),
    ).toThrow(/could not run \(exit 1\): failed to collect stats/);
  });
});

describe("gremlins", () => {
  const calc =
    "package fx\n\nfunc IsAdult(age int) bool {\n\treturn age >= 18\n}\n\nfunc Discount(total float64) float64 {\n\tif total > 100 {\n\t\treturn total * 0.9\n\t}\n\treturn total\n}\n";
  const setup = (targets?: string[]) => {
    const root = tmp("vk-gremlins-");
    // gen/ is generated code the kit's config ignores: in no scope, but
    // gremlins mutates it all the same unless told not to.
    for (const path of [
      "other.go",
      "calc_test.go",
      "sub/a.go",
      "sub/deep/b.go",
      "lib/c.go",
      "lib/d.go",
      "gen/z.go",
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "package fx\n");
    }
    writeFileSync(join(root, "calc.go"), calc);
    writeFileSync(
      join(root, ".gremlins.yaml"),
      "unleash:\n  exclude-files:\n    - _gen\\.go$\n",
    );
    const scope = [
      `${root}/calc.go`,
      `${root}/other.go`,
      `${root}/calc_test.go`,
      `${root}/sub/a.go`,
      `${root}/sub/deep/b.go`,
      `${root}/lib/c.go`,
      `${root}/lib/d.go`,
    ];
    const ctx = task(root, { ...(targets ? { targets } : {}), scope });
    return {
      ctx,
      built: gremlins.buildArgs(ctx),
      write: (report: unknown) => {
        writeFileSync(
          join(ctx.scratch, "gremlins.json"),
          JSON.stringify(report),
        );
      },
    };
  };

  it("reports each LIVED and NOT COVERED mutant with the operator it changed", () => {
    const { ctx, write } = setup();
    // report-full.json, and NOT COVERED from fx3.json.
    write({
      go_module: "example.com/fx",
      files: [
        {
          file_name: "other.go",
          mutations: [
            { type: "ARITHMETIC_BASE", status: "KILLED", line: 4, column: 11 },
          ],
        },
        {
          file_name: "calc.go",
          mutations: [
            { type: "ARITHMETIC_BASE", status: "LIVED", line: 9, column: 16 },
            {
              type: "CONDITIONALS_NEGATION",
              status: "KILLED",
              line: 4,
              column: 13,
            },
            {
              type: "CONDITIONALS_BOUNDARY",
              status: "NOT COVERED",
              line: 8,
              column: 11,
            },
          ],
        },
      ],
    });
    expect(
      gremlins
        .parseOutput(ran(0), ctx)
        .findings.map((f) => [f.line, f.col, f.ruleId, f.message]),
    ).toEqual([
      [8, 11, "no-coverage", "no test runs CONDITIONALS_BOUNDARY of `>`"],
      [9, 16, "survived", "no test fails on ARITHMETIC_BASE of `*`"],
    ]);
  });

  it("excludes the module's other files in a changed run, the ignored ones and the project's own exclusions too, and keeps Go's test cache from timing every mutant out", () => {
    const { built } = setup(["calc.go", "lib/d.go"]);
    expect(built.args).toEqual(
      expect.arrayContaining([
        "--exclude-files",
        "^(?:gen/|lib/c\\.go$|other\\.go$|sub/)",
        "--exclude-files",
        "_gen\\.go$",
        "--timeout-coefficient",
        "30",
      ]),
    );
    expect(built.env?.GOFLAGS).toMatch(/-count=1$/);
  });

  it("is a crash when every mutant timed out, or it could not run; nothing to mutate is a pass", () => {
    const { ctx, write } = setup();
    expect(() =>
      gremlins.parseOutput(
        ran(
          1,
          "Starting...\n",
          "ERROR: failed to gather coverage: impossible to executeCoverage coverage: exit status 1\n",
        ),
        ctx,
      ),
    ).toThrow(/ERROR: failed to gather coverage/);
    expect(
      gremlins.parseOutput(
        ran(0, "Starting...\n\nNo results to report.\n"),
        ctx,
      ).findings,
    ).toEqual([]);
    // report-warm-cache-timedout.json: a second run with Go's test cache warm.
    write({
      files: [
        {
          file_name: "calc.go",
          mutations: [
            {
              type: "CONDITIONALS_BOUNDARY",
              status: "TIMED OUT",
              line: 8,
              column: 11,
            },
            {
              type: "ARITHMETIC_BASE",
              status: "TIMED OUT",
              line: 9,
              column: 16,
            },
          ],
        },
      ],
    });
    expect(() => gremlins.parseOutput(ran(0), ctx)).toThrow(
      /all 2 mutants timed out/,
    );
  });
});
