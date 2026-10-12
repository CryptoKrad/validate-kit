import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/schema.js";
import { resolveConfig } from "../src/config/resolve.js";
import { osvScanner } from "../src/adapters/osv.js";
import { runCheck } from "../src/index.js";
import { EXIT } from "../src/core/exit-codes.js";
import type { ToolContext } from "../src/core/types.js";

function oasSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "t", version: "1.0" },
    paths,
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.invalid", ...args],
    { cwd, stdio: "ignore" },
  );
}

// Shape captured from a REAL `osv-scanner scan source --format json` run
// (v2.3.8) against a lockfile pinning lodash 4.17.15.
function osvJson(severity: string): string {
  return JSON.stringify({
    results: [
      {
        source: { path: "package-lock.json", type: "lockfile" },
        packages: [
          {
            package: { name: "lodash", version: "4.17.15", ecosystem: "npm" },
            vulnerabilities: [
              {
                id: "GHSA-29mw-wpgm-hmr9",
                aliases: ["CVE-2020-28500"],
                summary:
                  "Regular Expression Denial of Service (ReDoS) in lodash",
                database_specific: { severity },
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("plugin config schema (vulnAudit / apiDiff)", () => {
  it("accepts the plugin keys and rejects unknown subkeys", () => {
    expect(() =>
      parseConfig(
        {
          vulnAudit: { enabled: true, scanPaths: ["."], offline: true },
          apiDiff: {
            enabled: true,
            specs: ["apps/api/openapi.json"],
            baseRef: "origin/main",
          },
        },
        "inline",
      ),
    ).not.toThrow();
    expect(() => parseConfig({ vulnAudit: { bogus: true } }, "inline")).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ apiDiff: { bogus: true } }, "inline")).toThrow(
      ConfigError,
    );
  });

  it("defaults both plugins to disabled (opt-in gates)", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vk-plugin-defaults-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    const { config } = await resolveConfig(root);
    expect(config.vulnAudit.enabled).toBe(false);
    expect(config.apiDiff.enabled).toBe(false);
  });
});

describe("vulnAudit plugin (osv-scanner)", () => {
  it("maps OSV severities to finding severities on the lockfile", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      fix: false,
      extraArgs: [],
    };
    const critical = osvScanner.parseOutput(
      { stdout: osvJson("CRITICAL"), stderr: "", exitCode: 1 },
      ctx,
    );
    expect(critical.findings[0]).toMatchObject({
      tool: "osv-scanner",
      ruleId: "GHSA-29mw-wpgm-hmr9",
      severity: "error",
    });
    expect(critical.findings[0]?.message).toContain("lodash@4.17.15");
    expect(critical.findings[0]?.message).toContain("CVE-2020-28500");

    const moderate = osvScanner.parseOutput(
      { stdout: osvJson("MODERATE"), stderr: "", exitCode: 1 },
      ctx,
    );
    expect(moderate.findings[0]?.severity).toBe("warning");

    const low = osvScanner.parseOutput(
      { stdout: osvJson("LOW"), stderr: "", exitCode: 1 },
      ctx,
    );
    expect(low.findings[0]?.severity).toBe("info");
  });

  it("fails loud on nonzero exit without scan JSON", () => {
    const ctx: ToolContext = { cwd: process.cwd(), fix: false, extraArgs: [] };
    expect(() =>
      osvScanner.parseOutput(
        { stdout: "", stderr: "No package sources found", exitCode: 128 },
        ctx,
      ),
    ).toThrow(/osv-scanner/);
  });

  it("is opt-in: runs only when vulnAudit.enabled and reports lockfile vulns", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vk-osv-"));
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    writeFileSync(resolve(root, "package-lock.json"), "{}\n");
    // fake osv-scanner on the project-local bin path so the test needs no
    // network — output is the captured real v2 shape.
    const binDir = resolve(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const fake = resolve(binDir, "osv-scanner");
    writeFileSync(
      fake,
      `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "osv-scanner version: 2.3.8"; exit 0; fi\ncat <<'JSON'\n${osvJson("HIGH")}\nJSON\nexit 1\n`,
    );
    chmodSync(fake, 0o755);

    // Disabled (default): the gate must not run — explicitly requesting the
    // tool while the gate is off fails loud via the no-matching-tasks guard.
    await expect(
      runCheck({ cwd: root, onlyTools: ["osv-scanner"] }),
    ).rejects.toThrow(/No validation tasks matched/);
    const offPlan = await runCheck({ cwd: root });
    expect(offPlan.summary.ranTools).not.toContain("osv-scanner");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ vulnAudit: { enabled: true } }, null, 2),
    );
    const on = await runCheck({ cwd: root, onlyTools: ["osv-scanner"] });
    expect(on.summary.crashed).toEqual([]);
    const vuln = on.summary.findings.find(
      (f) => f.ruleId === "GHSA-29mw-wpgm-hmr9",
    );
    if (!vuln) throw new Error("expected the OSV finding");
    expect(vuln.severity).toBe("error");
    expect(vuln.file.endsWith("package-lock.json")).toBe(true);
    expect(on.summary.exitCode).toBe(EXIT.FINDINGS);
  });
});

describe("apiDiff plugin (oasdiff)", () => {
  it("reports breaking API changes vs the base ref from a real git repo", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vk-oas-"));
    git(root, "init", "-q");
    const get = { get: { responses: { 200: { description: "ok" } } } };
    writeFileSync(
      resolve(root, "openapi.json"),
      oasSpec({ "/users": get, "/legacy": get }),
    );
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          apiDiff: {
            enabled: true,
            specs: ["openapi.json"],
            baseRef: "HEAD",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base spec");

    // HEAD keeps /legacy; the worktree removes it → breaking change.
    writeFileSync(resolve(root, "openapi.json"), oasSpec({ "/users": get }));

    const result = await runCheck({ cwd: root, onlyTools: ["oasdiff"] });
    expect(result.summary.crashed).toEqual([]);
    const breaking = result.summary.findings.find(
      (f) => f.ruleId === "api-path-removed-without-deprecation",
    );
    if (!breaking) throw new Error("expected a breaking-change finding");
    expect(breaking.severity).toBe("error");
    expect(breaking.file.endsWith("openapi.json")).toBe(true);
    expect(breaking.message).toContain("/legacy");
  }, 60_000);

  it("crashes loud when the base ref is unavailable instead of passing", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vk-oas-noref-"));
    git(root, "init", "-q");
    writeFileSync(
      resolve(root, "openapi.json"),
      '{"openapi":"3.0.0","info":{"title":"t","version":"1.0"},"paths":{}}',
    );
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify(
        {
          apiDiff: {
            enabled: true,
            specs: ["openapi.json"],
            baseRef: "origin/definitely-missing",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(resolve(root, "index.ts"), "const value = 1;\n");

    const result = await runCheck({ cwd: root, onlyTools: ["oasdiff"] });
    expect(result.summary.exitCode).toBe(EXIT.INTERNAL);
    expect(result.summary.crashed[0]?.id).toBe("oasdiff");
    expect(result.summary.crashed[0]?.stderr).toContain(
      "origin/definitely-missing",
    );
  });
});
