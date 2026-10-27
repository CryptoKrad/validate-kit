import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffCover } from "../src/adapters/diff-cover.js";
import type { PlanEnv, TaskSeed, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// diff-cover 10.6.0 `--format json:` on a branch adding a covered clamp()
// and an untested line 10, with a second file's run of lines added
// (docs/research/lint-toolchain/diff-cover.md).
const REPORT = {
  report_name: "LCOV",
  src_stats: {
    "src/math.ts": { violation_lines: [10] },
    "src/fee.ts": { violation_lines: [9, 3, 4, 5] },
  },
};

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, options?: unknown): ToolContext {
  return { cwd, fix: false, extraArgs: [], options, tempDir: () => cwd };
}

function plan(root: string, tools: Record<string, unknown>): TaskSeed[] {
  const env = {
    projectRoot: root,
    scopedFiles: [],
    toolConfig: tools,
    config: { tools: { "diff-cover": tools } },
  } as unknown as PlanEnv;
  return (diffCover.expand?.({ cwd: root }, env) ?? []) as TaskSeed[];
}

describe("diff-cover", () => {
  it("reports each run of changed lines no test runs", () => {
    const root = tmp("vk-diffcover-");
    writeFileSync(join(root, "diff-cover.json"), JSON.stringify(REPORT));
    const result = diffCover.parseOutput(
      { stdout: "", stderr: "", exitCode: 0 },
      ctx(root, {
        reports: ["lcov.info"],
        compareBranch: "main",
        top: root,
        sources: ["src/math.ts"],
      }),
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.message,
      ]),
    ).toEqual([
      [
        "src/math.ts",
        10,
        "uncovered-change",
        "line 10 changed and no test runs it",
      ],
      [
        "src/fee.ts",
        3,
        "uncovered-change",
        "lines 3-5 changed and no test runs them",
      ],
      [
        "src/fee.ts",
        9,
        "uncovered-change",
        "line 9 changed and no test runs it",
      ],
    ]);
    expect(() =>
      diffCover.parseOutput(
        { stdout: "", stderr: "No coverage report", exitCode: 1 },
        ctx(tmp("vk-diffcover-")),
      ),
    ).toThrow(/wrote no report: No coverage report/);
    // A report whose paths match no changed source checked nothing.
    const none = tmp("vk-diffcover-");
    writeFileSync(join(none, "diff-cover.json"), '{"src_stats": {}}');
    expect(() =>
      diffCover.parseOutput(
        { stdout: "", stderr: "", exitCode: 0 },
        ctx(none, { top: none, sources: ["pkg/src/a.ts"] }),
      ),
    ).toThrow(
      /matched none of the 1 changed source file\(s\) \(pkg\/src\/a.ts\)/,
    );
  });

  it("runs only where chosen, with a fresh report, against a branch it can diff", () => {
    const root = tmp("vk-diffcover-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    expect(plan(root, {})).toEqual([]);
    expect(plan(root, { enabled: true })[0]?.cannotRun).toMatch(
      /no coverage report.*coverage\/lcov.info/,
    );
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "a.test.ts"), "// test\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "src", "a.test.ts"), "// test 2\n");
    writeFileSync(join(root, "cov.info"), "TN:\n");
    const [ready] = plan(root, {
      enabled: true,
      options: { reports: ["cov.info"] },
    });
    // origin/HEAD and origin/main are missing here: main.
    expect(ready?.options).toMatchObject({
      reports: [join(root, "cov.info")],
      compareBranch: "main",
      sources: ["src/a.ts"],
    });
    const built = diffCover.buildArgs(ctx(root, ready?.options));
    expect(built.args.slice(0, 4)).toEqual([
      join(root, "cov.info"),
      "--compare-branch",
      "main",
      "--format",
    ]);
    // A report written before the change judged code it never saw.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, "cov.info"), past, past);
    expect(
      plan(root, { enabled: true, options: { reports: ["cov.info"] } })[0]
        ?.cannotRun,
    ).toMatch(/older than src\/a(.test)?.ts/);
    expect(
      plan(root, {
        enabled: true,
        options: { reports: ["cov.info"], compareBranch: "nope" },
      })[0]?.cannotRun,
    ).toMatch(/no merge base with nope/);
    // A named report that is missing is not coverage of nothing.
    expect(
      plan(root, {
        enabled: true,
        options: { reports: ["cov.info", "py.xml"] },
      })[0]?.cannotRun,
    ).toMatch(/no coverage report \(py.xml\)/);
  }, 120_000);

  it("refuses the flags that decide what it reads, abbreviated too", () => {
    for (const args of [
      ["--fail-under", "80"],
      ["--fail-u", "80"],
      ["--form", "markdown:x.md"],
      ["--compare-branch", "x"],
      ["--diff-file=d.diff"],
      ["-c", "cfg.toml"],
    ])
      expect(diffCover.refuseArgs?.(args)).toMatch(/kit's/);
    expect(diffCover.refuseArgs?.(["--exclude", "gen/*"])).toBeUndefined();
    expect(diffCover.tier).toBe("deep");
  });
});
