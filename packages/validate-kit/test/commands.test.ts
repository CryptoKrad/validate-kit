import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCommand } from "../src/commands/check.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { initCommand } from "../src/commands/init.js";
import { listCommand } from "../src/commands/list.js";
import { rulesNewCommand } from "../src/commands/rules.js";
import { run } from "../src/core/exec.js";
import { EXIT } from "../src/core/exit-codes.js";
import type {
  AvailabilityResult,
  Detection,
  ToolAdapter,
} from "../src/core/types.js";

function detectedTs(root: string): Detection {
  return new Map([
    [
      "ts",
      {
        lang: "ts",
        roots: [root],
        markerFiles: [resolve(root, "tsconfig.json")],
      },
    ],
  ]);
}

function doctorAdapter(id: string, optional = false): ToolAdapter {
  return {
    id,
    layer: "lint",
    languages: ["ts"],
    bin: id,
    supportsFix: false,
    fixWriteBack: false,
    minVersion: "2.0.0",
    installHint: `install ${id}`,
    optional,
    detect: () => true,
    buildArgs: () => ({ bin: id, args: [] }),
    parseOutput: () => ({
      findings: [],
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: 0,
      stderr: "",
    }),
  };
}

function outdatedAvailability(
  adapter: ToolAdapter,
): Promise<AvailabilityResult> {
  return Promise.resolve({
    available: true,
    version: "1.0.0",
    minVersion: adapter.minVersion,
    installHint: adapter.installHint,
  });
}

