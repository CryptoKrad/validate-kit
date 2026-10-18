import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clippy } from "../src/adapters/clippy.js";
import { oxlint } from "../src/adapters/oxlint.js";
import { ConfigError } from "../src/config/schema.js";
import { parseConcurrency } from "../src/commands/check.js";
import { buildPlan, FILE_ARG_CHUNK } from "../src/core/plan.js";
import type { ResolvedConfig } from "../src/core/types.js";
import { changedFiles } from "../src/detect/git.js";
import { listScopedFiles, toPosix } from "../src/detect/languages.js";
import { detectLanguages, planCheck } from "../src/index.js";

function baseConfig(): ResolvedConfig {
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
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.invalid", ...args],
    { cwd, stdio: "ignore" },
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

describe("scope and profile planning", () => {
  it("applies ignore globs during language detection", async () => {
    const detection = await detectLanguages(repoRoot, {
      // The repo's own ignores (validate.config.ts) for fixtures and records.
      ignore: [
        "packages/validate-kit/samples/**",
        "services/**",
        "packages/validate-kit/rule-tests/**",
        "docs/research/**",
        "tests/fixtures/**",
        "docs/evidence/**",
      ],
    });

    expect(detection.has("ts")).toBe(true);
    expect(detection.has("rust")).toBe(false);
    expect(detection.has("go")).toBe(false);
    expect(detection.has("python")).toBe(false);
  });

  it("fixtures profile scopes to intentional failure fixtures", async () => {
    const planned = await planCheck({
      cwd: repoRoot,
      profile: "fixtures",
      onlyTools: ["ast-grep"],
    });

    expect(planned.scope.profile).toBe("fixtures");
    expect(planned.scope.mode).toBe("full");
    expect([...planned.detection.keys()].toSorted()).toEqual([
      "go",
      "js",
      "python",
      "rust",
      "ts",
    ]);
    expect(planned.tasks).toHaveLength(1);
    expect(planned.tasks[0]?.files?.length).toBeGreaterThan(0);
    expect(
      planned.tasks[0]?.files?.every(
        (file) => file.includes("/services/") || file.includes("/samples/"),
      ),
    ).toBe(true);
  });

  it("keeps project-native tools whole-root scoped when an explicit file scope exists", async () => {
    const planned = await planCheck({
      cwd: repoRoot,
      profile: "fixtures",
    });
    const taskFor = (tool: string) =>
      planned.tasks.find((task) => task.adapter.id === tool);

    for (const tool of ["tsc", "rustfmt", "clippy", "golangci-lint"]) {
      expect(taskFor(tool)?.files).toBeUndefined();
    }

    // The planned tsc tasks, said when this fails (a Windows-only failure
    // showed only the folder).
    const tscTasks = JSON.stringify(
      planned.tasks
        .filter((task) => task.adapter.id === "tsc")
        .map(({ cwd, cannotRun }) => ({ cwd, cannotRun })),
    );
    expect(taskFor("tsc")?.cwd, tscTasks).toBe(
      toPosix(resolve(repoRoot, "packages/validate-kit/samples")),
    );
    expect(taskFor("rustfmt")?.cwd).toBe(
      toPosix(resolve(repoRoot, "services/pricing-rs")),
    );
    expect(taskFor("clippy")?.cwd).toBe(
      toPosix(resolve(repoRoot, "services/pricing-rs")),
    );
    expect(taskFor("golangci-lint")?.cwd).toBe(
      toPosix(resolve(repoRoot, "services/ingest-go")),
    );

    expect(taskFor("gofumpt")?.files?.length).toBeGreaterThan(0);
    expect(taskFor("ruff")?.files?.length).toBeGreaterThan(0);
    expect(taskFor("ruff-format")?.files?.length).toBeGreaterThan(0);
  });

  it("propagates configured ast-grep rule directories into the planned task", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-scope-"));
    mkdirSync(resolve(root, "custom-rules"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ astGrep: { ruleDirs: ["custom-rules"] } }, null, 2),
    );

    const planned = await planCheck({
      cwd: root,
      onlyTools: ["ast-grep"],
    });

    expect(planned.tasks).toHaveLength(1);
    expect(planned.tasks[0]?.options).toMatchObject({
      ruleDirs: ["custom-rules"],
    });
  });

  it("fails the fixtures profile off-repo with a clear message instead of hardcoded paths", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-fixtures-off-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(planCheck({ cwd: root, profile: "fixtures" })).rejects.toThrow(
      /fixtures profile/,
    );
  });

  it("treats bare since as a since scope in git repositories", async () => {
    const planned = await planCheck({
      cwd: repoRoot,
      since: "HEAD",
      onlyTools: ["prettier"],
    });

    expect(planned.scope.mode).toBe("since");
  });

  it("changed mode sees staged-but-clean files (fully-staged pre-commit state)", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-git-"));
    git(root, "init", "-q");
    writeFileSync(resolve(root, "a.ts"), "export const value = 1;\n");
    git(root, "add", "a.ts");
    git(root, "commit", "-qm", "init");

    // The pre-commit shape: the edit is fully staged, the worktree matches
    // the index, so neither `git diff` (worktree vs index) nor untracked
    // listing sees it — only index-vs-HEAD does.
    writeFileSync(resolve(root, "a.ts"), "export const value = 2;\n");
    git(root, "add", "a.ts");
    writeFileSync(resolve(root, "b.ts"), "export const other = 1;\n");

    const files = await changedFiles(root, "changed");
    expect(files).toContain(toPosix(resolve(root, "a.ts")));
    expect(files).toContain(toPosix(resolve(root, "b.ts")));
  });

  it("rejects since refs that look like git options", async () => {
    await expect(
      changedFiles(repoRoot, "since", "--upload-pack=/bin/true"),
    ).rejects.toThrow(/refs may not start with '-'/);
  });

  it("fails loud when git scope filters cannot be resolved", async () => {
    const nonGitRoot = mkdtempSync(resolve(tmpdir(), "validate-kit-non-git-"));
    writeFileSync(resolve(nonGitRoot, "index.ts"), "const value = 1;\n");

    await expect(
      planCheck({
        cwd: nonGitRoot,
        changedMode: "changed",
        onlyTools: ["prettier"],
      }),
    ).rejects.toThrow("Unable to compute changed file scope");

    await expect(
      planCheck({
        cwd: repoRoot,
        since: "definitely-not-a-ref",
        onlyTools: ["prettier"],
      }),
    ).rejects.toThrow("Unable to compute since file scope");
  });

  it("does not follow symlinks out of the scope root", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "validate-kit-outside-"));
    writeFileSync(resolve(outside, "escaped.ts"), "export const x = 1;\n");
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-symlink-"));
    writeFileSync(resolve(root, "inside.ts"), "export const y = 1;\n");
    symlinkSync(outside, resolve(root, "linked"), "dir");

    const files = await listScopedFiles(root);
    expect(files.some((f) => f.endsWith("inside.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("escaped.ts"))).toBe(false);
  });

  it("chunks oversized file lists so argv stays under OS limits", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-chunk-"));
    const files: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const file = resolve(root, `f${i}.ts`);
      writeFileSync(file, "export {};\n");
      files.push(file);
    }

    const detection = await detectLanguages(root);
    const tasks = await buildPlan(detection, baseConfig(), root, [oxlint], {
      scopedFiles: files,
    });

    expect(tasks.length).toBeGreaterThan(1);
    for (const task of tasks) {
      expect(task.files?.length ?? 0).toBeLessThanOrEqual(FILE_ARG_CHUNK);
    }
    const total = tasks.reduce((n, t) => n + (t.files?.length ?? 0), 0);
    expect(total).toBe(1000);
  });

  it("runs crate-scoped tools once per cargo workspace, not per member", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-ws-"));
    writeFileSync(
      resolve(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/standalone"]\n',
    );
    for (const name of ["a", "b", "standalone"]) {
      mkdirSync(resolve(root, "crates", name, "src"), { recursive: true });
      writeFileSync(
        resolve(root, "crates", name, "Cargo.toml"),
        `[package]\nname = "${name}"\nversion = "0.0.0"\nedition = "2021"\n`,
      );
      writeFileSync(
        resolve(root, "crates", name, "src", "lib.rs"),
        "pub fn f() {}\n",
      );
    }

    const detection = await detectLanguages(root);
    const tasks = await buildPlan(detection, baseConfig(), root, [clippy], {});

    // workspace root covers members a + b; the excluded crate keeps its own
    // run (collapsing it would silently un-lint it).
    expect(tasks.map((t) => toPosix(t.cwd)).toSorted()).toEqual([
      toPosix(resolve(root)),
      toPosix(resolve(root, "crates", "standalone")),
    ]);
  });

  it("validates CLI concurrency overrides before running tools", () => {
    expect(parseConcurrency(undefined)).toBeUndefined();
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("8")).toBe(8);
    expect(() => parseConcurrency("0")).toThrow(ConfigError);
    expect(() => parseConcurrency("2.5")).toThrow(ConfigError);
    expect(() => parseConcurrency("fast")).toThrow(ConfigError);
  });
});
