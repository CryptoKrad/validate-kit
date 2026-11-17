import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