describe("commands", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scaffolds init config without overwriting unless forced", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-"));
    // A TypeScript project root: the config is .ts only with a root tsconfig.
    writeFileSync(resolve(root, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    const configPath = resolve(root, "validate.config.ts");
    expect(readFileSync(configPath, "utf8")).toContain(
      'extends: "recommended"',
    );

    writeFileSync(configPath, "sentinel\n");
    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    expect(readFileSync(configPath, "utf8")).toBe("sentinel\n");

    await expect(initCommand({ cwd: root, force: true })).resolves.toBe(
      EXIT.CLEAN,
    );
    // The kit is not this temp project's dependency, so the starter must not
    // import a module the project cannot resolve.
    const forced = readFileSync(configPath, "utf8");
    expect(forced).toContain("export default {");
    expect(forced).toContain('extends: "recommended"');
    expect(forced).not.toContain('from "validate-kit"');
  });

  it("scaffolds .mcp.json so agents get the MCP server, without clobbering existing servers", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-mcp-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    const mcp = JSON.parse(
      readFileSync(resolve(root, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };
    // Never a registry fetch: the unscoped npm name is not ours.
    expect(mcp.mcpServers["Tester.MCP"]).toEqual({
      command: "validate-kit",
      args: ["mcp"],
    });

    // Existing servers and manual edits must survive a re-run untouched.
    writeFileSync(
      resolve(root, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "other-tool", args: [] },
            "Tester.MCP": { command: "custom", args: ["tweaked"] },
          },
        },
        null,
        2,
      ),
    );
    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    const after = JSON.parse(
      readFileSync(resolve(root, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(after.mcpServers["other"]).toEqual({
      command: "other-tool",
      args: [],
    });
    expect(after.mcpServers["Tester.MCP"]).toEqual({
      command: "custom",
      args: ["tweaked"],
    });
  });

  it("scaffolds a lefthook pre-commit running check --staged, preserving an existing one", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-hook-new-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    const hook = readFileSync(resolve(root, "lefthook.yml"), "utf8");
    expect(hook).toContain("pre-commit:");
    expect(hook).toContain("run: validate-kit check --staged");

    // A repo's existing lefthook config is never overwritten.
    writeFileSync(resolve(root, "lefthook.yml"), "custom: config\n");
    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    expect(readFileSync(resolve(root, "lefthook.yml"), "utf8")).toBe(
      "custom: config\n",
    );
  });

  it("does not shadow existing non-TS validate config files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-alt-"));
    const jsonConfig = resolve(root, "validate.config.json");
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(jsonConfig, '{"extends":"strict"}\n');

    // An existing config in another format is the repo's config: a plain
    // re-run leaves it alone and still wires the hook and MCP entry (a repo
    // scaffolded as JSON before it gained TypeScript must stay re-runnable).
    // --force is a hard stop: it must never create a second, shadowing config.
    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    expect(existsSync(resolve(root, "lefthook.yml"))).toBe(true);

    expect(readFileSync(jsonConfig, "utf8")).toBe('{"extends":"strict"}\n');
    expect(existsSync(resolve(root, "validate.config.ts"))).toBe(false);

    await expect(initCommand({ cwd: root, force: true })).resolves.toBe(
      EXIT.CONFIG,
    );
    expect(existsSync(resolve(root, "validate.config.ts"))).toBe(false);
  });

  it("rejects validate config directories instead of treating them as files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-dir-"));
    mkdirSync(resolve(root, "validate.config.ts"));

    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CONFIG);
    await expect(initCommand({ cwd: root, force: true })).resolves.toBe(
      EXIT.CONFIG,
    );
  });

  it("handles lefthook config during init without making lefthook required", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-init-hook-"));
    writeFileSync(resolve(root, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(resolve(root, "lefthook.yml"), "pre-commit:\n");

    await expect(initCommand({ cwd: root })).resolves.toBe(EXIT.CLEAN);
    expect(existsSync(resolve(root, "validate.config.ts"))).toBe(true);
  });

  it("fails doctor for outdated required tools without failing optional outdated tools", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-doctor-"));
    writeFileSync(resolve(root, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(root, "index.ts"), "export {};\n");
    const required = doctorAdapter("required-tool");
    const optional = doctorAdapter("optional-tool", true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a spy, read, never called
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    await expect(
      doctorCommand({
        cwd: root,
        json: true,
        adapters: [required, optional],
        detect: () => Promise.resolve(detectedTs(root)),
        availability: outdatedAvailability,
      }),
    ).resolves.toBe(EXIT.INCOMPLETE);
    const failedJson = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as {
      ok: boolean;
      tools: Array<{ id: string; status: string }>;
    };
    expect(failedJson.ok).toBe(false);
    expect(failedJson.tools).toEqual([
      expect.objectContaining({ id: "required-tool", status: "outdated" }),
      expect.objectContaining({ id: "optional-tool", status: "outdated" }),
    ]);

    stdout.mockClear();
    await expect(
      doctorCommand({
        cwd: root,
        json: true,
        adapters: [optional],
        detect: () => Promise.resolve(detectedTs(root)),
        availability: outdatedAvailability,
      }),
    ).resolves.toBe(EXIT.CLEAN);
    const optionalJson = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as {
      ok: boolean;
      tools: Array<{ id: string; status: string }>;
    };
    expect(optionalJson.ok).toBe(true);
    expect(optionalJson.tools[0]).toEqual(
      expect.objectContaining({ id: "optional-tool", status: "outdated" }),
    );
  });

  it("surfaces an unparseable tool version as version-unknown, not ok", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-doctor-ver-"));
    writeFileSync(resolve(root, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(root, "index.ts"), "export {};\n");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a spy, read, never called
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    // available but --version output unparseable → the min-version gate
    // CANNOT run; reporting "ok" would fail open on a possibly-too-old tool.
    await expect(
      doctorCommand({
        cwd: root,
        json: true,
        adapters: [doctorAdapter("weird-version-tool")],
        detect: () => Promise.resolve(detectedTs(root)),
        availability: (adapter) =>
          Promise.resolve({
            available: true,
            minVersion: adapter.minVersion,
            installHint: adapter.installHint,
          }),
      }),
    ).resolves.toBe(EXIT.CLEAN);
    const json = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as { ok: boolean; tools: Array<{ id: string; status: string }> };
    expect(json.tools[0]).toEqual(
      expect.objectContaining({
        id: "weird-version-tool",
        status: "version-unknown",
      }),
    );
    // soft warning: visible, but does not fail doctor
    expect(json.ok).toBe(true);
  });

  it("prints resolved ast-grep rule filters in list JSON", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-list-"));
    writeFileSync(resolve(root, "index.ts"), "export const value = 1;\n");
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "strict" }, null, 2),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a spy, read, never called
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    await expect(listCommand([root], { json: true })).resolves.toBe(EXIT.CLEAN);
    const payload = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as {
      tasks: Array<{ tool: string; options?: { ruleIds?: string[] } }>;
    };
    const astGrepTask = payload.tasks.find((task) => task.tool === "ast-grep");

    expect(astGrepTask?.options?.ruleIds).toContain("ts-no-explicit-any");
    expect(astGrepTask?.options?.ruleIds).toContain("rust-flag-unsafe-block");
  });

  it("applies check planning filters in list JSON", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-list-filters-"));
    writeFileSync(resolve(root, "index.ts"), "export const value = 1;\n");
    writeFileSync(resolve(root, "tsconfig.json"), "{}\n");
    writeFileSync(resolve(root, ".prettierrc"), "{}\n");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a spy, read, never called
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    await expect(
      listCommand([root], {
        json: true,
        layer: ["lint"],
        lang: ["ts"],
        only: ["oxlint"],
      }),
    ).resolves.toBe(EXIT.CLEAN);
    const filtered = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as {
      scope: { mode: string };
      tasks: Array<{ tool: string; layer: string }>;
    };

    expect(filtered.scope.mode).toBe("full");
    expect(filtered.tasks.map((task) => task.tool)).toEqual(["oxlint"]);
    expect(filtered.tasks.every((task) => task.layer === "lint")).toBe(true);

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

    stdout.mockClear();
    await expect(
      listCommand([root], {
        changed: true,
        json: true,
        only: ["prettier"],
      }),
    ).resolves.toBe(EXIT.CLEAN);
    const changed = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    ) as { scope: { mode: string }; tasks: Array<{ tool: string }> };

    expect(changed.scope.mode).toBe("changed");
  });

  it("rejects invalid or contradictory check/list filters before planning", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-bad-filters-"));

    await expect(
      listCommand([root], { json: true, layer: ["nope"] }),
    ).rejects.toThrow("Invalid layer 'nope'");
    await expect(
      listCommand([root], { json: true, lang: ["ruby"] }),
    ).rejects.toThrow("Invalid language 'ruby'");
    await expect(
      checkCommand([root], { json: true, only: ["not-a-tool"] }),
    ).rejects.toThrow("Invalid tool 'not-a-tool'");
    await expect(
      checkCommand([root], {
        json: true,
        only: ["oxlint"],
        disable: ["oxlint"],
      }),
    ).rejects.toThrow("Tool cannot be both --only and --disable: oxlint");
    await expect(
      checkCommand([root], { json: true, changed: true, staged: true }),
    ).rejects.toThrow("Choose only one scope filter: --changed, --staged");
  });

  it("rejects unsupported positional paths instead of widening or crashing", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-bad-path-"));
    const filePath = resolve(root, "index.ts");
    writeFileSync(filePath, "export const value = 1;\n");

    await expect(
      checkCommand([filePath], { json: true, only: ["prettier"] }),
    ).rejects.toThrow("Path must be a directory");
    await expect(
      listCommand([filePath], { json: true, only: ["prettier"] }),
    ).rejects.toThrow("Path must be a directory");
    await expect(
      checkCommand([resolve(root, "missing")], {
        json: true,
        only: ["prettier"],
      }),
    ).rejects.toThrow("Path does not exist");
    await expect(
      checkCommand([root, root], { json: true, only: ["prettier"] }),
    ).rejects.toThrow("Expected at most one directory path, received 2.");
  });

  it("rejects invalid SARIF output paths before running tools", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-bad-sarif-"));
    const filePath = resolve(root, "not-a-dir");
    writeFileSync(filePath, "content\n");

    await expect(
      checkCommand([root], { sarif: root, only: ["prettier"] }),
    ).rejects.toThrow("SARIF output path must be a file");
    await expect(
      checkCommand([root], {
        sarif: resolve(root, "missing", "out.sarif"),
        only: ["prettier"],
      }),
    ).rejects.toThrow("SARIF output directory does not exist");
    await expect(
      checkCommand([root], {
        sarif: resolve(filePath, "out.sarif"),
        only: ["prettier"],
      }),
    ).rejects.toThrow("SARIF output parent is not a directory");
  });

  it("scaffolds rules in an injected kit root and rejects duplicate scaffolds", async () => {
    const kitRoot = mkdtempSync(resolve(tmpdir(), "validate-kit-rules-"));

    expect(
      rulesNewCommand("ts", "style", "no-debugger-call", { kitRoot }),
    ).toBe(EXIT.CLEAN);
    expect(
      existsSync(
        resolve(
          kitRoot,
          "rules",
          "typescript",
          "style",
          "no-debugger-call.yml",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          kitRoot,
          "rule-tests",
          "typescript",
          "ts-no-debugger-call-test.yml",
        ),
      ),
    ).toBe(true);
    expect(
      rulesNewCommand("ts", "style", "no-debugger-call", { kitRoot }),
    ).toBe(EXIT.CONFIG);

    // A fresh scaffold must be VALID out of the box: compilable pattern +
    // fixtures that parse and match (the old prose placeholders made every
    // scaffold start life unparseable, indistinguishable from a broken rule).
    // Snapshot generation (--update-all) is the normal first-run step.
    writeFileSync(
      resolve(kitRoot, "sgconfig.yml"),
      "ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: rule-tests\n",
    );
    // The kit's own lookup finds its ast-grep (on Windows, the .cmd shim).
    const snap = await run("ast-grep", ["test", "--update-all"], {
      cwd: kitRoot,
    });
    expect(snap.exitCode, snap.stdout + snap.stderr).toBe(0);
    const agTest = await run("ast-grep", ["test"], { cwd: kitRoot });
    expect(agTest.exitCode, agTest.stdout + agTest.stderr).toBe(0);
  });

  it("rejects rule scaffolds when either output file already exists", () => {
    const kitRoot = mkdtempSync(resolve(tmpdir(), "validate-kit-rules-files-"));
    const testDir = resolve(kitRoot, "rule-tests", "typescript");
    const testPath = resolve(testDir, "ts-no-debugger-call-test.yml");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testPath, "sentinel\n");

    expect(
      rulesNewCommand("ts", "style", "no-debugger-call", { kitRoot }),
    ).toBe(EXIT.CONFIG);
    expect(readFileSync(testPath, "utf8")).toBe("sentinel\n");
  });

  it("rejects invalid rule scaffold inputs before writing files", () => {
    const kitRoot = mkdtempSync(resolve(tmpdir(), "validate-kit-rules-bad-"));

    expect(rulesNewCommand("java", "style", "nope", { kitRoot })).toBe(
      EXIT.CONFIG,
    );
    expect(rulesNewCommand("ts", "nonsense", "nope", { kitRoot })).toBe(
      EXIT.CONFIG,
    );
    expect(rulesNewCommand("ts", "style", "Nope", { kitRoot })).toBe(
      EXIT.CONFIG,
    );
    expect(existsSync(resolve(kitRoot, "rules"))).toBe(false);
  });
});
