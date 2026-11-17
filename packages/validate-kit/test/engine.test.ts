import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectLanguages, planCheck, runCheck } from "../src/index.js";
import { quint } from "../src/adapters/quint.js";
import { resolveConfig } from "../src/config/resolve.js";
import { execute } from "../src/core/runner.js";
import type { ToolAdapter } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";
import { toJson } from "../src/report/json.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../samples");

describe("engine — behavioral (runs real tools against samples/)", () => {
  it("the Quint runner normalizes native and relative diagnostic paths before JSON output", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "vk-quint-diagnostic-"));
    try {
      const spec = resolve(root, "model.qnt");
      writeFileSync(spec, "module model {\n  val broken = true + 1\n}\n");
      const planned = await planCheck({ cwd: root, onlyTools: ["quint"] });
      const { config } = await resolveConfig(root);
      expect(planned.tasks).toHaveLength(1);
      const results = await Promise.all(
        [spec, "model.qnt"].map(async (source) => {
          // Shape captured from native Quint 0.33.1 typecheck --out JSON.
          const output = JSON.stringify({
            step: "typecheck",
            exit: 1,
            errors: [
              {
                explanation: "Expected an int, found a bool",
                locs: [{ source, start: { line: 1, col: 15 } }],
              },
            ],
          });
          const adapter: ToolAdapter = {
            ...quint,
            bin: process.execPath,
            versionArgs: ["-e", 'process.stdout.write("0.33.1")'],
            buildArgs: () => ({
              bin: process.execPath,
              args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
            }),
          };
          const summary = await execute({
            projectRoot: root,
            config,
            tasks: planned.tasks.map((task) => ({ ...task, adapter })),
            fix: false,
            scope: planned.scope,
          });
          const json = JSON.parse(toJson(summary)) as {
            findings: { file: string; line: number; col: number }[];
          };
          return { summary, json };
        }),
      );
      for (const { summary, json } of results) {
        expect(summary.ranTools).toEqual(["quint"]);
        expect(summary.exitCode).toBe(1);
        expect(summary.crashed).toEqual([]);
        expect(summary.incomplete).toEqual([]);
        expect(json.findings).toEqual([
          expect.objectContaining({
            file: toPosix(spec),
            line: 2,
            col: 16,
            ruleId: "quint/error",
            message: "Expected an int, found a bool",
          }),
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the public Quint plan recognizes relative imported helpers on the current platform", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "validate-kit-quint-imports-"));
    mkdirSync(resolve(root, "good"));
    writeFileSync(
      resolve(root, "good/counter.qnt"),
      'module counter {\n import helpers.* from "./helpers"\n import plain.* from "plain"\n}\n',
    );
    writeFileSync(resolve(root, "good/helpers.qnt"), "module helpers {}\n");
    writeFileSync(resolve(root, "good/plain.qnt"), "module plain {}\n");
    writeFileSync(resolve(root, "lonely.qnt"), "module lonely {}\n");
    const planned = await planCheck({ cwd: root, onlyTools: ["quint"] });
    const imports = Object.fromEntries(
      planned.tasks.map((task) => {
        const options = task.options as { spec: string; imported: boolean };
        return [
          options.spec.slice(options.spec.lastIndexOf("/") + 1),
          options.imported,
        ];
      }),
    );
    expect(imports).toEqual({
      "counter.qnt": false,
      "helpers.qnt": true,
      "plain.qnt": true,
      "lonely.qnt": false,
    });
  });

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

  it.each([
    ["exec('pass')  # noqa: S102\n", 0],
    ["exec('pass')  # noqa: S307\n", 1],
    ["exec('pass')\n# noqa: S102\n", 1],
    ["exec('pass')  # noqa: S102\nexec('pass')\n", 1],
  ])(
    "keeps Python suppression and scanner results distinct: %s",
    async (source, expected) => {
      const root = mkdtempSync(resolve(tmpdir(), "validate-kit-suppression-"));
      writeFileSync(resolve(root, "harness.py"), source);
      writeFileSync(
        resolve(root, "validate.config.json"),
        JSON.stringify({ extends: "recommended" }),
      );
      const { summary } = await runCheck({
        cwd: root,
        profile: "ci",
        onlyTools: ["ast-grep"],
      });
      expect(summary.crashed).toEqual([]);
      expect(summary.incomplete).toEqual([]);
      expect(summary.exitCode).toBe(expected);
      expect(summary.findings.map((finding) => finding.ruleId)).toEqual(
        expected ? ["py-no-eval-exec"] : [],
      );
    },
  );
});
