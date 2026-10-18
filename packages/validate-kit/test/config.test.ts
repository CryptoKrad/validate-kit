import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/schema.js";
import { mergeInto, resolveConfig } from "../src/config/resolve.js";
import type { ResolvedConfig } from "../src/core/types.js";
import { planCheck, runCheck } from "../src/index.js";
import {
  detectLanguages,
  listScopedFiles,
  toPosix,
} from "../src/detect/languages.js";
import { eslint } from "../src/adapters/eslint.js";
import { prettier } from "../src/adapters/prettier.js";

describe("config and scope", () => {
  it("discovers default config files and applies built-in presets", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-config-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: ["recommended", "ci"], concurrency: 1 }),
    );

    const resolved = await resolveConfig(root);
    expect(resolved.source).toBe(resolve(root, "validate.config.json"));
    expect(resolved.config.concurrency).toBe(1);
    for (const layer of [
      "format",
      "lint",
      "type-check",
      "custom-rules",
      "security",
    ] as const) {
      expect(resolved.config.layers[layer].enabled).toBe(true);
    }
    expect(resolved.config.astGrep.ruleIds).toContain("ts-no-explicit-any");
  });

  it("resolves file-backed ast-grep rule subsets for presets", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-presets-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "security" }, null, 2),
    );

    const security = await resolveConfig(root);
    expect(security.config.astGrep.ruleIds).toEqual([
      "ts-no-eval",
      "tsx-no-eval",
      "js-no-eval",
      "py-no-eval-exec",
      "rust-flag-unsafe-block",
      "rust-flag-transmute",
    ]);

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "recommended" }, null, 2),
    );
    const recommended = await resolveConfig(root);
    expect(recommended.config.astGrep.ruleIds).not.toContain(
      "ts-no-explicit-any",
    );
  });

  it("rejects unknown config keys and invalid enum values", () => {
    expect(() => parseConfig({ unknown: true }, "inline")).toThrow(ConfigError);
    expect(() =>
      parseConfig({ layers: { impossible: { enabled: true } } }, "inline"),
    ).toThrow(ConfigError);
  });

  it("treats extends: [] as the explicit no-preset opt-out (documented semantics)", async () => {
    // Omitted extends → recommended baseline; extends: [] → NO baseline
    // (bring-your-own rule library). Both directions pinned here.
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-optout-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: [] }, null, 2),
    );
    const optedOut = await resolveConfig(root);
    expect(optedOut.config.astGrep.ruleIds).toEqual([]);

    writeFileSync(resolve(root, "validate.config.json"), "{}\n");
    const defaulted = await resolveConfig(root);
    expect(defaulted.config.astGrep.ruleIds).toContain("ts-no-console");
  });

  it("deep-merges per-tool config so a later layer cannot drop an earlier disable", () => {
    const target = {
      languages: {
        ts: { enabled: true, tools: { eslint: { enabled: false } } },
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
    } as ResolvedConfig;

    // User adds extraArgs for the same tool a preset disabled — the disable
    // must survive the merge.
    mergeInto(target, {
      languages: { ts: { tools: { eslint: { extraArgs: ["--cache"] } } } },
    });

    expect(target.languages.ts.tools?.eslint).toEqual({
      enabled: false,
      extraArgs: ["--cache"],
    });
  });

  it("rejects invalid explicit config path targets as config errors", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-config-paths-"));
    const unsupported = resolve(root, "validate.config.md");
    const malformed = resolve(root, "bad.config.json");
    const valid = resolve(root, "custom.config.json");
    writeFileSync(unsupported, "# not a config\n");
    writeFileSync(malformed, "{ bad json\n");
    writeFileSync(valid, JSON.stringify({ extends: "recommended" }));

    await expect(resolveConfig(root, ".")).rejects.toThrow(
      "Config path must be a file",
    );
    await expect(resolveConfig(root, unsupported)).rejects.toThrow(
      "Unsupported config file extension",
    );
    await expect(resolveConfig(root, malformed)).rejects.toThrow(
      "Invalid JSON config",
    );
    await expect(resolveConfig(root, valid)).resolves.toMatchObject({
      source: valid,
    });
  });

  it("applies include globs and built-in ignore globs before detection", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-scope-"));
    mkdirSync(resolve(root, "src"), { recursive: true });
    mkdirSync(resolve(root, "dist"), { recursive: true });
    mkdirSync(resolve(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(resolve(root, "src", "app.ts"), "const app = 1;\n");
    writeFileSync(resolve(root, "dist", "generated.ts"), "const gen = 1;\n");
    writeFileSync(
      resolve(root, "node_modules", "pkg", "ignored.ts"),
      "const ignored = 1;\n",
    );

    const included = await listScopedFiles(root, { include: ["src"] });
    expect(included).toEqual([toPosix(resolve(root, "src", "app.ts"))]);
    const ignoredDetection = await detectLanguages(root, { include: ["dist"] });
    expect(ignoredDetection.size).toBe(0);
  });

  it("supports existing source files as include patterns", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-file-include-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(resolve(root, ".prettierrc"), "{}\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ include: ["index.ts"] }, null, 2),
    );

    await expect(
      listScopedFiles(root, { include: ["index.ts"] }),
    ).resolves.toEqual([toPosix(resolve(root, "index.ts"))]);

    const planned = await planCheck({ cwd: root, onlyTools: ["prettier"] });
    expect(planned.scope.files).toBe(1);
    expect(planned.tasks).toHaveLength(1);
    expect(planned.tasks[0]?.files).toEqual([
      toPosix(resolve(root, "index.ts")),
    ]);
  });

  it("rejects config scopes that erase all source files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-empty-scope-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ include: ["src"] }, null, 2),
    );
    await expect(
      planCheck({ cwd: root, onlyTools: ["prettier"] }),
    ).rejects.toThrow(
      "Configured include/ignore patterns matched no source files",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ ignore: ["**/*"] }, null, 2),
    );
    await expect(
      runCheck({ cwd: root, onlyTools: ["prettier"] }),
    ).rejects.toThrow(
      "Configured include/ignore patterns matched no source files",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ ignore: ["**/*.ts"] }, null, 2),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Configured include/ignore patterns matched no source files",
    );

    const emptyRoot = mkdtempSync(
      resolve(tmpdir(), "validate-kit-empty-root-"),
    );
    writeFileSync(
      resolve(emptyRoot, "validate.config.json"),
      JSON.stringify({ include: ["src"] }, null, 2),
    );
    await expect(planCheck({ cwd: emptyRoot })).resolves.toMatchObject({
      scope: { files: 0 },
      tasks: [],
    });
  });

  it("uses config to disable layers and per-language tools", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-plan-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          layers: { lint: { enabled: false } },
          languages: { ts: { tools: { prettier: { enabled: false } } } },
        },
        null,
        2,
      ),
    );

    const planned = await planCheck({ cwd: root });
    const tools = planned.tasks.map((task) => task.adapter.id);
    expect(tools).not.toContain("oxlint");
    expect(tools).not.toContain("eslint");
    expect(tools).not.toContain("prettier");
  });

  it("honors disabled languages while keeping other source languages active", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-lang-disable-"));
    writeFileSync(resolve(root, "index.ts"), "const tsValue = 1;\n");
    writeFileSync(resolve(root, "index.js"), "const jsValue = 1;\n");
    writeFileSync(resolve(root, ".prettierrc"), "{}\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ languages: { ts: { enabled: false } } }, null, 2),
    );

    const planned = await planCheck({ cwd: root, onlyTools: ["prettier"] });
    expect(planned.tasks).toHaveLength(1);
    expect(planned.tasks[0]?.files).toEqual([
      toPosix(resolve(root, "index.js")),
    ]);
  });

  it("rejects config that disables every validation task for source files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-no-tasks-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          layers: {
            format: { enabled: false },
            lint: { enabled: false },
            "type-check": { enabled: false },
            "custom-rules": { enabled: false },
            security: { enabled: false },
          },
        },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Validate config disables every validation task",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          languages: {
            ts: {
              tools: {
                prettier: { enabled: false },
                oxlint: { enabled: false },
                eslint: { enabled: false },
                tsc: { enabled: false },
                "ast-grep": { enabled: false },
                semgrep: { enabled: false },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    await expect(runCheck({ cwd: root })).rejects.toThrow(
      "Validate config disables every validation task",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ languages: { ts: { enabled: false } } }, null, 2),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Validate config disables every validation task",
    );
  });

  it("rejects invalid per-language tool configs before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-tool-config-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        { languages: { ts: { tools: { pretiier: { enabled: false } } } } },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Unknown tool config languages.ts.tools.pretiier",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        { languages: { ts: { tools: { ruff: { enabled: false } } } } },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Tool ruff does not support language ts",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          languages: {
            ts: { tools: { oxlint: { configPath: "missing-oxlint.json" } } },
          },
        },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "languages.ts.tools.oxlint.configPath not found",
    );

    mkdirSync(resolve(root, "oxlint-config.json"));
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          languages: {
            ts: { tools: { oxlint: { configPath: "oxlint-config.json" } } },
          },
        },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "languages.ts.tools.oxlint.configPath must be a file",
    );

    const configPath = resolve(root, "prettier.config.json");
    writeFileSync(configPath, "{}\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          languages: {
            ts: { tools: { prettier: { configPath: "prettier.config.json" } } },
          },
        },
        null,
        2,
      ),
    );
    const planned = await planCheck({ cwd: root, onlyTools: ["prettier"] });
    expect(planned.tasks[0]?.toolConfig.configPath).toBe(toPosix(configPath));

    const ctx = {
      cwd: root,
      files: [resolve(root, "index.ts")],
      fix: false,
      configPath,
      extraArgs: [],
    };
    expect(prettier.buildArgs(ctx).args).toEqual(
      expect.arrayContaining(["--config", configPath]),
    );
    expect(eslint.buildArgs(ctx).args).toEqual(
      expect.arrayContaining(["--config", configPath]),
    );
  });

  it("rejects invalid severity override declarations before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-severity-"));
    writeFileSync(resolve(root, "index.ts"), "console.log('x');\n");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          severityOverrides: [
            { tool: "not-a-tool", ruleId: "*", severity: "off" },
          ],
        },
        null,
        2,
      ),
    );
    await expect(planCheck({ cwd: root })).rejects.toThrow(
      "Unknown severity override tool 'not-a-tool'",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          severityOverrides: [
            { tool: "ast-grep", ruleId: "*", severity: "off" },
            { tool: "ast-grep", ruleId: "*", severity: "error" },
          ],
        },
        null,
        2,
      ),
    );
    await expect(runCheck({ cwd: root })).rejects.toThrow(
      "Duplicate severity override for ast-grep/*",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          severityOverrides: [
            { tool: "ast-grep", ruleId: "*", severity: "off" },
          ],
        },
        null,
        2,
      ),
    );
    await expect(resolveConfig(root)).resolves.toMatchObject({
      config: {
        severityOverrides: [{ tool: "ast-grep", ruleId: "*", severity: "off" }],
      },
    });
  });

  it("rejects invalid programmatic API options before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-api-options-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(
      planCheck({ cwd: root, profile: "nope" as never }),
    ).rejects.toThrow("Invalid profile 'nope'");
    await expect(planCheck({ cwd: root, concurrency: 0 })).rejects.toThrow(
      "Invalid concurrency '0'",
    );
    await expect(
      planCheck({ cwd: root, layers: ["impossible" as never] }),
    ).rejects.toThrow("Invalid layer 'impossible'");
    await expect(
      planCheck({ cwd: root, languages: ["ruby" as never] }),
    ).rejects.toThrow("Invalid language 'ruby'");
    await expect(
      planCheck({ cwd: root, onlyTools: ["not-a-tool"] }),
    ).rejects.toThrow("Invalid tool 'not-a-tool'");
    await expect(
      planCheck({
        cwd: root,
        onlyTools: ["prettier"],
        disabledTools: ["prettier"],
      }),
    ).rejects.toThrow("Tool cannot be both --only and --disable: prettier");
    await expect(
      planCheck({ cwd: root, changedMode: "unknown" as never }),
    ).rejects.toThrow("Invalid changed mode 'unknown'");

    await expect(planCheck({ cwd: root, since: "HEAD" })).rejects.toThrow(
      "Unable to compute since file scope",
    );
  });

  it("rejects invalid programmatic API cwd roots before scanning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-api-cwd-"));
    const filePath = resolve(root, "package.json");
    const missingPath = resolve(root, "missing");
    writeFileSync(filePath, "{}\n");

    await expect(
      planCheck({ cwd: filePath, onlyTools: ["prettier"] }),
    ).rejects.toThrow("Path must be a directory");
    await expect(
      runCheck({ cwd: missingPath, onlyTools: ["prettier"] }),
    ).rejects.toThrow("Path does not exist");
  });

  it("rejects explicit filters that match no validation tasks", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-empty-filter-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(planCheck({ cwd: root, languages: ["rust"] })).rejects.toThrow(
      "No validation tasks matched the requested filters",
    );
    await expect(
      runCheck({ cwd: root, onlyTools: ["clippy"] }),
    ).rejects.toThrow("No validation tasks matched the requested filters");
  });

  it("resolves project-relative ast-grep sgconfig paths", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-sgconfig-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(resolve(root, "custom-sg.yml"), "ruleDirs: []\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        { extends: [], astGrep: { sgconfig: "custom-sg.yml" } },
        null,
        2,
      ),
    );

    const planned = await planCheck({ cwd: root, onlyTools: ["ast-grep"] });
    expect(planned.tasks).toHaveLength(1);
    expect(planned.tasks[0]?.options).toMatchObject({
      sgconfig: toPosix(resolve(root, "custom-sg.yml")),
    });
    expect(readFileSync(resolve(root, "custom-sg.yml"), "utf8")).toContain(
      "ruleDirs",
    );
  });

  it("rejects invalid ast-grep path inputs before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-ast-paths-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ astGrep: { sgconfig: "missing-sg.yml" } }, null, 2),
    );
    await expect(
      planCheck({ cwd: root, onlyTools: ["ast-grep"] }),
    ).rejects.toThrow("astGrep.sgconfig not found");

    mkdirSync(resolve(root, "sgconfig-dir.yml"));
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ astGrep: { sgconfig: "sgconfig-dir.yml" } }, null, 2),
    );
    await expect(
      runCheck({ cwd: root, onlyTools: ["ast-grep"] }),
    ).rejects.toThrow("astGrep.sgconfig must be a file");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ astGrep: { ruleDirs: ["missing-rules"] } }, null, 2),
    );
    await expect(
      planCheck({ cwd: root, onlyTools: ["ast-grep"] }),
    ).rejects.toThrow("astGrep.ruleDirs entry not found");

    writeFileSync(resolve(root, "rules-file.yml"), "not a dir\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ astGrep: { ruleDirs: ["rules-file.yml"] } }, null, 2),
    );
    await expect(
      runCheck({ cwd: root, onlyTools: ["ast-grep"] }),
    ).rejects.toThrow("astGrep.ruleDirs entry must be a directory");
  });

  it("rejects unknown ast-grep rule id filters before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-ast-ruleids-"));
    writeFileSync(resolve(root, "index.ts"), 'console.log("x");\n');

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        { extends: [], astGrep: { ruleIds: ["ts-no-consol"] } },
        null,
        2,
      ),
    );
    await expect(
      planCheck({ cwd: root, onlyTools: ["ast-grep"] }),
    ).rejects.toThrow("Unknown astGrep.ruleIds: ts-no-consol");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        { extends: [], astGrep: { ruleIds: ["ts-no-console"] } },
        null,
        2,
      ),
    );
    const bundled = await planCheck({ cwd: root, onlyTools: ["ast-grep"] });
    expect(bundled.tasks[0]?.options).toMatchObject({
      ruleIds: ["ts-no-console"],
    });

    mkdirSync(resolve(root, "custom-rules", "typescript", "style"), {
      recursive: true,
    });
    writeFileSync(
      resolve(
        root,
        "custom-rules",
        "typescript",
        "style",
        "no-debugger-contract.yml",
      ),
      [
        "id: ts-no-debugger-contract",
        "language: TypeScript",
        "severity: warning",
        'message: "Avoid debugger statements."',
        "rule:",
        "  pattern: debugger",
        "",
      ].join("\n"),
    );
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          extends: [],
          astGrep: {
            ruleDirs: ["custom-rules"],
            ruleIds: ["ts-no-debugger-contract"],
          },
        },
        null,
        2,
      ),
    );
    const customDir = await planCheck({ cwd: root, onlyTools: ["ast-grep"] });
    expect(customDir.tasks[0]?.options).toMatchObject({
      ruleIds: ["ts-no-debugger-contract"],
    });

    writeFileSync(
      resolve(root, "custom-sg.yml"),
      "ruleDirs:\n  - custom-rules\n",
    );
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          extends: [],
          astGrep: {
            sgconfig: "custom-sg.yml",
            ruleIds: ["ts-no-debugger-contract"],
          },
        },
        null,
        2,
      ),
    );
    const customSgconfig = await planCheck({
      cwd: root,
      onlyTools: ["ast-grep"],
    });
    expect(customSgconfig.tasks[0]?.options).toMatchObject({
      ruleIds: ["ts-no-debugger-contract"],
    });
  });
});
