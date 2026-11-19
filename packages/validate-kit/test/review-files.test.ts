import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/api.js";
import "./isolated-git.js";

/** A git repository holding `files`, all tracked unless named in `leave`. */
function repo(files: Record<string, string>, leave: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "vk-review-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const tracked = Object.keys(files).filter((path) => !leave.includes(path));
  if (tracked.length > 0) git("add", "--", ...tracked);
  return root;
}

/** `tool`'s findings in `root`, as `path:line rule`. */
async function found(root: string, tool: string): Promise<string[]> {
  const { summary, projectRoot } = await runCheck({
    cwd: root,
    onlyTools: [tool],
  });
  return summary.findings
    .filter((finding) => finding.tool === tool)
    .map(
      (finding) =>
        `${finding.file.slice(projectRoot.length + 1)}:${finding.line} ${finding.ruleId}`,
    )
    .toSorted();
}

const SKILL = ".claude/skills/api-review/SKILL.md";
/** A Markdown link to a file of the repository. */
const link = (n: number) => `[rule ${n}](docs/rule-${n}.md)`;

describe("review-md: what Code Review would drop from a REVIEW.md", () => {
  it("passes the documented layout: a root file, two includes, a skill, a subfolder file", async () => {
    const root = repo({
      "REVIEW.md": `# Review instructions\n\nReport at most five Nits per review.\n\n@review-security.md\n@review-api.md\n@${SKILL}\n\nSee [the guide](https://example.com/guide) and [the cap](#cap).\n`,
      "review-security.md": "Flag a secret in a log line.\n",
      "review-api.md": "New routes have an integration test.\n",
      [SKILL]: "---\nname: api-review\n---\nCheck the route table.\n",
      "services/billing/REVIEW.md": "Amounts are strings.\n",
    });
    expect(await found(root, "review-md")).toEqual([]);
  });

  it("reports an include that names no file, a path into a folder, and a name with a space", async () => {
    const root = repo({
      "REVIEW.md":
        "@Review-Security.md\n@docs/review-rules.md\n@review rules.md\n",
      "review-security.md": "x\n",
      "docs/review-rules.md": "y\n",
      "review rules.md": "z\n",
    });
    expect(await found(root, "review-md")).toEqual([
      "REVIEW.md:1 include-missing",
      "REVIEW.md:2 include-path",
      "REVIEW.md:3 include-with-space",
    ]);
  });

  it("reports a ninth file, an include inside an included file, and one in a subfolder file", async () => {
    const names = Array.from({ length: 9 }, (_, n) => `rules-${n + 1}.md`);
    const root = repo({
      "REVIEW.md": `${names.map((name) => `@${name}`).join("\n")}\n@rules-1.md\n`,
      ...Object.fromEntries(names.map((name) => [name, "a rule\n"])),
      "rules-2.md": "a rule\n@rules-3.md\n",
      "apps/api/REVIEW.md": "@rules-1.md\n",
    });
    expect(await found(root, "review-md")).toEqual([
      "REVIEW.md:9 too-many-includes",
      "apps/api/REVIEW.md:1 nested-include",
      "rules-2.md:2 nested-include",
    ]);
  });

  it("reports the 150,000 bytes passed, and the 65th link to a repository file", async () => {
    const big = repo({
      "REVIEW.md": "@big.md\n@small.md\n",
      "big.md": "x".repeat(150_000),
      "small.md": "fits\n",
    });
    expect(await found(big, "review-md")).toEqual(["REVIEW.md:1 too-large"]);
    const linked = (count: number) =>
      repo({
        "REVIEW.md": `${Array.from({ length: count - 1 }, (_, n) => link(n)).join(" ")}\n@more.md\n[web](https://example.com) [top](#top)\n`,
        "more.md": `${link(count)}\n`,
      });
    expect(await found(linked(64), "review-md")).toEqual([]);
    expect(await found(linked(65), "review-md")).toEqual([
      "REVIEW.md:1 too-many-links",
    ]);
  });

  it("reports a skill that is not included: a wrong path, a missing file, a link, its size, a fence", async () => {
    const root = repo({
      "REVIEW.md": `@.claude/commands/review.md\n@.claude/skills/gone/SKILL.md\n@.claude/skills/linked/SKILL.md\n@.claude/skills/huge/SKILL.md\n\n\`\`\`markdown\n@${SKILL}\n@review-api.md\n\`\`\`\n\n@.claude/skills/folder/SKILL.md\n`,
      ".claude/commands/review.md": "x\n",
      ".claude/skills/huge/SKILL.md": "y".repeat(30_001),
      [SKILL]: "ok\n",
      "real/SKILL.md": "target\n",
    });
    symlinkSync(
      join(root, "real", "SKILL.md"),
      join(root, ".claude", "skills", "linked-SKILL.md"),
    );
    mkdirSync(join(root, ".claude", "skills", "linked"));
    symlinkSync(
      join(root, "real", "SKILL.md"),
      join(root, ".claude", "skills", "linked", "SKILL.md"),
    );
    symlinkSync(join(root, "real"), join(root, ".claude", "skills", "folder"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    expect(await found(root, "review-md")).toEqual([
      ".claude/skills/huge/SKILL.md:1 skill-too-large",
      "REVIEW.md:1 skill-path",
      "REVIEW.md:11 skill-symlink",
      "REVIEW.md:2 include-missing",
      "REVIEW.md:3 skill-symlink",
      "REVIEW.md:7 include-in-block",
    ]);
  });

  it("reads an include of a file the config ignores, a mention, and a decorator in a sample, as Code Review does", async () => {
    const root = repo({
      "validate.config.json": '{ "ignore": [".claude/**", "CHANGELOG.md"] }',
      "REVIEW.md": `@${SKILL}\n@CHANGELOG.md\n@review-python.md\n@security-team\n`,
      [SKILL]: "ok\n",
      "CHANGELOG.md": "0.1.0\n",
      "review-python.md":
        "A fixture looks like this:\n\n```python\n@pytest.fixture\ndef db(): ...\n```\n\n@Override\n",
      "apps/api/REVIEW.md": "```java\n@rules.md\n```\n",
    });
    expect(await found(root, "review-md")).toEqual([]);
  });

  it("takes a tag named in prose for prose, and an open comment for a block", async () => {
    const prose = repo({
      "REVIEW.md":
        "Never add a `<script>` tag, a <present> element or an arrow -->.\n@gone.md\n",
    });
    expect(await found(prose, "review-md")).toEqual([
      "REVIEW.md:2 include-missing",
    ]);
    const block = repo({
      "REVIEW.md": `<!-- off for now\n@${SKILL}\n-->\n<pre>a --> b\n@${SKILL}\n</pre>\n@${SKILL}\n`,
      [SKILL]: "ok\n",
    });
    expect(await found(block, "review-md")).toEqual([
      "REVIEW.md:2 include-in-block",
      "REVIEW.md:5 include-in-block",
    ]);
  });

  it("warns about what a review does not get from a skill: a command and an argument", async () => {
    const root = repo({
      "REVIEW.md": `@${SKILL}\n`,
      [SKILL]:
        "Changed files:\n!`git diff --name-only`\nReview $ARGUMENTS only.\n",
    });
    expect(await found(root, "review-md")).toEqual([
      `${SKILL}:2 skill-command`,
      `${SKILL}:3 skill-substitution`,
    ]);
  });

  it("adds up the subfolder files one change reads: a folder's file and the files above it", async () => {
    const half = "x".repeat(80_000);
    const root = repo({
      "REVIEW.md": half,
      "packages/REVIEW.md": half,
      "packages/api/REVIEW.md": half,
      "packages/web/REVIEW.md": "short\n",
      "packages/tests/REVIEW.md": half,
      "apps/REVIEW.md": half,
    });
    expect(await found(root, "review-md")).toEqual([
      "packages/api/REVIEW.md:1 too-large",
      "packages/tests/REVIEW.md:1 skipped-folder",
    ]);
  });

  it("adds the files the check itself does not list: above a project below the repository's top, and under the config's `ignore`", async () => {
    const root = repo({
      "REVIEW.md": "Root rules.\n",
      "packages/REVIEW.md": "x".repeat(100_000),
      "packages/kit/REVIEW.md": "x".repeat(60_000),
      "legacy/REVIEW.md": "x".repeat(100_000),
      "legacy/api/REVIEW.md": "x".repeat(60_000),
      "validate.config.json": '{ "ignore": ["legacy/REVIEW.md"] }',
    });
    expect(await found(join(root, "packages/kit"), "review-md")).toEqual([
      "REVIEW.md:1 too-large",
    ]);
    expect(await found(root, "review-md")).toEqual([
      "legacy/api/REVIEW.md:1 too-large",
      "packages/kit/REVIEW.md:1 too-large",
    ]);
  });

  it("reports a REVIEW.md under a folder Code Review never reads one from, in any case", async () => {
    const root = repo({
      "REVIEW.md": "Root rules.\n",
      "packages/api/Tests/REVIEW.md": "never read\n",
      "vendor/lib/docs/REVIEW.md": "never read\n",
      "integration-tests/REVIEW.md": "read: the name matches only as a whole\n",
    });
    expect(await found(root, "review-md")).toEqual([
      "packages/api/Tests/REVIEW.md:1 skipped-folder",
      "vendor/lib/docs/REVIEW.md:1 skipped-folder",
    ]);
  });
});

describe("the config's `ignore` covers both checks", () => {
  it("leaves a REVIEW.md and a saved case under an ignored folder alone", async () => {
    const files = {
      "REVIEW.md": "Root rules.\n",
      "legacy/tests/REVIEW.md": "never read\n",
      "legacy/Cargo.toml": '[package]\nname = "old"\nversion = "0.1.0"\n',
      "legacy/proptest-regressions/lib.txt": "cc 4f6a2b seed\n",
    };
    const left = ["legacy/proptest-regressions/lib.txt"];
    const tools = ["review-md", "saved-failures"];
    const reported = async (root: string) =>
      (await Promise.all(tools.map((tool) => found(root, tool)))).flat();
    expect(await reported(repo(files, left))).toEqual([
      "legacy/tests/REVIEW.md:1 skipped-folder",
      "legacy/proptest-regressions/lib.txt:1 untracked",
    ]);
    const ignoring = repo(
      { ...files, "validate.config.json": '{ "ignore": ["legacy/**"] }' },
      left,
    );
    expect(await reported(ignoring)).toEqual([]);
  });
});

describe("saved-failures: a saved failing case git does not track", () => {
  const CRATE = {
    "Cargo.toml": '[package]\nname = "money"\nversion = "0.1.0"\n',
    "src/lib.rs": "pub fn f() {}\n",
    "proptest-regressions/lib.txt": "cc 4f6a2b seed\n",
  };
  const GO = {
    "go.mod": "module example.com/feed\n\ngo 1.25\n",
    "feed/feed_test.go": "package feed\n",
    "feed/testdata/fuzz/FuzzParse/a878c3134fe0":
      'go test fuzz v1\nstring("x")\n',
    "feed/testdata/rapid/TestStep/TestStep-1.fail": "# seed\n",
  };

  it("is silent when every saved case is tracked", async () => {
    expect(await found(repo({ ...CRATE, ...GO }), "saved-failures")).toEqual(
      [],
    );
  });

  it("reports proptest's, Go's and rapid's saved cases left out of git", async () => {
    const root = repo({ ...CRATE, ...GO }, [
      "proptest-regressions/lib.txt",
      "feed/testdata/fuzz/FuzzParse/a878c3134fe0",
      "feed/testdata/rapid/TestStep/TestStep-1.fail",
    ]);
    expect(await found(root, "saved-failures")).toEqual([
      "feed/testdata/fuzz/FuzzParse/a878c3134fe0:1 untracked",
      "feed/testdata/rapid/TestStep/TestStep-1.fail:1 untracked",
      "proptest-regressions/lib.txt:1 untracked",
    ]);
  });

  it("reports proptest's case for an integration test, saved beside its source", async () => {
    const files = {
      ...CRATE,
      "tests/api.rs": "// an integration test\n",
      "tests/api.proptest-regressions": "cc 9a1c seed\n",
      "notes/old.proptest-regressions": "kept, tracked\n",
    };
    expect(
      await found(
        repo(files, ["tests/api.proptest-regressions"]),
        "saved-failures",
      ),
    ).toEqual(["tests/api.proptest-regressions:1 untracked"]);
    expect(await found(repo(files), "saved-failures")).toEqual([]);
  });

  it("says so when a .gitignore rule hides the case", async () => {
    const root = repo({ ...CRATE, ".gitignore": "proptest-regressions/\n" }, [
      "proptest-regressions/lib.txt",
    ]);
    expect(await found(root, "saved-failures")).toEqual([
      "proptest-regressions/lib.txt:1 ignored",
    ]);
  });

  it("observe mode: at `severity: info` a new gate reports and blocks nothing", async () => {
    const files = { ...CRATE };
    const left = ["proptest-regressions/lib.txt"];
    const enforced = await runCheck({
      cwd: repo(files, left),
      onlyTools: ["saved-failures"],
    });
    expect(enforced.summary.exitCode).toBe(1);
    const observed = await runCheck({
      cwd: repo(
        {
          ...files,
          "validate.config.json": JSON.stringify({
            tools: { "saved-failures": { severity: "info" } },
          }),
        },
        left,
      ),
      onlyTools: ["saved-failures"],
    });
    expect(observed.summary.exitCode).toBe(0);
    expect(
      observed.summary.findings.map((f) => `${f.ruleId} ${f.severity}`),
    ).toEqual(["untracked info"]);
  });

  it("leaves other files in those folders, and the same folders elsewhere, alone", async () => {
    const root = repo(
      {
        ...CRATE,
        "proptest-regressions/README.md": "notes\n",
        "docs/testdata/fuzz/FuzzX/abc": "not beside a Go test\n",
      },
      ["proptest-regressions/README.md", "docs/testdata/fuzz/FuzzX/abc"],
    );
    expect(await found(root, "saved-failures")).toEqual([]);
  });
});
