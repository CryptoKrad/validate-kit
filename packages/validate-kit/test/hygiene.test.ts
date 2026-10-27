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
import { cargoMachete } from "../src/adapters/cargo-machete.js";
import { cooldown } from "../src/adapters/cooldown.js";
import { deptry } from "../src/adapters/deptry.js";
import { typos } from "../src/adapters/typos.js";
import { zizmor } from "../src/adapters/zizmor.js";
import { toPosix } from "../src/detect/languages.js";
import type { PlanEnv, RawOutput, ToolContext } from "../src/core/types.js";

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
      '{"name":"c","packageManager":"pnpm@10.34.7"}\n',
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
      '{"name":"c","packageManager":"pnpm@10.34.7"}\n',
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
