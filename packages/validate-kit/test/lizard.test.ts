import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lizard } from "../src/adapters/lizard.js";
import type { PlanEnv, TaskSeed, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// lizard 1.24.0 `--warnings_only` on a TypeScript function of CCN 17
// (docs/research/lint-toolchain/lizard.md).
const WARNINGS =
  "a.ts:1: warning: route has 9 NLOC, 17 CCN, 155 token, 2 PARAM, 9 length, 0 ND\n";

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, files: string[]): ToolContext {
  const scratch = tmp("vk-lizard-scratch-");
  return {
    cwd,
    fix: false,
    extraArgs: [],
    options: { files },
    tempDir: () => scratch,
  };
}

function plan(root: string, enabled: boolean, changedPaths?: string[]) {
  const env = {
    projectRoot: root,
    scopedFiles: ["a.ts", "b.py", "README.md", "c.go"].map(
      (f) => `${root}/${f}`,
    ),
    toolConfig: enabled ? { enabled: true } : {},
    ...(changedPaths ? { changedPaths } : {}),
  } as unknown as PlanEnv;
  return (lizard.expand?.({ cwd: root }, env) ?? []) as TaskSeed[];
}

describe("lizard", () => {
  it("reports each function over the bound at its first line", () => {
    const root = tmp("vk-lizard-");
    const result = lizard.parseOutput(
      { stdout: WARNINGS, stderr: "", exitCode: 1 },
      ctx(root, ["a.ts"]),
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
        f.message,
      ]),
    ).toEqual([
      [
        "a.ts",
        1,
        "ccn",
        "warning",
        "route has a cyclomatic complexity of 17 (9 lines, 2 parameters): split it, or record it in the baseline",
      ],
    ]);
  });

  it("runs where the project chose it, on its code files, listed in a file", () => {
    const root = tmp("vk-lizard-");
    expect(plan(root, false)).toEqual([]);
    const [task] = plan(root, true);
    expect(task?.options).toEqual({ files: ["a.ts", "b.py", "c.go"] });
    expect(plan(root, true, ["b.py"])[0]?.options).toEqual({
      files: ["b.py"],
    });
    writeFileSync(join(root, "whitelizard.txt"), "");
    expect(plan(root, false)).toHaveLength(1);
    const built = lizard.buildArgs(ctx(root, ["a.ts", "b.py"]));
    const list = built.args[built.args.indexOf("-f") + 1] ?? "";
    expect(readFileSync(list, "utf8")).toBe("a.ts\nb.py\n");
    expect(built.args.slice(0, 5)).toEqual([
      "--warnings_only",
      "--length",
      "1000000",
      "--arguments",
      "1000000",
    ]);
    expect(lizard.refuseArgs?.(["-L", "200"])).toMatch(/kit's/);
    expect(() =>
      lizard.parseOutput(
        {
          stdout: "",
          stderr: "Error: Fail to read source file 'a.ts'\n",
          exitCode: 0,
        },
        ctx(root, ["a.ts"]),
      ),
    ).toThrow(/could not read a.ts/);
    expect(lizard.refuseArgs?.(["--csv"])).toMatch(/kit's/);
    expect(lizard.refuseArgs?.(["-C", "20"])).toBeUndefined();
  });
});
