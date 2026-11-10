import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionlint } from "../src/adapters/actionlint.js";
import { agnix } from "../src/adapters/agnix.js";
import { cargoShear } from "../src/adapters/cargo-shear.js";
import { checkJsonschema } from "../src/adapters/check-jsonschema.js";
import { composerDependencyAnalyser } from "../src/adapters/composer-dependency-analyser.js";
import { editorconfigChecker } from "../src/adapters/editorconfig-checker.js";
import { sherif } from "../src/adapters/sherif.js";
import { shfmt } from "../src/adapters/shfmt.js";
import { sobelow } from "../src/adapters/sobelow.js";
import { spectral } from "../src/adapters/spectral.js";
import { strykerNet } from "../src/adapters/stryker-net.js";
import { cargoMachete } from "../src/adapters/cargo-machete.js";
import { cooldown } from "../src/adapters/cooldown.js";
import { deptry } from "../src/adapters/deptry.js";
import { errorProne } from "../src/adapters/error-prone.js";
import { forgeLint } from "../src/adapters/forge-lint.js";
import { infection } from "../src/adapters/infection.js";
import { periphery } from "../src/adapters/periphery.js";
import { goModTidy } from "../src/adapters/go-mod-tidy.js";
import { typos } from "../src/adapters/typos.js";
import { uvLock } from "../src/adapters/uv-lock.js";
import { zizmor } from "../src/adapters/zizmor.js";
import { toPosix } from "../src/detect/languages.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolContext,
} from "../src/core/types.js";

// Every output below was captured from a real run on 2026-10-14 (zizmor
// 1.30.1, typos 1.51.1, deptry 0.25.1, cargo-machete 0.9.2) against a
// fixture with the problem planted, then trimmed
// (docs/research/lint-toolchain/hygiene-adapters.md).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-hygiene-scratch-");
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

/** One finding as zizmor 1.30.1 printed it, its locations trimmed. */
const found = (
  ident: string,
  severity: string,
  row: number,
  column: number,
  ignored = false,
) => ({
  ident,
  desc:
    ident === "template-injection"
      ? "code injection via template expansion"
      : "ad-hoc installation of packages",
  url: `https://docs.zizmor.sh/audits/#${ident}`,
  determinations: { confidence: "High", severity, persona: "Regular" },
  locations: [
    {
      symbolic: {
        key: { Local: { verbatim_path: ".github/workflows/i.yml" } },
        annotation: "this step",
        kind: "Hidden",
      },
      concrete: {
        location: {
          start_point: { row: row - 1, column: 0 },
          end_point: { row, column: 0 },
        },
      },
    },
    {
      symbolic: {
        key: { Local: { verbatim_path: ".github/workflows/i.yml" } },
        annotation: "may expand into attacker-controllable code",
        kind: "Primary",
      },
      concrete: {
        location: {
          start_point: { row, column },
          end_point: { row, column: column + 33 },
        },
      },
    },
  ],
  ignored,
  fixes: [],
});

describe("zizmor", () => {
  it("reports each finding at its primary location, 1-based, by severity, and drops ignored ones", () => {
    const root = tmp("vk-zizmor-");
    const stdout = JSON.stringify([
      found("template-injection", "High", 7, 23),
      found("adhoc-packages", "Low", 9, 10),
      found("adhoc-packages", "Low", 11, 10, true),
      found("excessive-permissions", "Informational", 2, 0),
    ]);
    const { findings } = zizmor.parseOutput(ran(14, stdout), ctx(root));
    expect(findings.map((f) => [f.ruleId, f.line, f.col, f.severity])).toEqual([
      ["template-injection", 8, 24, "error"],
      ["adhoc-packages", 10, 11, "warning"],
      ["excessive-permissions", 3, 1, "info"],
    ]);
    expect(findings[0]).toMatchObject({
      file: `${root}/.github/workflows/i.yml`,
      message:
        "code injection via template expansion: may expand into attacker-controllable code (high confidence)",
      url: "https://docs.zizmor.sh/audits/#template-injection",
    });
    expect(() =>
      zizmor.parseOutput(
        ran(14, JSON.stringify([{ ident: "x", locations: [] }])),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
  });

  it("drops a finding in a folder the kit's config ignores (a fixture)", () => {
    const root = tmp("vk-zizmor-");
    const fixture = found("template-injection", "High", 7, 23);
    for (const l of fixture.locations)
      l.symbolic.key.Local.verbatim_path = "fixtures/.github/workflows/i.yml";
    const stdout = JSON.stringify([
      fixture,
      found("adhoc-packages", "Low", 9, 10),
    ]);
    const { findings } = zizmor.parseOutput(
      ran(14, stdout),
      ctx(root, { options: { ignore: ["fixtures/**"] } }),
    );
    expect(findings.map((f) => f.ruleId)).toEqual(["adhoc-packages"]);
  });

  it("reports a column in characters where the line holds multi-byte text", () => {
    const root = tmp("vk-zizmor-");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    // `$` is byte 20 of the line, and code unit 17 (`🚀` is two, as editors
    // count it, `é` one): column 18.
    writeFileSync(
      join(root, ".github", "workflows", "i.yml"),
      'x:\n  run: echo "🚀é ${{ github.event.issue.title }}"\n',
    );
    const one = found("template-injection", "High", 1, 20);
    const [f] = zizmor.parseOutput(
      ran(14, JSON.stringify([one])),
      ctx(root),
    ).findings;
    expect([f?.line, f?.col]).toEqual([2, 18]);
  });

  it("runs where the project chose it and has workflows, and in a changed run only for a workflow change", () => {
    const root = tmp("vk-zizmor-");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    const seed = { cwd: root };
    expect(zizmor.expand?.(seed, env(root))).toEqual([]);
    // A workflow that runs the zizmor action chooses it too.
    writeFileSync(
      join(root, ".github", "workflows", "ci.yml"),
      "on: push\njobs:\n  a:\n    steps:\n      - uses: zizmorcore/zizmor-action@abc\n",
    );
    expect(zizmor.expand?.(seed, env(root))).toHaveLength(1);
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    writeFileSync(join(root, ".github", "zizmor.yml"), "rules: {}\n");
    expect(zizmor.expand?.(seed, env(root))).toEqual([
      { ...seed, options: { ignore: [] } },
    ]);
    expect(
      zizmor.expand?.(seed, env(root, { changedPaths: ["src/a.ts"] })),
    ).toEqual([]);
    expect(
      zizmor.expand?.(
        seed,
        env(root, { changedPaths: [".github/workflows/ci.yml"] }),
      ),
    ).toHaveLength(1);
  });
});

describe("typos", () => {
  it("reports each typo at its character column and a misspelled file name at line 1, never as fixable", () => {
    const root = tmp("vk-typos-");
    // A two-byte character before the typo: typos counts bytes.
    writeFileSync(join(root, "a.ts"), "// é teh\nexport const recieve = 1;\n");
    const stdout = [
      '{"type":"typo","path":"a.ts","line_num":1,"byte_offset":6,"typo":"teh","corrections":["the"]}',
      '{"type":"typo","path":"a.ts","line_num":2,"byte_offset":13,"typo":"recieve","corrections":["receive"]}',
      '{"type":"typo","path":"m.py","line_num":3,"byte_offset":5,"typo":"ot","corrections":["to","of","or","not","it"]}',
      '{"type":"typo","path":"recieve.py","byte_offset":0,"typo":"recieve","corrections":["receive"]}',
      '{"type":"binary_file","path":"logo.png"}',
      "",
    ].join("\n");
    const { findings } = typos.parseOutput(
      ran(2, stdout),
      ctx(root, { options: { files: ["a.ts", "m.py", "recieve.py"] } }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.fixable,
      ]),
    ).toEqual([
      ["a.ts", 1, 6, false],
      ["a.ts", 2, 14, false],
      ["m.py", 3, 6, false],
      ["recieve.py", 1, 1, false],
    ]);
    expect(findings[2]?.message).toBe(
      "`ot` should be `to` or `of` or `or` or `not` or `it`",
    );
  });

  it("reads the kit's scope without binaries, only a change's files in a changed run, and never writes: typos' fixes rename files", () => {
    const root = tmp("vk-typos-");
    const seed = { cwd: root };
    const scopedFiles = [
      `${root}/a.ts`,
      `${root}/docs/x.md`,
      `${root}/logo.png`,
    ];
    expect(typos.expand?.(seed, env(root, { scopedFiles }))).toEqual([]);
    writeFileSync(join(root, "_typos.toml"), "[default]\n");
    const [all] = (typos.expand?.(seed, env(root, { scopedFiles })) ?? []) as {
      options?: unknown;
    }[];
    expect(all?.options).toEqual({ files: ["a.ts", "docs/x.md"] });
    const [changed] = (typos.expand?.(
      seed,
      env(root, { scopedFiles, changedPaths: ["docs/x.md"] }),
    ) ?? []) as { options?: unknown }[];
    expect(changed?.options).toEqual({ files: ["docs/x.md"] });

    const built = typos.buildArgs(
      ctx(root, { fix: true, options: { files: ["a.ts"] } }),
    );
    expect(built.args).not.toContain("--write-changes");
    const list = built.args[built.args.indexOf("--file-list") + 1] ?? "";
    expect(readFileSync(list, "utf8")).toBe("a.ts\n");
    expect(typos.supportsFix).toBe(false);
  });
});

describe("deptry", () => {
  it("reports an undeclared import as an error at its line, and an unused package at the manifest line that declares it", () => {
    const root = tmp("vk-deptry-");
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\nname = "app"\ndependencies = [\n  "requests",\n  "rich",\n]\n',
    );
    const c = ctx(root);
    deptry.buildArgs(c);
    // out.json: rich declared and unused, yaml imported and undeclared.
    writeFileSync(
      join(c.tempDir?.() ?? "", "deptry.json"),
      JSON.stringify([
        {
          error: {
            code: "DEP002",
            message:
              "'rich' defined as a dependency but not used in the codebase",
          },
          module: "rich",
          location: { file: "pyproject.toml", line: null, column: null },
        },
        {
          error: {
            code: "DEP001",
            message:
              "'yaml' imported but missing from the dependency definitions",
          },
          module: "yaml",
          location: { file: "src/app/__init__.py", line: 2, column: 8 },
        },
      ]),
    );
    expect(
      deptry
        .parseOutput(ran(1), c)
        .findings.map((f) => [
          f.ruleId,
          f.file.slice(root.length + 1),
          f.line,
          f.col,
          f.severity,
        ]),
    ).toEqual([
      ["DEP002", "pyproject.toml", 5, 1, "warning"],
      ["DEP001", "src/app/__init__.py", 2, 8, "error"],
    ]);
    expect(() =>
      deptry.parseOutput(ran(2, "", "Error: bad option"), ctx(root)),
    ).toThrow(/wrote no report/);
    // deptry 0.25 on a pyproject.toml with tool settings only: a note, not a crash.
    const none = deptry.parseOutput(
      ran(
        1,
        "",
        "deptry.exceptions.DependencySpecificationNotFoundError: No file called 'pyproject.toml' with a [tool.poetry.dependencies], [tool.pdm] or [project] section or file(s) called 'requirements.txt' found. Exiting.\n",
      ),
      ctx(root),
    );
    expect(
      none.findings.map((f) => [
        f.ruleId,
        f.file.slice(root.length + 1),
        f.severity,
      ]),
    ).toEqual([["no-dependency-list", "pyproject.toml", "info"]]);
  });

  it("sees the project's packages' metadata (yaml is pyyaml's), not their modules, which could replace deptry's own", () => {
    const root = tmp("vk-deptry-");
    const site = join(root, ".venv", "lib", "python3.12", "site-packages");
    mkdirSync(join(site, "PyYAML-6.0.3.dist-info"), { recursive: true });
    mkdirSync(join(site, "click"), { recursive: true });
    const path =
      deptry.buildArgs(ctx(root)).env?.PYTHONPATH?.split(delimiter)[0] ?? "";
    expect(readdirSync(path)).toEqual(["PyYAML-6.0.3.dist-info"]);
    expect(deptry.buildArgs(ctx(tmp("vk-deptry-bare-"))).env).toBeUndefined();
  });

  it("leaves a nested Python project to its own run, and finds a Poetry declaration's line", () => {
    const root = tmp("vk-deptry-");
    mkdirSync(join(root, "packages", "b", "b"), { recursive: true });
    writeFileSync(join(root, "packages", "b", "pyproject.toml"), "[project]\n");
    const seed = { cwd: root };
    const [task] = (deptry.expand?.(
      seed,
      env(root, {
        scopedFiles: [`${root}/app.py`, `${root}/packages/b/b/__init__.py`],
      }),
    ) ?? []) as { options?: unknown }[];
    expect(task?.options).toEqual({ nested: ["packages/b"] });
    const args = deptry.buildArgs(ctx(root, { options: task?.options })).args;
    const at = args.indexOf("--extend-exclude");
    expect(args.slice(at, at + 2)).toEqual([
      "--extend-exclude",
      "packages/b(/|$)",
    ]);
    writeFileSync(
      join(root, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\n',
    );
    const c = ctx(root);
    deptry.buildArgs(c);
    writeFileSync(
      join(c.tempDir?.() ?? "", "deptry.json"),
      JSON.stringify([
        {
          error: {
            code: "DEP002",
            message:
              "'rich' defined as a dependency but not used in the codebase",
          },
          module: "rich",
          location: { file: "pyproject.toml", line: null, column: null },
        },
      ]),
    );
    expect(deptry.parseOutput(ran(1), c).findings[0]?.line).toBe(3);
  });
});

describe("cargo-machete", () => {
  it("reports each unused dependency at the line of Cargo.toml that declares it", () => {
    const root = tmp("vk-machete-");
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "cm"\nversion = "0.1.0"\n\n[dependencies]\nlog = "0.4"\nonce_cell = "1"\n',
    );
    // unused.txt, verbatim.
    const stdout = [
      "Analyzing dependencies of crates in this directory...",
      "cargo-machete found the following unused dependencies in this directory:",
      "cm -- ./Cargo.toml:",
      "\tonce_cell",
      "",
      "If you believe cargo-machete has detected an unused dependency incorrectly,",
      "[package.metadata.cargo-machete]",
      'ignored = ["prost"]',
      "",
      "Done!",
      "",
    ].join("\n");
    expect(
      cargoMachete
        .parseOutput(ran(1, stdout), ctx(root))
        .findings.map((f) => [f.file, f.line, f.message]),
    ).toEqual([
      [
        `${root}/Cargo.toml`,
        7,
        "`once_cell` is a dependency nothing in the crate uses",
      ],
    ]);
    // A [features] key named like the dependency is not where it is declared.
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "cm"\n\n[features]\nonce_cell = []\n\n[dependencies]\nlog = "0.4"\nonce_cell = "1"\n',
    );
    expect(
      cargoMachete.parseOutput(ran(1, stdout), ctx(root)).findings[0]?.line,
    ).toBe(9);
    const clean =
      "Analyzing dependencies of crates in this directory...\ncargo-machete didn't find any unused dependencies in this directory. Good job!\nDone!\n";
    expect(cargoMachete.parseOutput(ran(0, clean), ctx(root)).findings).toEqual(
      [],
    );
  });
});

