import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectLanguages, runCheck } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../samples");

describe("engine — behavioral (runs real tools against samples/)", () => {
  it("detects every seeded language", async () => {
    const detection = await detectLanguages(samples);
    for (const lang of ["ts", "js"] as const) {
      expect(detection.has(lang), `expected to detect ${lang}`).toBe(true);
    }
  });

  it("reports the expected recommended custom-rule and oxlint findings", async () => {
    const { summary } = await runCheck({ cwd: samples });
    const ids = summary.findings.map((f) => `${f.tool}:${f.ruleId ?? ""}`);

    expect(ids).toContain("ast-grep:ts-no-loose-equality");
    expect(ids).toContain("ast-grep:ts-no-console");
    expect(ids).not.toContain("ast-grep:ts-no-explicit-any");
    expect(ids.some((i) => i.startsWith("oxlint:"))).toBe(true);

    // a real error-severity finding ⇒ non-clean exit
    expect(summary.findings.some((f) => f.severity === "error")).toBe(true);
    expect(summary.exitCode).toBe(1);
    // no required tool missing, no adapter crash
    expect(summary.incomplete).toHaveLength(0);
    expect(summary.crashed).toHaveLength(0);
  }, 60_000);

  it("never silently passes when a finding exists", async () => {
    const { summary } = await runCheck({ cwd: samples });
    expect(summary.exitCode).not.toBe(0);
  }, 60_000);

  it("custom rules cover tsx, js, and jsx files, not just .ts", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-langcov-"));
    writeFileSync(
      resolve(root, "widget.tsx"),
      'export function App(): unknown {\n  console.log("debug");\n  return <div>{eval("x")}</div>;\n}\n',
    );
    writeFileSync(
      resolve(root, "script.js"),
      'const ok = 1 == "1";\nconsole.log(ok);\n',
    );
    writeFileSync(
      resolve(root, "component.jsx"),
      'export function Widget() {\n  console.log("debug");\n  return <span />;\n}\n',
    );
    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "recommended" }, null, 2),
    );

    const { summary } = await runCheck({ cwd: root, onlyTools: ["ast-grep"] });
    const byFile = (name: string) =>
      summary.findings
        .filter((f) => f.file.endsWith(name))
        .map((f) => f.ruleId);

    expect(byFile("widget.tsx")).toContain("tsx-no-console");
    expect(byFile("widget.tsx")).toContain("tsx-no-eval");
    expect(byFile("script.js")).toContain("js-no-console");
    expect(byFile("script.js")).toContain("js-no-loose-equality");
    // ast-grep's `javascript` grammar includes JSX, so the js- variant
    // covers .jsx too (verified empirically on ast-grep 0.43).
    expect(byFile("component.jsx")).toContain("js-no-console");
    expect(summary.crashed).toHaveLength(0);
  }, 60_000);

  it("filters bundled ast-grep rules by the selected preset", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-preset-"));
    writeFileSync(
      resolve(root, "index.ts"),
      "export const id = (value: any) => value;\n",
    );

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "recommended" }, null, 2),
    );
    const recommended = await runCheck({ cwd: root, onlyTools: ["ast-grep"] });
    expect(
      recommended.summary.findings.map((finding) => finding.ruleId),
    ).not.toContain("ts-no-explicit-any");

    writeFileSync(
      resolve(root, "validate.config.json"),
      JSON.stringify({ extends: "strict" }, null, 2),
    );
    const strict = await runCheck({ cwd: root, onlyTools: ["ast-grep"] });
    expect(strict.summary.findings.map((finding) => finding.ruleId)).toContain(
      "ts-no-explicit-any",
    );
  }, 60_000);
});
