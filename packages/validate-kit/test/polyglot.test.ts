import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/index.js";

// Requires the full polyglot toolchain (rust/clippy/rustfmt, go/golangci/gofumpt,
// python/ruff) + ast-grep. Run in a CI job that installs them (see poly.yml).
const here = dirname(fileURLToPath(import.meta.url));
const services = resolve(here, "../../../services");

describe("polyglot — custom rules fire on real Rust/Go/Python services", () => {
  it("each service trips its seeded rule and native linters stay clean", async () => {
    const { summary, detection } = await runCheck({ cwd: services });

    expect(detection.has("rust")).toBe(true);
    expect(detection.has("go")).toBe(true);
    expect(detection.has("python")).toBe(true);

    const ruleIds = summary.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("rust-no-unwrap");
    expect(ruleIds).toContain("go-no-panic");
    expect(ruleIds).toContain("py-no-print");

    // clippy, golangci-lint, ruff, rustfmt, gofumpt ran without crashing or
    // being reported missing — the framework drives them all on real code.
    expect(summary.incomplete).toHaveLength(0);
    expect(summary.crashed).toHaveLength(0);
    expect(summary.exitCode).toBe(1);
  }, 120_000);
});

// Canary: each native linter adapter must parse a REAL finding from the tool's
// own machine output on a known-bad fixture. The polyglot suite above only
// asserts custom ast-grep rules fire + native tools don't crash, so a tool that
// renamed its JSON schema (parse → 0 native findings) would still pass there.
// These exercise the native parse path directly so a silent-zero fails loud.
describe("native linters parse their own findings (schema-break canary)", () => {
  it("ruff parses a real F401 from its JSON output", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "vk-canary-ruff-"));
    writeFileSync(resolve(dir, "bad.py"), "import os\n");
    writeFileSync(resolve(dir, "pyproject.toml"), "[tool.ruff]\n");
    const { summary } = await runCheck({ cwd: dir, onlyTools: ["ruff"] });
    const ruff = summary.findings.filter((f) => f.tool === "ruff");
    expect(ruff.length).toBeGreaterThanOrEqual(1);
    expect(
      ruff.some((f) => f.ruleId === "F401" && f.severity === "error"),
    ).toBe(true);
    expect(summary.crashed).toHaveLength(0);
  }, 60_000);

  it("clippy parses a real diagnostic from its JSON-lines stream", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "vk-canary-clippy-"));
    mkdirSync(resolve(dir, "src"));
    writeFileSync(
      resolve(dir, "Cargo.toml"),
      '[package]\nname = "vk_canary_clippy"\nversion = "0.0.0"\nedition = "2021"\n',
    );
    writeFileSync(
      resolve(dir, "src", "main.rs"),
      "fn main() {\n    let unused = 1;\n}\n",
    );
    const { summary } = await runCheck({ cwd: dir, onlyTools: ["clippy"] });
    const clippy = summary.findings.filter((f) => f.tool === "clippy");
    expect(clippy.length).toBeGreaterThanOrEqual(1);
    expect(clippy.some((f) => f.ruleId === "unused_variables")).toBe(true);
    expect(summary.crashed).toHaveLength(0);

    // WARM-cache contract (A-H1): cargo must REPLAY cached diagnostics as
    // compiler-message JSON when the crate is fresh — otherwise a second run
    // on an unchanged crate silently reports CLEAN. Verified empirically on
    // clippy 0.1.96 (replayed JSON is field-identical to the live run); this
    // pins that contract so a cargo regression fails here, not in production.
    const rerun = await runCheck({ cwd: dir, onlyTools: ["clippy"] });
    const warm = rerun.summary.findings.filter((f) => f.tool === "clippy");
    expect(warm.some((f) => f.ruleId === "unused_variables")).toBe(true);
    expect(rerun.summary.crashed).toHaveLength(0);
  }, 180_000);

  it("golangci-lint parses a real Issues[] entry from its JSON output", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "vk-canary-go-"));
    writeFileSync(resolve(dir, "go.mod"), "module vkcanarygo\n\ngo 1.21\n");
    writeFileSync(
      resolve(dir, "main.go"),
      "package main\n\nfunc compute() int {\n\tx := 1\n\tx = 2\n\treturn x\n}\n\nfunc main() {\n\t_ = compute()\n}\n",
    );
    const { summary } = await runCheck({
      cwd: dir,
      onlyTools: ["golangci-lint"],
    });
    const go = summary.findings.filter((f) => f.tool === "golangci-lint");
    expect(go.length).toBeGreaterThanOrEqual(1);
    expect(go.some((f) => f.ruleId === "ineffassign")).toBe(true);
    expect(summary.crashed).toHaveLength(0);
  }, 120_000);
});