/**
 * Each cooldown finding as [file relative to root, rule], planned as a run
 * plans it (the folders with a lockfile) and read as a run reads it.
 */
async function cooldownGaps(
  root: string,
  ignore: string[] = [],
): Promise<string[][]> {
  const [task] =
    (await cooldown.expand?.(
      { cwd: root },
      env(root, { config: { ignore } } as Partial<PlanEnv>),
    )) ?? [];
  if (!task) return [];
  return cooldown
    .parseOutput(ran(0), ctx(root, { options: task.options }))
    .findings.map((f) => [f.file.slice(root.length + 1), f.ruleId ?? ""]);
}

describe("cooldown", () => {
  it("asks each package manager in use for a release-age cooldown, where its setting goes", async () => {
    const root = tmp("vk-cooldown-");
    writeFileSync(join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    writeFileSync(
      join(root, "package.json"),
      '{"name":"c","packageManager":"pnpm@10.12.0"}\n',
    );
    writeFileSync(join(root, "uv.lock"), "version = 1\n");
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "u"\n');
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    expect(await cooldownGaps(root)).toEqual([
      ["pnpm-lock.yaml", "pnpm-minimum-release-age"],
      ["pnpm-lock.yaml", "pnpm-trust-policy"],
      ["package.json", "pnpm-too-old"],
      ["pyproject.toml", "uv-exclude-newer"],
      ["package-lock.json", "npm-min-release-age"],
    ]);
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "minimumReleaseAge: 1440\ntrustPolicy: no-downgrade\n",
    );
    writeFileSync(
      join(root, "package.json"),
      '{"name":"c","packageManager":"pnpm@10.34.9"}\n',
    );
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\nname = "u"\n\n[tool.uv]\nexclude-newer = "7 days"\n',
    );
    // npm reads the last line, without its quotes or inline comment.
    writeFileSync(
      join(root, ".npmrc"),
      'min-release-age=0\nmin-release-age = "7" ; a week\n',
    );
    expect(await cooldownGaps(root)).toEqual([]);
    // A cooldown of 0 is none.
    writeFileSync(join(root, ".npmrc"), "min-release-age=0\n");
    expect(await cooldownGaps(root)).toEqual([
      [".npmrc", "npm-min-release-age"],
    ]);
  });

  it("reads each manager's settings where that version of it does", async () => {
    const root = tmp("vk-cooldown-");
    writeFileSync(join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    // pnpm 10 also reads them from .npmrc.
    writeFileSync(
      join(root, "package.json"),
      '{"name":"c","packageManager":"pnpm@10.34.9"}\n',
    );
    writeFileSync(
      join(root, ".npmrc"),
      "minimum-release-age=1440\ntrust-policy=no-downgrade\n",
    );
    expect(await cooldownGaps(root)).toEqual([]);
    // pnpm 11 waits a day unless told 0, and reads no setting from .npmrc.
    writeFileSync(
      join(root, "package.json"),
      '{"name":"c","packageManager":"pnpm@11.9.0"}\n',
    );
    expect(await cooldownGaps(root)).toEqual([
      ["pnpm-lock.yaml", "pnpm-trust-policy"],
    ]);
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "minimumReleaseAge: 0\ntrustPolicy: no-downgrade\n",
    );
    expect(await cooldownGaps(root)).toEqual([
      ["pnpm-workspace.yaml", "pnpm-minimum-release-age"],
    ]);
    // With a uv.toml, uv ignores [tool.uv].
    const uv = tmp("vk-cooldown-");
    writeFileSync(join(uv, "uv.lock"), "version = 1\n");
    writeFileSync(
      join(uv, "pyproject.toml"),
      '[project]\nname = "u"\n\n[tool.uv]\nexclude-newer = "7 days"\n',
    );
    writeFileSync(join(uv, "uv.toml"), "native-tls = true\n");
    expect(await cooldownGaps(uv)).toEqual([["uv.toml", "uv-exclude-newer"]]);
  });

  it("checks each folder with a lockfile, outside the config's ignore", async () => {
    const root = tmp("vk-cooldown-");
    mkdirSync(join(root, "web"));
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "fixtures"));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "web", "package-lock.json"), "{}\n");
    writeFileSync(join(root, "api", "uv.lock"), "version = 1\n");
    writeFileSync(join(root, "fixtures", "package-lock.json"), "{}\n");
    writeFileSync(
      join(root, "node_modules", "dep", "package-lock.json"),
      "{}\n",
    );
    expect(await cooldownGaps(root, ["fixtures/**"])).toEqual([
      ["api/uv.lock", "uv-exclude-newer"],
      ["web/package-lock.json", "npm-min-release-age"],
    ]);
  });

  it("skips a lockfile git ignores, as the scope does", async () => {
    const root = tmp("vk-cooldown-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    // An untracked clone of another project, ignored by the repository.
    writeFileSync(join(root, ".gitignore"), "/tree-sitter-rust/\n");
    mkdirSync(join(root, "tree-sitter-rust"));
    writeFileSync(join(root, "tree-sitter-rust", "package-lock.json"), "{}\n");
    // Untracked, not ignored: a new project folder still counts.
    mkdirSync(join(root, "web"));
    writeFileSync(join(root, "web", "package-lock.json"), "{}\n");
    expect(await cooldownGaps(root)).toEqual([
      ["web/package-lock.json", "npm-min-release-age"],
    ]);
    // An ignored npm lockfile beside the pnpm one is not the project's either.
    writeFileSync(
      join(root, ".gitignore"),
      "/tree-sitter-rust/\npackage-lock.json\n",
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "minimumReleaseAge: 1440\ntrustPolicy: no-downgrade\n",
    );
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    expect(await cooldownGaps(root)).toEqual([]);
    // Checked as a project of its own, the ignored folder is not skipped.
    expect(await cooldownGaps(join(root, "tree-sitter-rust"))).toEqual([
      ["package-lock.json", "npm-min-release-age"],
    ]);
  });

  it("runs where a lockfile shows a manager, and in a changed-file run only when a manifest, lockfile or setting changed", async () => {
    const root = tmp("vk-cooldown-");
    const seed = { cwd: root };
    expect(await cooldown.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    expect(
      await cooldown.expand?.(seed, env(root, { changedPaths: ["src/a.ts"] })),
    ).toEqual([]);
    // No git history here: nothing added to look up.
    const planned = {
      ...seed,
      options: {
        lockfiles: [`${root}/pnpm-lock.yaml`],
        fresh: [],
        dropped: {},
      },
    };
    expect(
      await cooldown.expand?.(
        seed,
        env(root, { changedPaths: ["pnpm-lock.yaml"] }),
      ),
    ).toEqual([planned]);
    expect(await cooldown.expand?.(seed, env(root))).toEqual([planned]);
  });
});

