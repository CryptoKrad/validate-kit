#!/usr/bin/env node
// How the review and the gate are doing, from git alone: the numbers
// Anthropic's "How the Claude Code team thinks about verification"
// (2026-11-16) names for reviewing the reviewers. Usage:
//   node scripts/review-metrics.mjs [<range>]   default: the last 200 commits
//   node scripts/review-metrics.mjs --self-test
//
//   reverted            changes taken back after they landed
//   followed by a fix   changes a later `fix` commit had to touch again
//   stayed clean        the rest, with the median size of each group, so the
//                       clean ones can be compared with the ones of like size
//   stamps              how each commit says it was verified (`Verified:`)
//   sent back           what was refused before it landed: Important findings
//                       in tasks/review-rounds.md, how many a second agent
//                       confirmed or refuted (the refuted share is the
//                       reviewer's noise), the rounds each change took, the
//                       gradings, and the commit gate's log
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (args) => {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  return run.status === 0 ? run.stdout : undefined;
};

const median = (numbers) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
};

const isFix = (commit) => /^fix[(:!]/.test(commit.subject);
/** The middle size, in files, of a group of commits. */
const size = (list) => median(list.map((commit) => commit.files.length));
const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** Commits oldest first: { subject, stamp, files }. */
export function summarize(commits) {
  const reverted = commits.filter((commit) =>
    commit.subject.startsWith('Revert "'),
  );
  // A change is followed by a fix when a later fix commit touches one of its files.
  const changes = commits.filter(
    (commit) => !isFix(commit) && !reverted.includes(commit),
  );
  const refixed = changes.filter((commit) =>
    commits
      .slice(commits.indexOf(commit) + 1)
      .some(
        (later) =>
          isFix(later) &&
          later.files.some((file) => commit.files.includes(file)),
      ),
  );
  const clean = changes.filter((commit) => !refixed.includes(commit));
  const stamps = new Map();
  for (const commit of commits) {
    const stamp = commit.stamp || "no trailer";
    stamps.set(stamp, (stamps.get(stamp) ?? 0) + 1);
  }
  return {
    commits: commits.length,
    reverted: reverted.length,
    refixed: refixed.length,
    refixedSize: size(refixed),
    clean: clean.length,
    cleanSize: size(clean),
    stamps: [...stamps].toSorted((a, b) => b[1] - a[1]),
  };
}

/**
 * What the review record holds: the Important findings, how many a second
 * agent confirmed or refuted (the refuted share is the reviewer's noise), and
 * the rounds each change took. A findings table has its tag in the first
 * column or, when the rows are numbered, in the second.
 */
export function reviewRecord(text) {
  const record = { important: 0, confirmed: 0, refuted: 0, rounds: [] };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) record.rounds.push(0);
    else if (line.startsWith("### Round") && record.rounds.length > 0)
      record.rounds[record.rounds.length - 1]++;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const tag = /^\d+$/.test(cells[1]) ? 2 : 1;
    if (cells[tag] !== "Important") continue;
    record.important++;
    const verdict = cells
      .slice(tag + 1)
      .find((cell) => /^[A-Z]{5,}\b/.test(cell));
    if (verdict?.startsWith("CONFIRMED")) record.confirmed++;
    else if (verdict?.startsWith("REFUTED")) record.refuted++;
  }
  record.rounds = record.rounds.filter((rounds) => rounds > 0);
  return record;
}

function read(range) {
  const out = git([
    "log",
    "--reverse",
    "--name-only",
    "--format=%x01%s%x00%(trailers:key=Verified,valueonly,separator=%x2C )%x00",
    ...range,
  ]);
  if (out === undefined) return undefined;
  return out
    .split("\x01")
    .filter(Boolean)
    .map((entry) => {
      const [subject, stamp, files] = entry.split("\x00");
      return {
        subject,
        stamp: stamp.trim(),
        files: files.split("\n").filter(Boolean),
      };
    });
}

