import "./isolated-git.js";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clippy } from "../src/adapters/clippy.js";
import { oxlint } from "../src/adapters/oxlint.js";
import { ConfigError } from "../src/config/schema.js";
import { parseConcurrency } from "../src/commands/check.js";
import { buildPlan, FILE_ARG_CHUNK } from "../src/core/plan.js";
import { run } from "../src/core/exec.js";
import type { ResolvedConfig } from "../src/core/types.js";
import { LANGUAGES } from "../src/core/types.js";
import { changedFiles } from "../src/detect/git.js";
import { listScopedFiles, toPosix } from "../src/detect/languages.js";
import { detectLanguages, planCheck } from "../src/index.js";

function baseConfig(): ResolvedConfig {
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
  it("blocks a new-remote push even when tracking refs show no changed files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-push-"));
    git(root, "init", "--bare", "first.git");
    git(root, "init", "--bare", "second.git");
    const project = resolve(root, "project");
    mkdirSync(resolve(project, "scripts"), { recursive: true });
    git(project, "init", "-q", "-b", "main");
    cpSync(resolve(repoRoot, "lefthook.yml"), resolve(project, "lefthook.yml"));
    if (existsSync(resolve(repoRoot, ".lefthook")))
      cpSync(resolve(repoRoot, ".lefthook"), resolve(project, ".lefthook"), {
        recursive: true,
      });
    writeFileSync(
      resolve(project, "scripts", "verify-clean.sh"),
      '#!/bin/sh\nprintf "%s\\n" "$1" > .git/preflight-args\ncat > .git/push-stdin\nexit 17\n',
      { mode: 0o755 },
    );
    git(project, "add", ".");
    git(project, "commit", "-qm", "fixture");
    git(project, "remote", "add", "origin", resolve(root, "first.git"));
    git(project, "push", "-qu", "origin", "main");
    // A relocated clone keeps origin/main at HEAD although the new remote
    // has never seen it. A commit gate must use Git's pushed refs on stdin.
    git(project, "remote", "set-url", "origin", resolve(root, "second.git"));
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, "node_modules/lefthook/bin/index.js"),
        "install",
        "pre-push",
      ],
      { cwd: project, stdio: "pipe" },
    );

    const pushed = await run("git", ["push", "origin", "main"], {
      cwd: project,
      timeoutMs: 15_000,
    });

    expect(pushed.spawnError).toBe(false);
    expect(pushed.exitCode).not.toBe(0);
    expect(readFileSync(resolve(project, ".git/preflight-args"), "utf8")).toBe(
      "--pushed\n",
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
    }).trim();
    expect(readFileSync(resolve(project, ".git/push-stdin"), "utf8")).toBe(
      `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    );
  });

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

  it.each(["js", "ts"])(
    "keeps ESLint in each package when include names only its %s source directory",
    async (extension) => {
      const root = mkdtempSync(resolve(tmpdir(), "validate-kit-eslint-scope-"));
      writeFileSync(resolve(root, "package.json"), '{"private":true}\n');
      for (const app of ["frontend", "storefront", "outside"]) {
        mkdirSync(resolve(root, app, "src"), { recursive: true });
        writeFileSync(resolve(root, app, "package.json"), "{}\n");
        writeFileSync(
          resolve(root, app, "eslint.config.mjs"),
          "export default [];\n",
        );
        writeFileSync(
          resolve(root, app, "src", `index.${extension}`),
          "export {};\n",
        );
        writeFileSync(
          resolve(root, app, "src", `ignored.${extension}`),
          "export {};\n",
        );
        writeFileSync(
          resolve(root, app, `outside.${extension}`),
          "export {};\n",
        );
      }
      writeFileSync(
        resolve(root, "validate.config.json"),
        JSON.stringify({
          include: ["frontend/src", "storefront/src"],
          ignore: ["**/ignored.*"],
        }),
      );

      const planned = await planCheck({ cwd: root, onlyTools: ["eslint"] });

      expect(planned.tasks.map(({ cwd, files }) => ({ cwd, files }))).toEqual(
        ["frontend", "storefront"].map((app) => ({
          cwd: toPosix(resolve(root, app)),
          files: [toPosix(resolve(root, app, "src", `index.${extension}`))],
        })),
      );
    },
  );

  it("discovers TypeScript project context outside include without adding it to scope", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-ts-scope-"));
    mkdirSync(resolve(root, "app", "src"), { recursive: true });
    const config = toPosix(resolve(root, "app", "tsconfig.json"));
    const source = toPosix(resolve(root, "app", "src", "index.ts"));
    writeFileSync(config, "{}\n");
    writeFileSync(source, "export {};\n");
    const scope = { include: ["app/src"] };

    const detection = await detectLanguages(root, scope);

    expect(detection.get("ts")?.roots).toEqual([toPosix(resolve(root, "app"))]);
    expect(detection.get("ts")?.markerFiles).toEqual([config]);
    expect(await listScopedFiles(root, scope)).toEqual([source]);
  });

  it("does not discover package context above the validation root", async () => {
    const outside = mkdtempSync(
      resolve(tmpdir(), "validate-kit-context-boundary-"),
    );
    const root = resolve(outside, "project");
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(outside, "package.json"), "{}\n");
    writeFileSync(resolve(root, "src", "index.js"), "export {};\n");

    const detection = await detectLanguages(root, { include: ["src"] });

    expect(detection.get("js")).toMatchObject({
      roots: [toPosix(root)],
      markerFiles: [],
    });
  });

  it("fixtures profile scopes to intentional failure fixtures", async () => {
    const planned = await planCheck({
      cwd: repoRoot,
      profile: "fixtures",
      onlyTools: ["ast-grep"],
    });

    expect(planned.scope.profile).toBe("fixtures");
    expect(planned.scope.mode).toBe("full");
    // Cargo.toml is TOML, detected though no planned tool reads it.
    expect([...planned.detection.keys()].toSorted()).toEqual([
      "go",
      "js",
      "python",
      "rust",
      "toml",
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
    symlinkSync(
      outside,
      resolve(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

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

  it("splits a list under the count limit when its paths are long", async () => {
    // 399 files, ~500 characters each here: past the 180,000-character
    // budget. On Windows (260-character paths) shorter names do it, against
    // the 7,000 a .cmd shim's escaped command line leaves.
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-long-"));
    const dir =
      process.platform === "win32"
        ? root
        : resolve(root, "d".repeat(200), "e".repeat(200));
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < 399; i += 1) {
      const file = resolve(dir, `${"f".repeat(40)}${i}.ts`);
      writeFileSync(file, "export {};\n");
      files.push(file);
    }

    const detection = await detectLanguages(root);
    const tasks = await buildPlan(detection, baseConfig(), root, [oxlint], {
      scopedFiles: files,
    });

    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks.reduce((n, t) => n + (t.files?.length ?? 0), 0)).toBe(399);
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