// Recorded 2026-11-03 (go1.26.6, uv 0.11.23 and 0.9.30, actionlint 1.7.12):
// docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
/** `go mod tidy -diff` on a module with one require nothing imports. */
const tidyDiff = (file: string) =>
  `diff current/${file} tidy/${file}\n--- current/${file}\n+++ tidy/${file}\n@@ -1,5 +1,3 @@\n module example.com/p\n \n go 1.26\n-\n-require github.com/google/uuid v1.6.0\n`;

describe("go-mod-tidy", () => {
  it("reports each module file tidy would rewrite, fixable, and nothing when tidy", () => {
    const root = tmp("vk-tidy-");
    const { findings } = goModTidy.parseOutput(
      ran(1, tidyDiff("go.mod") + tidyDiff("go.sum")),
      ctx(root),
    );
    expect(
      findings.map((f) => [f.file, f.ruleId, f.severity, f.fixable]),
    ).toEqual([
      [`${root}/go.mod`, "untidy", "error", true],
      [`${root}/go.sum`, "untidy", "error", true],
    ]);
    expect(goModTidy.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
  });

  it("treats exit 1 without a diff as tidy's own error, named", () => {
    const root = tmp("vk-tidy-");
    expect(() =>
      goModTidy.parseOutput(
        ran(
          1,
          "",
          "go: go.mod file not found in current directory or any parent directory; see 'go help modules'\n",
        ),
        ctx(root),
      ),
    ).toThrow(/go: go\.mod file not found/);
    expect(() => goModTidy.parseOutput(ran(1), ctx(root))).toThrow(
      /output format may have changed|no diff and no error/,
    );
  });

  it("plans a module only where go.mod is, and in a changed run only when its Go or module files changed", () => {
    const root = tmp("vk-tidy-");
    mkdirSync(join(root, "svc"));
    writeFileSync(
      join(root, "svc", "go.mod"),
      "module example.com/svc\n\ngo 1.26\n",
    );
    const seed = { cwd: `${root}/svc` };
    const plan = (changedPaths?: string[]) =>
      goModTidy.expand?.(seed, env(root, changedPaths ? { changedPaths } : {}));
    expect(goModTidy.expand?.({ cwd: root }, env(root))).toEqual([]);
    expect(plan()).toEqual([seed]);
    expect(plan(["svc/main.go"])).toEqual([seed]);
    expect(plan(["svc/go.sum"])).toEqual([seed]);
    expect(plan(["README.md", "other/main.go"])).toEqual([]);
    expect(goModTidy.buildArgs({ ...ctx(root), fix: true }).args).toEqual([
      "mod",
      "tidy",
    ]);
    expect(goModTidy.buildArgs(ctx(root)).args).toEqual([
      "mod",
      "tidy",
      "-diff",
    ]);
    expect(goModTidy.refuseArgs?.(["-e"])).toMatch(/-diff/);
  });
});

describe("uv-lock", () => {
  const stale =
    "Resolved 3 packages in 177ms\nThe lockfile at `uv.lock` needs to be updated, but `--check` was provided. To update the lockfile, run `uv lock`.\n";

  it("reports a stale lock on uv.lock, fixable, and nothing when current", () => {
    const root = tmp("vk-uvlock-");
    const { findings } = uvLock.parseOutput(ran(1, "", stale), ctx(root));
    expect(
      findings.map((f) => [f.file, f.ruleId, f.severity, f.fixable]),
    ).toEqual([[`${root}/uv.lock`, "stale", "error", true]]);
    expect(
      uvLock.parseOutput(ran(0, "", "Resolved 2 packages in 5ms\n"), ctx(root))
        .findings,
    ).toEqual([]);
  });

  it("treats exit 1 that does not name a stale lock as uv's own error", () => {
    const root = tmp("vk-uvlock-");
    expect(() =>
      uvLock.parseOutput(
        ran(
          1,
          "",
          "error: No `pyproject.toml` found in current directory or any parent directory\n",
        ),
        ctx(root),
      ),
    ).toThrow(/No `pyproject.toml` found/);
    expect(() => uvLock.parseOutput(ran(1), ctx(root))).toThrow(
      /output format may have changed|stale/,
    );
  });

  it("plans a project only with both pyproject.toml and uv.lock, and in a changed run only when they changed", () => {
    const root = tmp("vk-uvlock-");
    mkdirSync(join(root, "ml"));
    writeFileSync(
      join(root, "ml", "pyproject.toml"),
      '[project]\nname = "ml"\n',
    );
    const seed = { cwd: `${root}/ml` };
    expect(uvLock.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(join(root, "ml", "uv.lock"), "version = 1\n");
    const plan = (changedPaths?: string[]) =>
      uvLock.expand?.(seed, env(root, changedPaths ? { changedPaths } : {}));
    expect(plan()).toEqual([seed]);
    expect(plan(["ml/pyproject.toml"])).toEqual([seed]);
    expect(plan(["ml/uv.lock"])).toEqual([seed]);
    expect(plan(["ml/train.py", "pyproject.toml"])).toEqual([]);
    expect(uvLock.buildArgs(ctx(root)).args).toEqual([
      "lock",
      "--check",
      "--no-progress",
      "--color",
      "never",
    ]);
    expect(uvLock.buildArgs({ ...ctx(root), fix: true }).args).toEqual([
      "lock",
      "--no-progress",
      "--color",
      "never",
    ]);
    expect(uvLock.refuseArgs?.(["--locked"])).toMatch(/--check/);
  });
});

describe("actionlint", () => {
  const item = {
    message:
      'job "test" needs job "biuld" which does not exist in this workflow',
    filepath: ".github/workflows/ci.yml",
    line: 9,
    column: 3,
    kind: "job-needs",
    snippet: "  test:\n  ^~~~~",
    end_column: 7,
  };

  it("reports each item at its position with the check as the rule, external checks as warnings", () => {
    const root = tmp("vk-actionlint-");
    const { findings } = actionlint.parseOutput(
      ran(
        1,
        JSON.stringify([
          item,
          { ...item, kind: "shellcheck", line: 8, column: 9 },
        ]),
      ),
      ctx(root, { files: [".github/workflows/ci.yml"] }),
    );
    expect(
      findings.map((f) => [f.ruleId, f.line, f.col, f.endCol, f.severity]),
    ).toEqual([
      ["job-needs", 9, 3, 7, "error"],
      ["shellcheck", 8, 9, 7, "warning"],
    ]);
    expect(findings[0]).toMatchObject({
      file: `${root}/.github/workflows/ci.yml`,
      message: item.message,
      fixable: false,
    });
    expect(actionlint.parseOutput(ran(0, "[]"), ctx(root)).findings).toEqual(
      [],
    );
    expect(() => actionlint.parseOutput(ran(1, "[]"), ctx(root))).toThrow(
      /output format may have changed/,
    );
    expect(() =>
      actionlint.parseOutput(
        ran(1, JSON.stringify([{ message: "x" }])),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
  });

  it("runs where the project chose it, naming the workflow files, only the changed ones in a changed run", () => {
    const root = tmp("vk-actionlint-");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    writeFileSync(
      join(root, ".github", "workflows", "release.yaml"),
      "on: push\n",
    );
    writeFileSync(join(root, ".github", "workflows", "notes.txt"), "");
    const seed = { cwd: root };
    expect(actionlint.expand?.(seed, env(root))).toEqual([]);
    const chosen = env(root, { toolConfig: { enabled: true } });
    expect(actionlint.expand?.(seed, chosen)).toEqual([
      {
        cwd: root,
        files: [".github/workflows/ci.yml", ".github/workflows/release.yaml"],
      },
    ]);
    expect(
      actionlint.expand?.(seed, {
        ...chosen,
        changedPaths: [".github/workflows/release.yaml", "src/a.ts"],
      }),
    ).toEqual([{ cwd: root, files: [".github/workflows/release.yaml"] }]);
    expect(
      actionlint.expand?.(seed, { ...chosen, changedPaths: ["src/a.ts"] }),
    ).toEqual([]);
    writeFileSync(
      join(root, ".github", "actionlint.yaml"),
      "self-hosted-runner:\n  labels: []\n",
    );
    expect(actionlint.expand?.(seed, env(root))).toHaveLength(1);
    expect(
      actionlint.buildArgs(
        ctx(root, {
          files: [".github/workflows/ci.yml"],
          configPath: `${root}/.github/actionlint.yaml`,
        }),
      ).args,
    ).toEqual([
      "-no-color",
      "-format",
      "{{json .}}",
      "-config-file",
      `${root}/.github/actionlint.yaml`,
      ".github/workflows/ci.yml",
    ]);
    expect(actionlint.refuseArgs?.(["-oneline"])).toMatch(/-format/);
  });
});

// Recorded 2026-11-03 (sherif 1.13.0, shfmt 3.14.1, editorconfig-checker
// 4.0.2, cargo-shear 1.14.0): sota-2026-11-03/recorded.md.
describe("sherif", () => {
  const report = [
    "",
    "3 issues found in ./package.json:",
    "",
    " ⨯ error The root package.json should be private to prevent accidentaly publishing it to a registry. root-package-private-field",
    "  │ {",
    " ⚠️ warning The root package.json is private and should only have devDependencies. Declare dependencies in each package. root-package-dependencies",
    "",
    "1 issue found in ./packages/a/package.json:",
    "",
    " ⨯ error dependencies should be ordered alphabetically. unordered-dependencies",
    "",
    "1 issue found in ./:",
    "",
    " ⨯ error Dependency react has multiple versions defined in the workspace. multiple-dependency-versions",
    "  ./packages",
    "",
  ].join("\n");

  it("reports each issue on its manifest, dependency rules on the dependencies line, `./` as the root", () => {
    const root = tmp("vk-sherif-");
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{\n  "name": "root",\n  "dependencies": {}\n}\n',
    );
    writeFileSync(
      join(root, "packages", "a", "package.json"),
      '{\n  "name": "a",\n  "version": "0",\n  "dependencies": {}\n}\n',
    );
    const { findings } = sherif.parseOutput(ran(1, report), ctx(root));
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["package.json", 1, "root-package-private-field", "error"],
      ["package.json", 3, "root-package-dependencies", "warning"],
      ["packages/a/package.json", 4, "unordered-dependencies", "error"],
      ["package.json", 3, "multiple-dependency-versions", "error"],
    ]);
    expect(
      sherif.parseOutput(ran(0, "\n✓ No issues found\n"), ctx(root)).findings,
    ).toEqual([]);
    expect(() => sherif.parseOutput(ran(1, ""), ctx(root))).toThrow(
      /output format may have changed/,
    );
  });

  it("runs only in a workspace that chose it, and in a changed run only when a manifest changed", () => {
    const root = tmp("vk-sherif-");
    writeFileSync(
      join(root, "package.json"),
      '{"name":"root","devDependencies":{"sherif":"1.13.0"}}\n',
    );
    const seed = { cwd: root };
    expect(sherif.expand?.(seed, env(root))).toEqual([]);
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    expect(sherif.expand?.(seed, env(root))).toEqual([seed]);
    expect(
      sherif.expand?.(
        seed,
        env(root, { changedPaths: ["packages/a/package.json"] }),
      ),
    ).toEqual([seed]);
    expect(
      sherif.expand?.(seed, env(root, { changedPaths: ["src/a.ts"] })),
    ).toEqual([]);
    writeFileSync(join(root, "package.json"), '{"name":"root"}\n');
    expect(sherif.expand?.(seed, env(root))).toEqual([]);
    expect(
      sherif.expand?.(seed, env(root, { toolConfig: { enabled: true } })),
    ).toEqual([seed]);
    const built = sherif.buildArgs(ctx(root));
    expect(built.args).toEqual([]);
    expect(built.env).toEqual({ CI: "1" });
    expect(sherif.refuseArgs?.(["--fix"])).toMatch(/rewrites/);
  });
});

describe("shfmt", () => {
  it("lists each unformatted file as a fixable warning and a parse error at its line", () => {
    const root = tmp("vk-shfmt-");
    const { findings } = shfmt.parseOutput(
      ran(1, "bad.sh\n", "broken.sh:2:1: `foo(` must be followed by `)`\n"),
      ctx(root, { files: ["bad.sh", "broken.sh", "good.sh"] }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
        f.severity,
        f.fixable,
      ]),
    ).toEqual([
      ["broken.sh", 2, 1, "parse", "error", false],
      ["bad.sh", 1, 1, "unformatted", "warning", true],
    ]);
    expect(shfmt.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
    expect(() =>
      shfmt.parseOutput(
        ran(1, "", "lstat nope.sh: no such file or directory\n"),
        ctx(root),
      ),
    ).toThrow(/lstat nope.sh/);
    expect(() => shfmt.parseOutput(ran(1), ctx(root))).toThrow(
      /output format may have changed/,
    );
  });

  it("runs where the project chose it, -l to check and -w to fix, on the shell files", () => {
    const root = tmp("vk-shfmt-");
    const seed = { cwd: root };
    expect(shfmt.expand?.(seed, env(root))).toEqual([]);
    expect(
      shfmt.expand?.(seed, env(root, { toolConfig: { enabled: true } })),
    ).toEqual([seed]);
    writeFileSync(join(root, "justfile"), "fmt:\n\tshfmt -l scripts\n");
    expect(shfmt.expand?.(seed, env(root))).toEqual([seed]);
    expect(
      shfmt.buildArgs(ctx(root, { files: ["a.sh", "b.ts"] })).args,
    ).toEqual(["-l", "a.sh"]);
    expect(
      shfmt.buildArgs({ ...ctx(root, { files: ["a.sh"] }), fix: true }).args,
    ).toEqual(["-w", "a.sh"]);
    expect(shfmt.refuseArgs?.(["-d"])).toMatch(/-l and -w/);
  });
});

describe("editorconfig-checker", () => {
  const gcc = [
    "Dockerfile:0:0: error: wrong line endings or no final newline",
    "Dockerfile:2:0: error: trailing whitespace",
    "Dockerfile:2:0: error: wrong indent style found (tabs instead of spaces)",
    "vendor/x.txt:1:0: error: trailing whitespace",
    "",
    "4 errors found",
    "",
  ].join("\n");

  it("reports each gcc line with a rule from its message, line 0 as line 1, outside the kit's ignore and within a changed run", () => {
    const root = tmp("vk-ecc-");
    const { findings } = editorconfigChecker.parseOutput(
      ran(1, gcc),
      ctx(root, { options: { ignore: ["vendor/**"] } }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["Dockerfile", 1, "final-newline", "error"],
      ["Dockerfile", 2, "trailing-whitespace", "error"],
      ["Dockerfile", 2, "indent-style", "error"],
    ]);
    const changed = editorconfigChecker.parseOutput(
      ran(1, gcc),
      ctx(root, { options: { ignore: [], only: ["vendor/x.txt"] } }),
    );
    expect(changed.findings.map((f) => f.file.slice(root.length + 1))).toEqual([
      "vendor/x.txt",
    ]);
    expect(
      editorconfigChecker.parseOutput(
        ran(0),
        ctx(root, { options: { ignore: [] } }),
      ).findings,
    ).toEqual([]);
    expect(() =>
      editorconfigChecker.parseOutput(
        ran(
          1,
          "resolving nope.txt: stat nope.txt: no such file or directory\n",
        ),
        ctx(root, { options: { ignore: [] } }),
      ),
    ).toThrow(/resolving nope.txt/);
    expect(() =>
      editorconfigChecker.parseOutput(
        ran(1),
        ctx(root, { options: { ignore: [] } }),
      ),
    ).toThrow(/output format may have changed/);
  });

  it("runs only with an .editorconfig and a choice, carrying the kit's ignore and the changed files", () => {
    const root = tmp("vk-ecc-");
    const seed = { cwd: root };
    const chosen = env(root, {
      toolConfig: { enabled: true },
      config: { ignore: ["dist/**"] },
    } as Partial<PlanEnv>);
    expect(editorconfigChecker.expand?.(seed, chosen)).toEqual([]);
    writeFileSync(join(root, ".editorconfig"), "root = true\n");
    expect(editorconfigChecker.expand?.(seed, env(root))).toEqual([]);
    expect(editorconfigChecker.expand?.(seed, chosen)).toEqual([
      { cwd: root, options: { ignore: ["dist/**"] } },
    ]);
    expect(
      editorconfigChecker.expand?.(seed, {
        ...chosen,
        changedPaths: ["a/b.txt"],
      }),
    ).toEqual([
      { cwd: root, options: { ignore: ["dist/**"], only: ["a/b.txt"] } },
    ]);
    expect(
      editorconfigChecker.expand?.(seed, { ...chosen, changedPaths: [] }),
    ).toEqual([]);
    writeFileSync(join(root, ".editorconfig-checker.json"), "{}\n");
    expect(editorconfigChecker.expand?.(seed, env(root))).toHaveLength(1);
    expect(
      editorconfigChecker.buildArgs(ctx(root, { configPath: `${root}/.ecrc` }))
        .args,
    ).toEqual(["-format", "gcc", "-no-color", "-config", `${root}/.ecrc`]);
    expect(editorconfigChecker.refuseArgs?.(["-fix"])).toMatch(/rewrites/);
  });
});

/** cargo-shear's JSON with the given findings. */
const shearReport = (findings: unknown[]) =>
  JSON.stringify({ summary: {}, findings });

describe("cargo-shear", () => {
  it("reports an unused dependency on its Cargo.toml line and each unlinked file on itself", () => {
    const root = tmp("vk-shear-");
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\nitoa = "1"\n',
    );
    const { findings } = cargoShear.parseOutput(
      ran(
        1,
        shearReport([
          {
            code: "shear/unused_dependency",
            severity: "error",
            message: "unused dependency `serde`",
            file: "Cargo.toml",
            location: { offset: 72, length: 5 },
            help: "remove this dependency",
            fixable: true,
          },
          {
            code: "shear/unlinked_files",
            severity: "warning",
            message: "1 unlinked file in `p`\nsrc/orphan.rs",
            help: "delete this file",
            fixable: false,
          },
          {
            code: "shear/misplaced_dependency",
            severity: "warning",
            message: "`itoa` is only used in tests",
          },
        ]),
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
        f.fixable,
      ]),
    ).toEqual([
      ["Cargo.toml", 7, "unused_dependency", "error", false],
      ["src/orphan.rs", 1, "unlinked_files", "warning", false],
      ["Cargo.toml", 8, "misplaced_dependency", "warning", false],
    ]);
    expect(findings[0]?.message).toBe(
      "unused dependency `serde`: remove this dependency",
    );
    expect(
      cargoShear.parseOutput(ran(0, shearReport([])), ctx(root)).findings,
    ).toEqual([]);
    expect(() =>
      cargoShear.parseOutput(ran(1, shearReport([])), ctx(root)),
    ).toThrow(/output format may have changed/);
    expect(() =>
      cargoShear.parseOutput(
        ran(1, "", "error: unexpected argument '--bogus'\n"),
        ctx(root),
      ),
    ).toThrow(/no JSON output/);
  });

  it("runs where a cargo-shear table or a step chose it, with JSON output only", () => {
    const root = tmp("vk-shear-");
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "p"\n');
    expect(cargoShear.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "p"\n\n[package.metadata.cargo-shear]\nignored = ["serde"]\n',
    );
    expect(cargoShear.adoptedAt?.(root, root)).toBe(true);
    expect(cargoShear.buildArgs(ctx(root)).args).toEqual(["--format=json"]);
    expect(cargoShear.refuseArgs?.(["--fix"])).toMatch(/rewrites/);
    expect(cargoShear.tier).toBe("verify");
  });
});