function selfTest() {
  const got = summarize([
    { subject: "feat: a", stamp: "none", files: ["a.ts", "b.ts"] },
    { subject: "feat: c", stamp: "verify", files: ["c.ts"] },
    {
      subject: "fix(a): the bug in a",
      stamp: "review, verify",
      files: ["a.ts"],
    },
    { subject: 'Revert "feat: c"', stamp: "", files: ["c.ts"] },
    { subject: "docs: d", stamp: "verify", files: ["d.md"] },
  ]);
  const want = {
    commits: 5,
    reverted: 1,
    refixed: 1,
    refixedSize: 2,
    clean: 2,
    cleanSize: 1,
    stamps: [
      ["verify", 2],
      ["none", 1],
      ["review, verify", 1],
      ["no trailer", 1],
    ],
  };
  const record = reviewRecord(
    [
      "## One change",
      "### Round 1",
      "| #   | Tag       | Where  | Finding | Verdict   | Fix |",
      "| 1   | Important | `a.ts` | a       | CONFIRMED | b   |",
      "| 2   | Nit       | `a.ts` | c       |           | d   |",
      "### Round 2",
      "| Tag       | Finding | Verifier                | What was done |",
      "| Important | e       | REFUTED: it cannot occur | nothing       |",
      "| Important | f       | CONFIRMED, both cases    | g             |",
      "## Notes, with no round",
      "| Candidate | Evidence |",
      "## Another change",
      "### Round 1",
      "| Tag | Finding |",
      "| Nit | h       |",
    ].join("\n"),
  );
  const wantRecord = { important: 3, confirmed: 2, refuted: 1, rounds: [2, 1] };
  if (
    JSON.stringify(got) === JSON.stringify(want) &&
    JSON.stringify(record) === JSON.stringify(wantRecord)
  )
    return 0;
  process.stderr.write(
    `review-metrics self-test: ${JSON.stringify(got)} ${JSON.stringify(record)}\n`,
  );
  return 1;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const commits = read(argv.length > 0 ? argv : ["-200"]);
  if (commits === undefined) {
    process.stderr.write(`review-metrics: git cannot read ${argv.join(" ")}\n`);
    return 2;
  }
  const result = summarize(commits);
  const rounds = existsSync("tasks/review-rounds.md")
    ? readFileSync("tasks/review-rounds.md", "utf8")
    : "";
  const record = reviewRecord(rounds);
  const common = git(["rev-parse", "--git-common-dir"])?.trim();
  const log =
    common && join(resolve(common), "validate-kit", "commit-gate.log");
  const gate = log && existsSync(log) ? readFileSync(log, "utf8") : "";
  process.stdout.write(
    [
      `commits: ${result.commits}`,
      `reverted: ${result.reverted}`,
      `followed by a fix: ${result.refixed} (median ${result.refixedSize} files)`,
      `stayed clean: ${result.clean} (median ${result.cleanSize} files)`,
      `stamps: ${result.stamps.map(([stamp, n]) => `${n} ${stamp}`).join("; ")}`,
      `sent back before landing: ${record.important} Important findings (a second agent confirmed ${record.confirmed} and refuted ${record.refuted}) in ${record.rounds.reduce((all, n) => all + n, 0)} review rounds over ${record.rounds.length} changes (median ${median(record.rounds)} rounds, most ${Math.max(0, ...record.rounds)}); ${count(rounds, /`needs revision/g)} gradings; ${count(gate, /would block/g)} commits the gate would have blocked`,
      "",
    ].join("\n"),
  );
  return 0;
}

// Run as a script, not imported. Real paths, as in review-scope.mjs.
let asScript = false;
try {
  asScript =
    realpathSync(process.argv[1] ?? "") ===
    realpathSync(fileURLToPath(import.meta.url));
} catch {
  // Not a file on disk: imported.
}
// pnpm hands the `--` of `pnpm run review:metrics -- -50` on as a word, and
// git would read the range after it as a path: no commits, and no error.
if (asScript)
  process.exitCode = main(
    process.argv.slice(2).filter((word) => word !== "--"),
  );
