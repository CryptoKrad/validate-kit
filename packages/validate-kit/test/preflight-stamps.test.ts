import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import "./isolated-git.js";

const script = join(import.meta.dirname, "../../../scripts/verify-clean.sh");
// The script in an environment that holds only what the test gives it.
const start = (env: Record<string, string>, ...args: string[]) =>
  spawnSync("/bin/sh", [script, ...args], {
    cwd: join(import.meta.dirname, "../../.."),
    encoding: "utf8",
    env,
    timeout: 20_000,
  });

/** A program that exits 0, or does what `body` says. */
const stub = (path: string, body = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
};
const testLines = (count: number) => "expect(1).toBe(1);\n".repeat(count);
/** A new repository on `main`: its folder, git in it, and a commit of files. */
const repository = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=e@x.invalid", "-c", "user.name=e", ...args],
      { cwd: root, encoding: "utf8" },
    ).trim();
  const commit = (files: Record<string, string>, subject: string) => {
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(root, name), text);
    git("add", ".");
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return { root, git, commit };
};
const recorded = (...allowances: object[]) => JSON.stringify({ allowances });
// What ./isolated-git.js set, for a child that is given its own environment.
const gitAlone = {
  GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"] ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
};

describe("verify-clean.sh --stamps: how each commit was verified", () => {
  // The preflight is a POSIX shell script; Windows runs it in CI's own job.
  it.runIf(process.platform !== "win32")(
    "lists preflight, gate and none, and exits 1 while a commit has no stamp",
    () => {
      const root = mkdtempSync(join(tmpdir(), "vk-stamps-"));
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.email=e@x.invalid", "-c", "user.name=e", ...args],
          { cwd: root, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      const commits = ["one", "two", "three"].map((name) => {
        writeFileSync(join(root, "file"), name);
        git("add", "file");
        // The first carries the session's stamp, as the commit gate writes it.
        git(
          "commit",
          "-q",
          "-m",
          name,
          ...(name === "one" ? ["--trailer", "Verified: verify"] : []),
        );
        return git("rev-parse", "HEAD");
      });
      const records = join(root, ".git", "preflight");
      mkdirSync(join(records, "gate"), { recursive: true });
      writeFileSync(join(records, `${commits[0]}.none`), "");
      writeFileSync(join(records, "gate", commits[1] ?? ""), "");
      const stamps = (range: string) => {
        const run = spawnSync("sh", [script, "--stamps", range], {
          cwd: root,
          encoding: "utf8",
        });
        return {
          status: run.status,
          lines: run.stdout
            .trim()
            .split("\n")
            .map((line) => line.split(/\s+/).slice(1).join(" ")),
        };
      };
      expect(stamps("HEAD")).toEqual({
        status: 1,
        lines: ["none - three", "gate - two", "preflight verify one"],
      });
      expect(stamps("HEAD~1")).toEqual({
        status: 0,
        lines: ["gate - two", "preflight verify one"],
      });
      expect(stamps("no-such-ref").status).toBe(2);
    },
  );

  // A tool the smoke requires is reported before anything is built, with the
  // line that installs it. PATH holds git alone and HOME is empty, so every
  // required tool is missing on any machine and the preflight cannot go on.
  it.runIf(process.platform !== "win32")(
    "the preflight names each missing required tool at its start, with its install line",
    () => {
      const bin = mkdtempSync(join(tmpdir(), "vk-preflight-bin-"));
      const home = mkdtempSync(join(tmpdir(), "vk-preflight-home-"));
      const git = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();
      writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${git}" "$@"\n`, {
        mode: 0o755,
      });
      const run = start({ PATH: bin, HOME: home }, "--ci");
      expect(run.status, run.stderr).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("preflight cannot start");
      for (const line of ["tlc: ", "lean: brew install elan-init", "java: "])
        expect(run.stderr).toContain(line);
      // The smoke installs its own pinned Quint (scripts/native-quint.mjs): a
      // check for one on PATH would stop a preflight the smoke passes.
      expect(run.stderr).not.toContain("quint");
      // The done gate's clean run has the same smoke, and says its own name.
      const gate = start({ PATH: bin, HOME: home });
      expect(gate.status, gate.stderr).toBe(2);
      expect(gate.stderr).toContain("verify-clean cannot start");
      // A launcher in ~/.local/bin is found: CI puts TLC there, and the
      // script adds the folder to its PATH. The other two stay missing.
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "tlc"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      const found = start({ PATH: bin, HOME: home }, "--ci");
      expect(found.status, found.stderr).toBe(2);
      expect(found.stderr).not.toContain("tlc: ");
      expect(found.stderr).toContain("lean: ");
      // No HOME at all is no folder to add, not an unbound variable.
      const homeless = start({ PATH: bin }, "--ci");
      expect(homeless.status, homeless.stderr).toBe(2);
      expect(homeless.stderr).toContain("preflight cannot start");
    },
  );

  // The whole preflight on a repository of stand-ins: every program a step
  // starts is a script that exits 0, and `date` counts seven seconds a call,
  // so the pass is quick and the record it leaves can be read.
  it.runIf(process.platform !== "win32")(
    "a pass keeps the seconds of each step in its record",
    () => {
      const { root, git } = repository("vk-preflight-pass-");
      const bin = mkdtempSync(join(tmpdir(), "vk-preflight-stubs-"));
      stub(
        join(bin, "date"),
        'n=$(($(cat "$0.n" 2>/dev/null || echo 0) + 7))\necho "$n" | tee "$0.n"\n',
      );
      for (const name of ["pnpm", "node", "semgrep", "tlc", "lean", "java"])
        stub(join(bin, name));
      for (const name of ["tsup", "ast-grep", "vitest"])
        stub(join(root, "packages/validate-kit/node_modules/.bin", name));
      git("add", "-f", ".");
      git("commit", "-q", "-m", "stand-ins");
      const head = git("rev-parse", "HEAD");
      const run = spawnSync("/bin/sh", [script, "--ci"], {
        cwd: root,
        encoding: "utf8",
        // No docker here, so that job is left to CI on every machine.
        env: { ...gitAlone, PATH: `${bin}:/usr/bin:/bin`, HOME: root },
        timeout: 60_000,
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const steps = Number(/: (\d+) steps, /.exec(run.stdout)?.[1]);
      expect(run.stdout).toMatch(/^preflight PASS on [0-9a-f]{12}: \d+ steps/);
      const record = readFileSync(
        join(root, ".git", "preflight", `${head}.none`),
        "utf8",
      );
      const lines = record.trimEnd().split("\n");
      expect(lines).toHaveLength(steps);
      expect(lines[0]).toBe("7s pnpm install --frozen-lockfile");
      for (const line of lines) expect(line).toMatch(/^7s \S/);
    },
  );
});

// This repository's review workflow (scripts/): the commit gate's own smoke,
// the review scope's self-test, and the reviewer's eval set against git.
describe("the review workflow's scripts", () => {
  const scripts = join(import.meta.dirname, "../../../scripts");
  const run = (name: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(scripts, name), ...args], {
      encoding: "utf8",
    });

  it.runIf(process.platform !== "win32")(
    "the commit gate records, stamps and gates as its smoke says",
    () => {
      const smoke = run("smoke-commit-gate.mjs");
      expect(smoke.stdout).not.toMatch(/^FAIL/m);
      expect(smoke.status).toBe(0);
    },
  );

  it("the review scope reads triggers and tiers as its self-test says", () => {
    const selfTest = run("review-scope.mjs", "--self-test");
    expect(selfTest.stderr).toBe("");
    expect(selfTest.status).toBe(0);
  });

  // Two review rounds each found text that is not a command read as one
  // (quoted text, then a quote inside a here-document within "$( )"): the
  // class is held here, on generated text.
  it("the commit gate never reads a message or a body as a command", async () => {
    const gate = (await import(
      pathToFileURL(join(scripts, "commit-gate.mjs")).href
    )) as { commits: (command: string, start: string) => { at: number }[] };
    const found = (command: string) => gate.commits(command, "/");
    // Lines a commit message or a pull request body may hold.
    const text = fc
      .array(
        fc.oneof(
          fc.string(),
          fc.constantFrom(
            "git commit -m x",
            "git commit --dry-run",
            "cd /tmp",
            'the 5" screen',
            "it's",
            "$(git commit)",
            ") && git commit",
            "`git commit`",
            "<<EOF",
            "# git commit",
            "$((1<<2",
          ),
        ),
      )
      .map((lines) =>
        lines.filter((line) => line.replace(/^\t+/, "") !== "EOF").join("\n"),
      );
    fc.assert(
      fc.property(text, (body) => {
        const here = `<<'EOF'\n${body}\nEOF`;
        expect(found(`cat > notes ${here}`)).toEqual([]);
        expect(found(`gh pr create --body "$(cat ${here}\n)"`)).toEqual([]);
        expect(found(`git commit -F - ${here}`)).toEqual([
          { at: 10, dir: "/" },
        ]);
        expect(found(`git commit -m "$(cat ${here}\n)"`)).toEqual([
          { at: 10, dir: "/" },
        ]);
        expect(found(`echo '${body.replaceAll("'", "")}'`)).toEqual([]);
      }),
    );
  });

  // The eval and REVIEW.md are this repository's own; its public copy ships
  // without them, and without the exporter that writes it. The guard is the
  // exporter, never the file a test reads: here, a missing input must fail.
  const top = join(scripts, "..");
  const publishes = existsSync(join(scripts, "export-public/export.mjs"));
  const evalResults = join(top, "docs/evals/review/results-2026-11-16.json");

  it.runIf(publishes)(
    "every case and control of the reviewer's eval resolves in git",
    () => {
      // With the `--` pnpm passes on from `pnpm run review:eval -- --list`.
      const list = run("review-eval.mjs", "--", "--list");
      expect(list.stdout).not.toMatch(/^BAD/m);
      expect(list.status).toBe(0);
    },
  );

  // "Rescore the reviewer whenever its prompts, tools or model change."
  it.runIf(publishes)(
    "the eval's list fails when the reviewer's instructions are newer than its score",
    () => {
      const { root, commit } = repository("vk-eval-score-");
      const copy = join(root, "scripts/review-eval.mjs");
      for (const folder of ["scripts", ".claude/agents", "docs/evals/review"])
        mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(copy, readFileSync(join(scripts, "review-eval.mjs")));
      const list = () =>
        spawnSync(process.execPath, [copy, "--list"], {
          cwd: root,
          encoding: "utf8",
        });
      const cases = '{ "cases": [], "controls": [] }\n';
      commit(
        {
          "REVIEW.md": "Rules.\n",
          ".claude/agents/reviewer.md": "Review.\n",
          "docs/evals/review/cases.json": cases,
          "docs/evals/review/results-2026-01-01.json": "{}\n",
        },
        "the reviewer, scored",
      );
      expect(list().stdout).toMatch(/^ok {3}score: results-2026-01-01\.json/m);
      expect(list().status).toBe(0);
      // An edit in the work tree, then the same edit committed.
      writeFileSync(join(root, ".claude/agents/reviewer.md"), "Review more.\n");
      expect(list().stdout).toMatch(
        /^STALE score: \.claude\/agents\/reviewer\.md changed after results-2026-01-01\.json/m,
      );
      commit({ "REVIEW.md": "More rules.\n" }, "the reviewer, changed");
      expect(list().stdout).toMatch(
        /^STALE score: \.claude\/agents\/reviewer\.md, REVIEW\.md changed/m,
      );
      expect(list().status).toBe(1);
      // A new results file, before its commit and after it.
      writeFileSync(
        join(root, "docs/evals/review/results-2026-01-02.json"),
        "{}\n",
      );
      expect(list().status).toBe(0);
      commit({ "notes.md": "scored again\n" }, "the new score");
      expect(list().stdout).toMatch(/^ok {3}score: results-2026-01-02\.json/m);
    },
  );

  it.runIf(publishes)(
    "the eval's score reports recall in three stages and what is detectable",
    () => {
      const score = run("review-eval.mjs", "--score", evalResults);
      expect(score.status).toBe(0);
      expect(score.stdout).toMatch(
        /tune: 4 known bugs, 6 runs[\s\S]*raw findings: the bug is described in 4 of 6 runs[\s\S]*after verification: 2 of 2[\s\S]*shown as Important: 3 of 6[\s\S]*detectable \(two finders or more\): 2 of 4; not: error-prone-build-never-starts, go-root-of-another-go[\s\S]*with a candidate rule in the brief: found in 2 of 4 runs/,
      );
    },
  );

  it.runIf(publishes)(
    "no review trigger or owner pattern is dead, and every item names its incident",
    () => {
      // From a subfolder: the files are found from the repository's top.
      const prune = spawnSync(
        process.execPath,
        [join(scripts, "review-scope.mjs"), "--prune"],
        { cwd: scripts, encoding: "utf8" },
      );
      expect(prune.stdout).toBe("");
      expect(prune.status).toBe(0);
    },
  );

  it("pruning and scoring say what they could not read, and do not pass", () => {
    const empty = mkdtempSync(join(tmpdir(), "validate-kit-review-"));
    spawnSync("git", ["init", "-q"], { cwd: empty });
    const prune = spawnSync(
      process.execPath,
      [join(scripts, "review-scope.mjs"), "--prune"],
      { cwd: empty, encoding: "utf8" },
    );
    expect(prune.stderr).toContain("no REVIEW.md");
    expect(prune.status).toBe(2);
    // A REVIEW.md with no checklist, and no owners file: two lines, not a pass.
    writeFileSync(join(empty, "REVIEW.md"), "# Review\n");
    const bare = spawnSync(
      process.execPath,
      [join(scripts, "review-scope.mjs"), "--prune"],
      { cwd: empty, encoding: "utf8" },
    );
    expect(bare.stdout).toContain('no item under "## Always check"');
    expect(bare.stdout).toContain("no .github/CODEOWNERS");
    expect(bare.status).toBe(1);
    if (!publishes) return;
    // A results file from before the runs were kept: one answer per case.
    const old = join(empty, "old.json");
    writeFileSync(
      old,
      JSON.stringify({ "oxlint-unreadable-file": { found: true } }),
    );
    const score = run("review-eval.mjs", "--score", old);
    expect(score.stderr).toContain('no "runs" list for oxlint-unreadable-file');
    expect(score.status).toBe(2);
    // One finder of two is a find, and is not yet a bug the reviewer can be counted on to find.
    const once = join(empty, "once.json");
    writeFileSync(
      once,
      JSON.stringify({
        "oxlint-unreadable-file": { runs: [{ found: true }, { found: false }] },
      }),
    );
    expect(run("review-eval.mjs", "--score", once).stdout).toContain(
      "detectable (two finders or more): 0 of 1; not: oxlint-unreadable-file",
    );
  });

  it("the review metrics count reverts, fix follow-ups, clean changes and stamps", () => {
    const selfTest = run("review-metrics.mjs", "--self-test");
    expect(selfTest.stderr).toBe("");
    expect(selfTest.status).toBe(0);
    // The range after pnpm's `--` is a range, not a path.
    expect(run("review-metrics.mjs", "--", "-1").stdout).toMatch(
      /^commits: 1$/m,
    );
  });

  it("the smoke's timing report adds the seconds per program and lists the slowest commands", async () => {
    const { timed, timingReport } = (await import(
      pathToFileURL(join(scripts, "smoke-timings.mjs")).href
    )) as {
      timed: <T>(
        spawn: (command: string, args: string[]) => T,
      ) => (command: string, args: string[]) => T;
      timingReport: (entries?: [number, string, string[]][]) => string;
    };
    // A timed launcher answers as the launcher does, and a launcher that
    // throws is counted too.
    expect(timed(() => "out")("pnpm", ["pack"])).toBe("out");
    expect(() =>
      timed(() => {
        throw new Error("no such program");
      })("git", ["status"]),
    ).toThrow("no such program");
    expect(timingReport()).toMatch(
      /^smoke timings: 2 commands, .*\n.*(pnpm|git) x1\n.*(pnpm|git) x1\nslowest:/,
    );
    // The kit's CLI is one program, whichever node starts it.
    expect(
      timingReport([
        [1500, "/usr/bin/node", ["/x/dist/cli.js", "--only", "oxlint"]],
        [250, "pnpm", ["pack"]],
        [90_000, "node", ["/y/cli.js", "check", "--json"]],
      ]).split("\n"),
    ).toEqual([
      "smoke timings: 3 commands, 91.8s in them",
      "  91.5s  validate-kit x2",
      "   0.3s  pnpm x1",
      "slowest:",
      "  90.0s  validate-kit check --json",
      "   1.5s  validate-kit --only oxlint",
      "   0.3s  pnpm pack",
    ]);
  });

  it("the CI metrics count billed minutes, repeated proof and waiting time", () => {
    const selfTest = run("ci-metrics.mjs", "--self-test");
    expect(selfTest.stderr).toBe("");
    expect(selfTest.status).toBe(0);
  });

  // The pre-push mode of the preflight judges every commit of the push, and
  // not its tip alone, before it starts the preflight.
  it.runIf(publishes && process.platform !== "win32")(
    "a push with a commit over the test-line budget is refused before the preflight starts",
    () => {
      const { root, commit } = repository("vk-budget-push-");
      const base = commit({ "a.ts": "export {};\n" }, "source");
      const over = commit({ "a.test.ts": testLines(401) }, "over the limit");
      const tip = commit({ "notes.md": "a note\n" }, "a note on top");
      mkdirSync(join(root, "scripts"));
      writeFileSync(
        join(root, "scripts/test-budget.mjs"),
        readFileSync(join(scripts, "test-budget.mjs")),
      );
      const pushed = (from: string) =>
        spawnSync("/bin/sh", [script, "--pushed"], {
          cwd: root,
          encoding: "utf8",
          input: `refs/heads/main ${tip} refs/heads/main ${from}\n`,
          env: {
            ...gitAlone,
            PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`,
            HOME: root,
          },
        });
      const push = pushed(base);
      expect(push.status).toBe(1);
      expect(push.stderr).toContain(
        `commit ${over.slice(0, 12)} adds 401 net lines`,
      );
      expect(push.stdout + push.stderr).not.toContain("preflight");
      // The same push from the commit over the limit holds one commit of
      // notes: the budget passes, and the preflight starts.
      expect(pushed(over).stderr).toContain("preflight");
    },
  );

  // The limit on test-code growth, on a real repository: what is staged, each
  // commit by itself, a merge, a push of several commits, and the record.
  it.runIf(publishes)(
    "a commit over the test-line budget is refused until it records why",
    () => {
      const selfTest = run("test-budget.mjs", "--self-test");
      expect(selfTest.stderr).toBe("");
      expect(selfTest.status).toBe(0);
      const { root, git, commit } = repository("vk-test-budget-");
      const budget = (args: string[] = [], cwd = root, env = process.env) =>
        spawnSync(
          process.execPath,
          [join(scripts, "test-budget.mjs"), ...args],
          { cwd, encoding: "utf8", env },
        );
      // Before the first commit, and for it, the change is compared with
      // nothing; source is not counted.
      writeFileSync(join(root, "a.ts"), testLines(900));
      git("add", ".");
      expect(budget(["--staged"]).status).toBe(0);
      commit({}, "source");
      expect(budget().status).toBe(0);

      writeFileSync(join(root, "a.test.ts"), testLines(401));
      git("add", ".");
      const refused = budget(["--staged"]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("adds 401 net lines to test files");
      expect(refused.stderr).toContain("+401 a.test.ts");
      expect(refused.stderr).toContain('{ "lines": 1, "why": ');
      const allowance = { lines: 1, why: "a.ts had no test" };
      writeFileSync(join(root, "test-budget.json"), recorded(allowance));
      git("add", ".");
      expect(budget(["--staged"]).status).toBe(0);
      const reasoned = commit({}, "tests, with the reason");
      expect(budget().status).toBe(0);

      // The entry is still in the file: it was for that commit, not this one.
      writeFileSync(join(root, "b.spec.ts"), testLines(401));
      git("add", ".");
      expect(budget(["--staged"]).stderr).toContain("the limit is 400.");
      // A line taken out of another test pays for the one line over.
      commit({ "a.test.ts": testLines(400) }, "more tests, one line out");
      expect(budget().status).toBe(0);

      // A commit over the limit that no hook judged, under a commit of notes:
      // the tip passes, and the range of the push names the commit.
      const over = commit({ "c.test.ts": testLines(401) }, "over the limit");
      const tip = commit({ "notes.md": "a note\n" }, "a note on top");
      expect(budget().status).toBe(0);
      const named = `commit ${over.slice(0, 12)} adds 401 net lines`;
      expect(budget([reasoned, tip]).stderr).toContain(named);
      expect(budget([over, tip]).status).toBe(0);
      expect(budget([over]).status).toBe(1);
      // A runner's event file names the same range.
      const event = join(
        mkdtempSync(join(tmpdir(), "vk-event-")),
        "event.json",
      );
      writeFileSync(event, JSON.stringify({ before: reasoned, after: tip }));
      const onRunner = budget([], root, {
        ...process.env,
        GITHUB_EVENT_PATH: event,
      });
      expect(onRunner.status).toBe(1);
      expect(onRunner.stderr).toContain(named);

      // A merge is judged by what it changed itself. The commit it brings,
      // 600 lines with its own allowance, was judged where it was made: the
      // merge has neither those lines nor that allowance for the 401 it adds.
      git("checkout", "-q", "-b", "side", reasoned);
      const sides = recorded(allowance, { lines: 200, why: "side's reason" });
      commit(
        { "d.test.ts": testLines(600), "test-budget.json": sides },
        "side, with its reason",
      );
      expect(budget().status).toBe(0);
      git("checkout", "-q", "main");
      // While the merge is being concluded, its lines are staged: not judged.
      git("merge", "-q", "--no-ff", "--no-commit", "side");
      expect(budget(["--staged"]).status).toBe(0);
      commit({ "e.test.ts": testLines(401) }, "merge side, and more tests");
      const merged = budget();
      expect(merged.status).toBe(1);
      expect(merged.stderr).toContain("adds 401 net lines to test files");
      expect(merged.stderr).toContain("the limit is 400.");
      // git has no such diff for a merge of more than two parents, and prints
      // no lines for it: it is judged against its first parent.
      writeFileSync(join(root, "f.test.ts"), testLines(401));
      git("add", ".");
      const parents = ["-p", "HEAD", "-p", "side", "-p", reasoned];
      const many = git("commit-tree", git("write-tree"), "-m", "x", ...parents);
      expect(budget([many]).stderr).toContain("adds 401 net lines");

      // A clone without history cannot be judged, and says so.
      const shallow = mkdtempSync(join(tmpdir(), "vk-shallow-"));
      execFileSync("git", [
        "clone",
        "-q",
        "--depth",
        "1",
        `file://${root}`,
        shallow,
      ]);
      const cut = budget([], shallow);
      expect(cut.status).toBe(2);
      expect(cut.stderr).toContain("not a full clone");
      expect(budget(["no-such-ref"]).status).toBe(2);
    },
  );
});