// Recorded 2026-11-03 (spectral 6.17.0): sota-2026-11-03/recorded.md.
/** One spectral item as 6.17.0 prints it. */
const specItem = (
  code: string,
  severity: number,
  line: number,
  source: string,
) => ({
  code,
  path: ["info"],
  message: `${code} says so`,
  severity,
  range: {
    start: { line, character: 5 },
    end: { line: line + 2, character: 16 },
  },
  source,
});

describe("spectral", () => {
  it("reports each item at its 1-based position with spectral's severity scale", () => {
    const root = tmp("vk-spectral-");
    const spec = `${root}/openapi.yaml`;
    const { findings } = spectral.parseOutput(
      ran(
        1,
        JSON.stringify([
          specItem("oas3-api-servers", 1, 0, spec),
          specItem("oas3-schema", 0, 4, spec),
          specItem("info-license", 3, 1, spec),
        ]),
      ),
      ctx(root, { files: ["openapi.yaml"] }),
    );
    expect(
      findings.map((f) => [
        f.file,
        f.line,
        f.col,
        f.endLine,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      [spec, 1, 6, 3, "oas3-api-servers", "warning"],
      [spec, 5, 6, 7, "oas3-schema", "error"],
      [spec, 2, 6, 4, "info-license", "info"],
    ]);
    expect(spectral.parseOutput(ran(0, "[]"), ctx(root)).findings).toEqual([]);
    expect(() => spectral.parseOutput(ran(1, "[]"), ctx(root))).toThrow(
      /output format may have changed/,
    );
    expect(() =>
      spectral.parseOutput(
        ran(1, "", "spectral lint [documents..]\n"),
        ctx(root),
      ),
    ).toThrow(/no JSON output/);
    expect(() =>
      spectral.parseOutput(ran(0, JSON.stringify([{ code: "x" }])), ctx(root)),
    ).toThrow(/output format may have changed/);
  });

  it("runs where a ruleset is, on the API documents it finds or apiDiff names, the changed ones in a changed run", () => {
    const root = tmp("vk-spectral-");
    mkdirSync(join(root, "api"));
    writeFileSync(
      join(root, "api", "openapi.yaml"),
      "openapi: 3.0.3\ninfo:\n  title: x\n",
    );
    writeFileSync(
      join(root, "api", "events.json"),
      '{\n  "asyncapi": "2.6.0"\n}\n',
    );
    writeFileSync(join(root, "api", "other.yaml"), "name: not an api\n");
    const scoped = [
      "api/openapi.yaml",
      "api/events.json",
      "api/other.yaml",
    ].map((f) => `${root}/${f}`);
    const seed = { cwd: root };
    const plan = (more: Partial<PlanEnv> = {}) =>
      spectral.expand?.(
        seed,
        env(root, {
          scopedFiles: scoped,
          config: { ignore: [], apiDiff: { specs: [] }, tools: {} },
          ...more,
        } as Partial<PlanEnv>),
      );
    expect(plan()).toEqual([]);
    expect(
      (plan({ toolConfig: { enabled: true } }) as TaskSeed[])[0]?.cannotRun,
    ).toMatch(/without a ruleset/);
    writeFileSync(join(root, ".spectral.yaml"), 'extends: ["spectral:oas"]\n');
    expect(plan()).toEqual([
      { cwd: root, files: ["api/events.json", "api/openapi.yaml"] },
    ]);
    expect(plan({ changedPaths: ["api/openapi.yaml", "src/a.ts"] })).toEqual([
      { cwd: root, files: ["api/openapi.yaml"] },
    ]);
    expect(plan({ changedPaths: ["src/a.ts"] })).toEqual([]);
    expect(
      plan({
        config: {
          ignore: [],
          apiDiff: { specs: ["api/openapi.yaml"] },
          tools: {},
        },
      } as unknown as Partial<PlanEnv>),
    ).toEqual([{ cwd: root, files: ["api/openapi.yaml"] }]);
    expect(
      spectral.buildArgs(
        ctx(root, {
          files: ["api/openapi.yaml"],
          configPath: `${root}/.spectral.yaml`,
        }),
      ).args,
    ).toEqual([
      "lint",
      "-f",
      "json",
      "-q",
      "--ruleset",
      `${root}/.spectral.yaml`,
      "api/openapi.yaml",
    ]);
    expect(
      plan({
        config: {
          ignore: [],
          apiDiff: { specs: [] },
          tools: { spectral: { options: { documents: ["api/spec.json"] } } },
        },
      } as unknown as Partial<PlanEnv>),
    ).toEqual([{ cwd: root, files: ["api/spec.json"] }]);
    expect(spectral.refuseArgs?.(["-f", "stylish"])).toMatch(/kit's/);
  });
});

// Recorded 2026-11-03 (forge 1.8.5, agnix 0.60.3): sota-2026-11-03/recorded.md.
/** One `forge lint --json` line, trimmed to what the adapter reads. */
const forgeLine = (code: string, level: string, line: number, col: number) =>
  JSON.stringify({
    $message_type: "diagnostic",
    message: `${code} says so`,
    code: { code, explanation: null },
    level,
    spans: [
      {
        file_name: "src/counter.sol",
        line_start: line,
        line_end: line,
        column_start: col,
        column_end: col + 5,
        is_primary: true,
      },
    ],
    children: [
      { message: `https://getfoundry.sh/forge/linting/${code}`, level: "help" },
    ],
  });

describe("forge-lint", () => {
  it("reports each diagnostic at its primary span with forge's level, note as info", () => {
    const root = tmp("vk-forge-lint-");
    const { findings } = forgeLint.parseOutput(
      ran(
        0,
        [
          forgeLine("mixed-case-variable", "note", 5, 20),
          forgeLine("incorrect-shift", "error", 9, 21),
          forgeLine("divide-before-multiply", "warning", 10, 3),
          "",
        ].join("\n"),
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.endCol,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["src/counter.sol", 5, 20, 25, "mixed-case-variable", "info"],
      ["src/counter.sol", 9, 21, 26, "incorrect-shift", "error"],
      ["src/counter.sol", 10, 3, 8, "divide-before-multiply", "warning"],
    ]);
    expect(findings[0]?.url).toBe(
      "https://getfoundry.sh/forge/linting/mixed-case-variable",
    );
    expect(forgeLint.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
    expect(() =>
      forgeLint.parseOutput(ran(0, "not json\n"), ctx(root)),
    ).toThrow(/output format may have changed/);
    expect(() =>
      forgeLint.parseOutput(
        ran(0, JSON.stringify({ $message_type: "diagnostic", message: "x" })),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
  });

  it("runs where a foundry.toml is, with --json only", () => {
    const root = tmp("vk-forge-lint-");
    expect(forgeLint.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "foundry.toml"),
      '[profile.default]\nsrc = "src"\n',
    );
    expect(forgeLint.adoptedAt?.(root, root)).toBe(true);
    expect(forgeLint.buildArgs(ctx(root)).args).toEqual(["lint", "--json"]);
    expect(forgeLint.refuseArgs?.(["--deny", "notes"])).toMatch(/--deny/);
  });
});

/** agnix's JSON with the given diagnostics. */
const agnixReport = (diagnostics: unknown[]) =>
  JSON.stringify({
    version: "0.60.3",
    files_checked: 3,
    diagnostics,
    summary: {},
  });
/** One agnix diagnostic as 0.60.3 prints it. */
const agnixItem = (
  level: string,
  rule: string,
  file: string,
  message: string,
  suggestion = "",
) => ({
  level,
  rule,
  file,
  line: 1,
  column: 1,
  message,
  suggestion,
  category: "x",
  rule_severity: "HIGH",
});

describe("agnix", () => {
  it("reports each diagnostic on its file, with agnix's level, the project's own note on AGENTS.md", () => {
    const root = tmp("vk-agnix-");
    const { findings } = agnix.parseOutput(
      ran(
        1,
        agnixReport([
          agnixItem(
            "error",
            "CC-HK-016",
            ".claude/settings.json",
            "Unknown hook type 'shell' at hooks.OnStop[0].hooks[0]",
          ),
          agnixItem(
            "error",
            "MCP-024",
            ".mcp.json",
            "Server 'x' has an empty configuration object",
            "Add a command or url",
          ),
          agnixItem("info", "VER-001", "", "No tool or spec versions pinned."),
          agnixItem(
            "warning",
            "AGM-004",
            root,
            "Root AGENTS.md has no project overview",
          ),
        ]),
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      [".claude/settings.json", "CC-HK-016", "error"],
      [".mcp.json", "MCP-024", "error"],
      ["AGENTS.md", "VER-001", "info"],
      ["AGENTS.md", "AGM-004", "warning"],
    ]);
    expect(findings[1]?.message).toBe(
      "Server 'x' has an empty configuration object (Add a command or url)",
    );
    expect(
      agnix.parseOutput(ran(0, agnixReport([])), ctx(root)).findings,
    ).toEqual([]);
    expect(() => agnix.parseOutput(ran(1, agnixReport([])), ctx(root))).toThrow(
      /output format may have changed/,
    );
    expect(() =>
      agnix.parseOutput(
        ran(2, "", "error: unexpected argument '--bogus'\n"),
        ctx(root),
      ),
    ).toThrow(/no JSON output/);
  });

  it("runs where the project chose it, on the project's own agent files, in a changed run only when one changed", () => {
    const root = tmp("vk-agnix-");
    const seed = { cwd: root };
    const chosen = env(root, { toolConfig: { enabled: true } });
    expect(agnix.expand?.(seed, chosen)).toEqual([]);
    writeFileSync(join(root, "CLAUDE.md"), "# Project\n");
    mkdirSync(join(root, ".claude", "worktrees", "other"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    writeFileSync(
      join(root, ".claude", "worktrees", "other", "AGENTS.md"),
      "x\n",
    );
    expect(agnix.expand?.(seed, env(root))).toEqual([]);
    expect(agnix.expand?.(seed, chosen)).toEqual([
      { cwd: root, files: ["CLAUDE.md", ".claude/settings.json"] },
    ]);
    expect(
      agnix.expand?.(seed, {
        ...chosen,
        changedPaths: [".claude/settings.json"],
      }),
    ).toHaveLength(1);
    expect(
      agnix.expand?.(seed, { ...chosen, changedPaths: ["src/a.ts"] }),
    ).toEqual([]);
    writeFileSync(join(root, ".agnix.toml"), "");
    expect(agnix.expand?.(seed, env(root))).toHaveLength(1);
    expect(
      agnix.buildArgs(
        ctx(root, {
          files: ["CLAUDE.md", ".claude/settings.json"],
          configPath: `${root}/.agnix.toml`,
        }),
      ).args,
    ).toEqual([
      "--format",
      "json",
      "--config",
      `${root}/.agnix.toml`,
      "CLAUDE.md",
      ".claude/settings.json",
    ]);
    expect(agnix.refuseArgs?.(["--fix"])).toMatch(/rewrites/);
  });
});

// Recorded 2026-11-03 (Error Prone 2.52.0 under Maven 3.10.0, JDK 21): sota-2026-11-03/recorded.md.
/** One javac diagnostic as Maven -B prints it. */
const javacDiag = (rule: string, message: string, level = "ERROR") =>
  `[${level}] /p/src/main/java/app/Main.java:[13,17] ${level.toLowerCase()}: [${rule}] ${message}`;

describe("error-prone", () => {
  it("reports each javac diagnostic once, with its bug pattern as the rule", () => {
    const { findings } = errorProne.parseOutput(
      ran(
        1,
        [
          "[INFO] Compiling 1 source file with javac [debug release 21] to target/classes",
          javacDiag(
            "CollectionIncompatibleType",
            "Argument '42' should not be passed to this method",
          ),
          "[ERROR]     (see https://errorprone.info/bugpattern/CollectionIncompatibleType)",
          javacDiag(
            "ReturnValueIgnored",
            "Return value of 'contains' must be used",
          ),
          javacDiag(
            "UnusedVariable",
            "The local variable 'n' is never read",
            "WARNING",
          ),
          "[ERROR] COMPILATION ERROR : ",
          javacDiag(
            "CollectionIncompatibleType",
            "Argument '42' should not be passed to this method",
          ),
          javacDiag(
            "ReturnValueIgnored",
            "Return value of 'contains' must be used",
          ),
          "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.0:compile (default-compile) on project app: Compilation failure",
        ].join("\n"),
      ),
      ctx("/p"),
    );
    expect(
      findings.map((f) => [f.file, f.line, f.col, f.ruleId, f.severity]),
    ).toEqual([
      [
        "/p/src/main/java/app/Main.java",
        13,
        17,
        "CollectionIncompatibleType",
        "error",
      ],
      ["/p/src/main/java/app/Main.java", 13, 17, "ReturnValueIgnored", "error"],
      ["/p/src/main/java/app/Main.java", 13, 17, "UnusedVariable", "warning"],
    ]);
    expect(findings[0]?.url).toBe(
      "https://errorprone.info/bugpattern/CollectionIncompatibleType",
    );
    expect(
      errorProne.parseOutput(ran(0, "[INFO] BUILD SUCCESS\n"), ctx("/p"))
        .findings,
    ).toEqual([]);
    expect(() =>
      errorProne.parseOutput(
        ran(
          1,
          "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.0:compile (default-compile) on project app: Fatal error compiling\n",
        ),
        ctx("/p"),
      ),
    ).toThrow(
      /failed without an Error Prone diagnostic.*Fatal error compiling/,
    );
    expect(() => errorProne.parseOutput(ran(1), ctx("/p"))).toThrow(
      /output format may have changed/,
    );
  });

  it("runs where the pom declares Error Prone, the project's own compile, in the verify tier", () => {
    const root = tmp("vk-error-prone-");
    writeFileSync(
      join(root, "pom.xml"),
      "<project><artifactId>app</artifactId></project>\n",
    );
    expect(errorProne.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "pom.xml"),
      "<project><annotationProcessorPaths><path><artifactId>error_prone_core</artifactId></path></annotationProcessorPaths></project>\n",
    );
    expect(errorProne.adoptedAt?.(root, root)).toBe(true);
    expect(errorProne.buildArgs(ctx(root)).args).toEqual(["-B", "compile"]);
    expect(errorProne.refuseArgs?.(["-q"])).toMatch(/hides/);
    expect(errorProne.tier).toBe("verify");
  });
});

// Recorded 2026-11-03 (check-jsonschema 0.39.0): sota-2026-11-03/recorded.md.
/** check-jsonschema's `-o json` with the given errors. */
const schemaReport = (errors: unknown[], parse_errors: unknown[] = []) =>
  JSON.stringify({
    status: errors.length + parse_errors.length ? "fail" : "ok",
    errors,
    parse_errors,
  });

describe("check-jsonschema", () => {
  it("reports each error on its file at the line of the path's last key, parse errors too", () => {
    const root = tmp("vk-jsonschema-");
    writeFileSync(
      join(root, "renovate.json"),
      '{\n  "extends": ["config:recommended"],\n  "schedule": "before 5am",\n  "lockFileMaintenance": { "enabled": "yes" }\n}\n',
    );
    writeFileSync(
      join(root, "compose.yaml"),
      "services:\n  api:\n    image: node:22\n    ports: 3001\n",
    );
    const { findings } = checkJsonschema.parseOutput(
      ran(
        1,
        schemaReport(
          [
            {
              filename: "renovate.json",
              path: "$.lockFileMaintenance.enabled",
              message: "'yes' is not of type 'boolean'",
              has_sub_errors: false,
            },
            {
              filename: "compose.yaml",
              path: "$.services.api.ports",
              message: "3001 is not of type 'array'",
              has_sub_errors: false,
            },
          ],
          [{ filename: "broken.yaml", message: "Failed to parse broken.yaml" }],
        ),
      ),
      ctx(root, {
        options: {
          schema: "vendor.renovate",
          files: ["renovate.json", "compose.yaml", "broken.yaml"],
        },
      }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["renovate.json", 4, "renovate", "error"],
      ["compose.yaml", 4, "renovate", "error"],
      ["broken.yaml", 1, "parse", "error"],
    ]);
    expect(findings[0]?.message).toBe(
      "$.lockFileMaintenance.enabled: 'yes' is not of type 'boolean'",
    );
    const task = { schema: "vendor.renovate", files: ["renovate.json"] };
    expect(
      checkJsonschema.parseOutput(
        ran(0, schemaReport([])),
        ctx(root, { options: task }),
      ).findings,
    ).toEqual([]);
    expect(() =>
      checkJsonschema.parseOutput(
        ran(1, schemaReport([])),
        ctx(root, { options: task }),
      ),
    ).toThrow(/output format may have changed/);
    expect(() =>
      checkJsonschema.parseOutput(
        ran(1, "", "Traceback (most recent call last):\n"),
        ctx(root, { options: task }),
      ),
    ).toThrow(/no JSON output/);
  });

  it("plans one task per bundled schema for the files it names, the project's own pairs first, only the changed ones in a changed run", () => {
    const root = tmp("vk-jsonschema-");
    mkdirSync(join(root, ".github"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "renovate.json"), "{}\n");
    writeFileSync(join(root, ".github", "dependabot.yml"), "version: 2\n");
    writeFileSync(join(root, "schemas", "thing.schema.json"), "{}\n");
    writeFileSync(join(root, "schemas", "own.json"), "{}\n");
    const scoped = [
      "schemas/thing.schema.json",
      "schemas/own.json",
      "README.md",
    ].map((f) => `${root}/${f}`);
    const seed = { cwd: root };
    const plan = (more: Partial<PlanEnv> = {}) =>
      checkJsonschema.expand?.(
        seed,
        env(root, {
          scopedFiles: scoped,
          config: { ignore: [], tools: {} },
          ...more,
        } as unknown as Partial<PlanEnv>),
      ) as TaskSeed[];
    expect(plan().map((t) => t.options)).toEqual([
      { schema: "vendor.renovate", files: ["renovate.json"] },
      { schema: "vendor.dependabot", files: [".github/dependabot.yml"] },
      { schema: "metaschema", files: ["schemas/thing.schema.json"] },
    ]);
    expect(
      plan({ changedPaths: ["renovate.json", "src/a.ts"] }).map(
        (t) => t.options,
      ),
    ).toEqual([{ schema: "vendor.renovate", files: ["renovate.json"] }]);
    expect(plan({ changedPaths: ["src/a.ts"] })).toEqual([]);
    expect(
      plan({
        config: {
          ignore: ["schemas/**"],
          tools: {
            "check-jsonschema": {
              options: {
                schemas: [
                  {
                    files: ["schemas/own.json"],
                    schema: "schemas/thing.schema.json",
                  },
                ],
              },
            },
          },
        },
      } as unknown as Partial<PlanEnv>).map((t) => t.options),
    ).toEqual([
      { schema: "vendor.renovate", files: ["renovate.json"] },
      { schema: "vendor.dependabot", files: [".github/dependabot.yml"] },
    ]);
    expect(
      plan({
        config: {
          ignore: [],
          tools: {
            "check-jsonschema": {
              options: {
                schemas: [
                  {
                    files: ["schemas/own.json"],
                    schema: "schemas/thing.schema.json",
                  },
                ],
              },
            },
          },
        },
      } as unknown as Partial<PlanEnv>)[0]?.options,
    ).toEqual({
      schema: "schemas/thing.schema.json",
      files: ["schemas/own.json"],
    });
    expect(
      checkJsonschema.buildArgs(
        ctx(root, {
          options: { schema: "vendor.renovate", files: ["renovate.json"] },
        }),
      ).args,
    ).toEqual([
      "-o",
      "json",
      "--builtin-schema",
      "vendor.renovate",
      "renovate.json",
    ]);
    expect(
      checkJsonschema.buildArgs(
        ctx(root, {
          options: { schema: "metaschema", files: ["a.schema.json"] },
        }),
      ).args,
    ).toEqual(["-o", "json", "--check-metaschema", "a.schema.json"]);
    expect(
      checkJsonschema.buildArgs(
        ctx(root, { options: { schema: "schemas/x.json", files: ["a.json"] } }),
      ).args,
    ).toEqual(["-o", "json", "--schemafile", "schemas/x.json", "a.json"]);
    expect(checkJsonschema.refuseArgs?.(["--schemafile", "x"])).toMatch(
      /kit's/,
    );
  });
});

// Recorded 2026-11-03 (sobelow 0.18.1, periphery 3.8.0, composer-dependency-analyser 1.8.4,
// Infection 0.35.9 with pcov, Stryker.NET 5.0.0): sota-2026-11-03/recorded.md.
describe("sobelow", () => {
  const report = JSON.stringify({
    findings: {
      high_confidence: [
        {
          line: 8,
          type: "Traversal.SendFile: Directory Traversal in `send_file`",
          file: "lib/demo_web/controllers/page_controller.ex",
          variable: "path",
        },
      ],
      low_confidence: [
        {
          line: 5,
          type: "DOS.StringToAtom: Unsafe `String.to_atom`",
          file: "lib/demo_web/controllers/page_controller.ex",
          variable: "name",
        },
      ],
      medium_confidence: [],
    },
    sobelow_version: "0.18.1",
    total_findings: 2,
  });

  it("reports each finding at its line with the check as the rule and the confidence as the weight", () => {
    const root = tmp("vk-sobelow-");
    const { findings } = sobelow.parseOutput(ran(0, report), ctx(root));
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      [
        "lib/demo_web/controllers/page_controller.ex",
        8,
        "Traversal.SendFile",
        "error",
      ],
      [
        "lib/demo_web/controllers/page_controller.ex",
        5,
        "DOS.StringToAtom",
        "info",
      ],
    ]);
    expect(findings[1]?.message).toBe("Unsafe `String.to_atom` (from `name`)");
    expect(
      sobelow.parseOutput(
        ran(
          0,
          JSON.stringify({
            findings: {
              high_confidence: [],
              medium_confidence: [],
              low_confidence: [],
            },
            total_findings: 0,
          }),
        ),
        ctx(root),
      ).findings,
    ).toEqual([]);
    expect(() =>
      sobelow.parseOutput(
        ran(0, JSON.stringify({ total_findings: 0 })),
        ctx(root),
      ),
    ).toThrow(/output format may have changed/);
    expect(() =>
      sobelow.parseOutput(ran(1, "", "Invalid option\n"), ctx(root)),
    ).toThrow(/no JSON output/);
  });

  it("runs where mix.exs declares it or a .sobelow-conf is, JSON only", () => {
    const root = tmp("vk-sobelow-");
    writeFileSync(
      join(root, "mix.exs"),
      'defmodule Demo.MixProject do\n  def deps, do: [{:phoenix, "~> 1.7"}]\nend\n',
    );
    expect(sobelow.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "mix.exs"),
      'defmodule Demo.MixProject do\n  def deps, do: [{:phoenix, "~> 1.7"}, {:sobelow, "~> 0.18", only: [:dev, :test], runtime: false}]\nend\n',
    );
    expect(sobelow.adoptedAt?.(root, root)).toBe(true);
    expect(sobelow.buildArgs(ctx(root)).args).toEqual(["--format", "json"]);
    expect(sobelow.refuseArgs?.(["--exit", "low"])).toMatch(/kit's/);
  });
});

/** One periphery result as 3.8.0 prints it. */
const peripheryItem = (
  kind: string,
  name: string,
  location: string,
  hints = ["unused"],
) => ({
  kind,
  name,
  hints,
  location,
  accessibility: "internal",
  modules: ["Demo"],
  modifiers: [],
  ids: ["x"],
  attributes: [],
});

describe("periphery", () => {
  it("reports each result at its location as a warning, with the hint as the rule", () => {
    const root = tmp("vk-periphery-");
    const { findings } = periphery.parseOutput(
      ran(
        0,
        JSON.stringify([
          peripheryItem(
            "function.method.instance",
            "unusedInternal()",
            `${root}/Sources/Demo/Demo.swift:4:10`,
          ),
          peripheryItem(
            "function.free",
            "orphanFunction()",
            `${root}/Sources/Demo/Demo.swift:8:6`,
          ),
          peripheryItem(
            "var.instance",
            "count",
            `${root}/Sources/Demo/Demo.swift:2:9`,
            ["assignOnlyProperty"],
          ),
        ]),
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
        f.message,
      ]),
    ).toEqual([
      [
        "Sources/Demo/Demo.swift",
        4,
        10,
        "unused",
        "Unused method 'unusedInternal()'",
      ],
      [
        "Sources/Demo/Demo.swift",
        8,
        6,
        "unused",
        "Unused function 'orphanFunction()'",
      ],
      [
        "Sources/Demo/Demo.swift",
        2,
        9,
        "assignOnlyProperty",
        "assignOnlyProperty: var 'count'",
      ],
    ]);
    expect(periphery.parseOutput(ran(0, "[\n\n]"), ctx(root)).findings).toEqual(
      [],
    );
    expect(() =>
      periphery.parseOutput(ran(0, JSON.stringify([{ kind: "x" }])), ctx(root)),
    ).toThrow(/output format may have changed/);
    expect(() =>
      periphery.parseOutput(
        ran(
          1,
          "",
          "Error: Shell command 'swift build --build-tests' returned exit status '1'\n",
        ),
        ctx(root),
      ),
    ).toThrow(/no JSON output/);
  });

  it("runs where a Package.swift is, keeping public declarations, in the deep tier", () => {
    const root = tmp("vk-periphery-");
    expect(periphery.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 6.0\n");
    expect(periphery.adoptedAt?.(root, root)).toBe(true);
    expect(periphery.buildArgs(ctx(root)).args).toEqual([
      "scan",
      "--format",
      "json",
      "--quiet",
      "--retain-public",
    ]);
    expect(periphery.refuseArgs?.(["--strict"])).toMatch(/kit's/);
    expect(periphery.tier).toBe("deep");
  });
});

describe("composer-dependency-analyser", () => {
  const junit = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    '  <testsuite name="unknown classes" failures="1">',
    '    <testcase name="Monolog\\Logger">',
    "      <failure>src/Config.php:12</failure>",
    "    </testcase>",
    "  </testsuite>",
    '  <testsuite name="unused dependencies" failures="1">',
    '    <testcase name="psr/log"></testcase>',
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");

  it("reports an unknown class at its use and an unused package on its composer.json line", () => {
    const root = tmp("vk-cda-");
    writeFileSync(
      join(root, "composer.json"),
      '{\n  "require": {\n    "psr/log": "^3.0",\n    "symfony/yaml": "^7.0"\n  }\n}\n',
    );
    const { findings } = composerDependencyAnalyser.parseOutput(
      ran(1, junit),
      ctx(root),
    );
    expect(
      findings.map((f) => [f.file.slice(root.length + 1), f.line, f.ruleId]),
    ).toEqual([
      ["src/Config.php", 12, "unknown-class"],
      ["composer.json", 3, "unused-dependency"],
    ]);
    expect(findings[1]?.message).toBe(
      "`psr/log` is required in composer.json and nothing uses it",
    );
    expect(
      composerDependencyAnalyser.parseOutput(
        ran(
          0,
          '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n</testsuites>\n',
        ),
        ctx(root),
      ).findings,
    ).toEqual([]);
    expect(() =>
      composerDependencyAnalyser.parseOutput(ran(1, ""), ctx(root)),
    ).toThrow(/output format may have changed/);
    expect(() =>
      composerDependencyAnalyser.parseOutput(
        ran(1, "", "Unknown option --bogus\n"),
        ctx(root),
      ),
    ).toThrow(/Unknown option/);
  });

  it("runs where composer.json requires it, from the project's own vendor/bin when present", () => {
    const root = tmp("vk-cda-");
    writeFileSync(
      join(root, "composer.json"),
      '{ "require-dev": { "phpstan/phpstan": "^2" } }\n',
    );
    expect(composerDependencyAnalyser.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "composer.json"),
      '{ "require-dev": { "shipmonk/composer-dependency-analyser": "^1.8" } }\n',
    );
    expect(composerDependencyAnalyser.adoptedAt?.(root, root)).toBe(true);
    const built = composerDependencyAnalyser.buildArgs(ctx(root));
    expect(built.bin).toBe("composer-dependency-analyser");
    expect(built.args).toEqual(["--format", "junit"]);
    expect(composerDependencyAnalyser.composerVendor).toBe(true);
    expect(
      composerDependencyAnalyser.refuseArgs?.(["--format", "console"]),
    ).toMatch(/kit's/);
  });
});

/** Infection's GitLab-format log of escaped mutants, and its summary. */
const infectionIssue = (name: string, line: number) => ({
  type: "issue",
  fingerprint: "x",
  check_name: name,
  description: `Escaped Mutant for Mutator ${name}`,
  categories: ["Escaped Mutant"],
  location: { path: "src/Money.php", lines: { begin: line } },
  severity: "major",
});
const infectionSummary = (msi: number, escaped: number) =>
  JSON.stringify({
    stats: {
      totalMutantsCount: 6,
      killedCount: 6 - escaped,
      escapedCount: escaped,
      msi,
    },
  });

describe("infection", () => {
  it("reports each escaped mutant at its line and the threshold breach on the config", () => {
    const root = tmp("vk-infection-");
    const scratch = tmp("vk-infection-scratch-");
    writeFileSync(
      join(scratch, "infection.gitlab.json"),
      JSON.stringify([infectionIssue("GreaterThan", 14)]),
    );
    writeFileSync(
      join(scratch, "infection-summary.json"),
      infectionSummary(83.33, 1),
    );
    writeFileSync(join(root, "infection.json5"), "{}\n");
    const { findings } = infection.parseOutput(
      ran(
        1,
        "[ERROR] The minimum required MSI percentage should be 100%, but actual is 83.33%.\n",
      ),
      { ...ctx(root, { options: { minMsi: 100 } }), tempDir: () => scratch },
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["src/Money.php", 14, "GreaterThan", "warning"],
      ["infection.json5", 1, "min-msi", "error"],
    ]);
    expect(
      infection.parseOutput(ran(0, ""), {
        ...ctx(root, { options: {} }),
        tempDir: () => scratch,
      }).findings,
    ).toHaveLength(1);
    const clean = tmp("vk-infection-scratch-");
    writeFileSync(
      join(clean, "infection-summary.json"),
      infectionSummary(100, 0),
    );
    expect(
      infection.parseOutput(ran(0, ""), {
        ...ctx(root, { options: {} }),
        tempDir: () => clean,
      }).findings,
    ).toEqual([]);
    const empty = tmp("vk-infection-scratch-");
    expect(() =>
      infection.parseOutput(
        ran(1, "[ERROR] Infection requires a code coverage driver.\n"),
        { ...ctx(root), tempDir: () => empty },
      ),
    ).toThrow(/coverage driver/);
  });

  it("runs where the project chose it, from its vendor/bin, with the kit's logs and the project's threshold", () => {
    const root = tmp("vk-infection-");
    writeFileSync(
      join(root, "composer.json"),
      '{ "require-dev": { "infection/infection": "^0.35" } }\n',
    );
    expect(infection.adoptedAt?.(root, root)).toBe(true);
    expect(infection.composerVendor).toBe(true);
    const scratch = tmp("vk-infection-scratch-");
    const built = infection.buildArgs({
      ...ctx(root, { options: { minMsi: 90 } }),
      tempDir: () => scratch,
    });
    expect(built.args).toEqual([
      "--no-progress",
      "--no-interaction",
      `--logger-gitlab=${join(scratch, "infection.gitlab.json")}`,
      `--logger-summary-json=${join(scratch, "infection-summary.json")}`,
      `--logger-project-root-directory=${root}`,
      "--min-msi=90",
    ]);
    expect(infection.refuseArgs?.(["--min-msi=50"])).toMatch(/options.minMsi/);
    expect(infection.tier).toBe("deep");
  });
});

describe("stryker-net", () => {
  const report = JSON.stringify({
    schemaVersion: 2,
    thresholds: { high: 80, low: 60 },
    files: {
      "Demo/Money.cs": {
        mutants: [
          {
            mutatorName: "Arithmetic mutation",
            status: "Killed",
            location: { start: { line: 5, column: 66 } },
          },
          {
            mutatorName: "Equality mutation",
            status: "NoCoverage",
            location: { start: { line: 7, column: 81 } },
          },
          {
            mutatorName: "Arithmetic mutation",
            status: "Survived",
            location: { start: { line: 7, column: 81 } },
          },
        ],
      },
    },
  });

  it("reports survived and uncovered mutants at their line, and the break-at breach on the solution", () => {
    const root = tmp("vk-stryker-net-");
    const scratch = tmp("vk-stryker-net-scratch-");
    mkdirSync(join(scratch, "2026-11-03.23-23-37", "reports"), {
      recursive: true,
    });
    writeFileSync(
      join(scratch, "2026-11-03.23-23-37", "reports", "mutation-report.json"),
      report,
    );
    const task = { solution: "Demo.slnx", breakAt: 90 };
    const { findings } = strykerNet.parseOutput(
      ran(
        2,
        "The mutation score is lower than the configured break threshold of 90%.\n",
      ),
      { ...ctx(root, { options: task }), tempDir: () => scratch },
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["Demo/Money.cs", 7, "no-coverage", "warning"],
      ["Demo/Money.cs", 7, "survived", "warning"],
      ["Demo.slnx", 1, "break-at", "error"],
    ]);
    expect(
      strykerNet.parseOutput(ran(0, ""), {
        ...ctx(root, { options: { solution: "Demo.slnx" } }),
        tempDir: () => scratch,
      }).findings,
    ).toHaveLength(2);
    const empty = tmp("vk-stryker-net-scratch-");
    expect(() =>
      strykerNet.parseOutput(
        ran(
          1,
          "Stryker.NET failed to mutate your project.\nGiven path does not exist: Demo.sln\n",
        ),
        { ...ctx(root, { options: task }), tempDir: () => empty },
      ),
    ).toThrow(/failed to mutate/);
  });

  it("plans one task per solution where the project chose it, with the kit's reporter and output folder", () => {
    const root = tmp("vk-stryker-net-");
    writeFileSync(join(root, "Demo.slnx"), "<Solution />\n");
    const seed = { cwd: root };
    expect(
      strykerNet.expand?.(
        seed,
        env(root, {
          config: { ignore: [], tools: {} },
        } as unknown as Partial<PlanEnv>),
      ),
    ).toEqual([]);
    const chosen = env(root, {
      toolConfig: { enabled: true },
      config: {
        ignore: [],
        tools: {
          "stryker-net": {
            options: { project: "Demo/Demo.csproj", breakAt: 90 },
          },
        },
      },
    } as unknown as Partial<PlanEnv>);
    const tasks = strykerNet.expand?.(seed, chosen) as TaskSeed[];
    expect(tasks.map((t) => t.options)).toEqual([
      { solution: "Demo.slnx", project: "Demo/Demo.csproj", breakAt: 90 },
    ]);
    const scratch = tmp("vk-stryker-net-scratch-");
    expect(
      strykerNet.buildArgs({
        ...ctx(root, { options: tasks[0]?.options }),
        tempDir: () => scratch,
      }).args,
    ).toEqual([
      "stryker",
      "-s",
      "Demo.slnx",
      "-p",
      "Demo/Demo.csproj",
      "-r",
      "json",
      "-b",
      "90",
      "-O",
      scratch,
    ]);
    expect(strykerNet.refuseArgs?.(["-r", "html"])).toMatch(/kit's/);
    expect(strykerNet.tier).toBe("deep");
  });
});
