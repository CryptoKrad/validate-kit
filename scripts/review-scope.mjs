#!/usr/bin/env node
// What a review of the current change has to look at: its risk tier, and the
// "Always check" items of REVIEW.md whose paths the change touches. REVIEW.md
// and CODEOWNERS are read from the base commit, never from the change: a
// change must not edit the instructions that judge it (Anthropic, "How the
// Claude Code team thinks about verification", 2026-11-16). Usage:
//   node scripts/review-scope.mjs [--base <ref>] [--json]
//   node scripts/review-scope.mjs --prune      the work tree's REVIEW.md and CODEOWNERS: a
//                                              trigger or an owner pattern that matches no
//                                              tracked file, and an item that names no incident
//                                              behind it; exit 1 when there is one
//   node scripts/review-scope.mjs --self-test
//
// It says why: which changed file made the tier, and which made each item
// fire ("when a check pulls in a reviewer, it should say why", same write-up).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const git = (args) => {
  const run = spawnSync("git", args, { encoding: "utf8" });
  return run.status === 0 ? run.stdout : undefined;
};

/** The items under "## Always check", each with the paths that trigger it. */
export function checklist(review) {
  const section = /^## Always check\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(
    review,
  );
  if (!section) return [];
  return section[1]
    .split(/\n(?=- )/)
    .filter((item) => item.startsWith("- "))
    .map((item) => {
      const text = item
        .slice(2)
        .replace(/\s*\n\s*/g, " ")
        .trim();
      // Triggers lead the item, before its colon: `a/`, `b.ts`: what to check.
      const lead = /^(?:`[^`]+`(?:, | and )?)+(?=: )/.exec(text)?.[0] ?? "";
      const paths = [...lead.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      // The incident or the lesson the item came from.
      const behind = /Behind it: (.+?)\.?$/.exec(text)?.[1];
      return { text, paths, behind };
    });
}

/** A changed file is under a trigger path, or is that file. */
const touches = (file, path) =>
  path.endsWith("/") ? file.startsWith(path) : file === path;

/** CODEOWNERS patterns of the forms this repository uses: `/dir/` and `/file`. */
const patterns = (codeowners) =>
  codeowners
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((pattern) => pattern.startsWith("/"));

/** The owner pattern a file falls under, if one does. */
export function owned(codeowners, file) {
  return patterns(codeowners).find((pattern) =>
    touches(file, pattern.slice(1)),
  );
}

const SHIPS =
  /^(packages\/validate-kit\/(src|rules|presets|bin)\/|scripts\/|apps\/[^/]+\/(src|app|lib|components)\/)/;

/** High: a file its owner always reads. Medium: code that ships or gates. Low: the rest. */
export function tier(files, codeowners) {
  if (files.some((file) => owned(codeowners, file))) return "high";
  return files.some((file) => SHIPS.test(file)) ? "medium" : "low";
}

/** The first few of a list, and how many more there are. */
const few = (list) =>
  list.length > 3
    ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`
    : list.join(", ");

export function scope(files, review, codeowners) {
  const risk = tier(files, codeowners);
  const owners = files
    .filter((file) => owned(codeowners, file))
    .map((file) => `${file} (owner pattern ${owned(codeowners, file)})`);
  const fired = [];
  for (const item of checklist(review)) {
    const by = files.filter((file) =>
      item.paths.some((path) => touches(file, path)),
    );
    if (item.paths.length === 0 || by.length > 0) fired.push({ item, by });
  }
  return {
    risk,
    // Why this tier, in the changed files' own names.
    why:
      risk === "high"
        ? few(owners)
        : risk === "medium"
          ? `${few(files.filter((file) => SHIPS.test(file)))} ship or gate`
          : "no changed file ships, gates or has an owner",
    // The local /code-review level that matches the tier.
    effort: { low: "low", medium: "medium", high: "high" }[risk],
    ownerReads: risk === "high",
    files: files.length,
    check: fired.map(({ item }) => item.text),
    // Per item of `check`: the changed files that made it fire.
    because: fired.map(({ by }) => (by.length > 0 ? few(by) : "every change")),
  };
}

/**
 * What to tidy: a trigger or an owner pattern that matches no tracked file
 * any more, and a checklist item that names no incident behind it. Rules only
 * grow unless they are pruned (same write-up, "Turn misses into rules").
 */
export function prune(tracked, review, codeowners) {
  const live = (path) => tracked.some((file) => touches(file, path));
  const dead = [];
  for (const item of checklist(review)) {
    for (const path of item.paths)
      if (!live(path))
        dead.push(`REVIEW.md: the trigger \`${path}\` matches no file`);
    if (!item.behind)
      dead.push(
        `REVIEW.md: no "Behind it:" on the item "${item.text.slice(0, 60)}..."`,
      );
  }
  for (const pattern of patterns(codeowners))
    if (!live(pattern.slice(1)))
      dead.push(`CODEOWNERS: ${pattern} matches no file`);
  return dead;
}

/** A file's text, or nothing when it is not there. */
const textOf = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// The self-test's `src/` is not a shipping path of this repository: map it under one.
const underScripts = (file) =>
  file.startsWith("src/") ? `scripts/${file}` : file;

function selfTest() {
  const review = `# R\n\n## Always check\n\n- \`src/a/\`: adapters have\n  a twin.\n- \`src/hook.ts\`, \`scripts/stop.mjs\`: three rounds.\n- Any new test has a row in \`docs/ledger.csv\`.\n\n## Risk\n\n- Low: docs.\n`;
  // Pruning: a dead trigger, an item with no incident, a dead owner pattern.
  const tidy = prune(
    ["src/a/x.ts", "docs/ledger.csv"],
    "## Always check\n\n- `src/a/`: twin. Behind it: 1a2b3c4.\n- `src/gone.ts`: old. Behind it: a lesson.\n- `src/a/`: no incident.\n",
    "/src/a/ @o\n/src/gone/ @o\n",
  );
  if (
    tidy.length !== 3 ||
    !tidy[0].includes("`src/gone.ts` matches no file") ||
    !tidy[1].includes('no "Behind it:"') ||
    !tidy[2].includes("/src/gone/ matches no file")
  ) {
    process.stderr.write(
      `review-scope self-test: prune gave ${JSON.stringify(tidy)}\n`,
    );
    return 1;
  }
  const said = scope(["scripts/src/hook.ts"], "", "/scripts/src/hook.ts @o\n");
  if (said.why !== "scripts/src/hook.ts (owner pattern /scripts/src/hook.ts)") {
    process.stderr.write(`review-scope self-test: why gave ${said.why}\n`);
    return 1;
  }
  const owners = "# c\n/.github/ @o\n/src/hook.ts @o\n";
  const cases = [
    [
      ["src/a/x.ts"],
      "medium",
      [
        "`src/a/`: adapters have a twin.",
        "Any new test has a row in `docs/ledger.csv`.",
      ],
    ],
    [
      ["src/hook.ts"],
      "high",
      [
        "`src/hook.ts`, `scripts/stop.mjs`: three rounds.",
        "Any new test has a row in `docs/ledger.csv`.",
      ],
    ],
    [["docs/x.md"], "low", ["Any new test has a row in `docs/ledger.csv`."]],
    [
      [".github/workflows/a.yml", "docs/x.md"],
      "high",
      ["Any new test has a row in `docs/ledger.csv`."],
    ],
  ];
  for (const [files, risk, check] of cases) {
    const got = scope(
      files.map(underScripts),
      review.replaceAll("`src/", "`scripts/src/"),
      owners.replace("/src/", "/scripts/src/"),
    );
    const want = check.map((text) => text.replaceAll("`src/", "`scripts/src/"));
    if (
      got.risk !== risk ||
      JSON.stringify(got.check) !== JSON.stringify(want)
    ) {
      process.stderr.write(
        `review-scope self-test: ${files.join()} gave ${JSON.stringify(got)}\n`,
      );
      return 1;
    }
  }
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  if (argv.includes("--prune")) {
    // From the repository's top, wherever it is run. Nothing to read is not
    // "nothing to prune".
    const top = git(["rev-parse", "--show-toplevel"])?.trim();
    if (!top || !existsSync(join(top, "REVIEW.md"))) {
      process.stderr.write(
        `review-scope: no REVIEW.md ${top ? `at ${top}` : "here: not a git repository"}\n`,
      );
      return 2;
    }
    const review = textOf(join(top, "REVIEW.md"));
    const owners = join(top, ".github/CODEOWNERS");
    const dead = [
      ...(checklist(review).length === 0
        ? ['REVIEW.md: no item under "## Always check"']
        : []),
      ...(existsSync(owners)
        ? []
        : ["CODEOWNERS: no .github/CODEOWNERS, so no change is high risk"]),
      ...prune(
        (git(["-C", top, "ls-files"]) ?? "").split("\n").filter(Boolean),
        review,
        textOf(owners),
      ),
    ];
    for (const line of dead) process.stdout.write(`${line}\n`);
    return dead.length > 0 ? 1 : 0;
  }
  const named = argv.indexOf("--base");
  const asked =
    (named >= 0 ? argv[named + 1] : undefined) ??
    git(["merge-base", "HEAD", "origin/main"])?.trim() ??
    "HEAD~1";
  // A base that is no commit is an error: it must not read as "no instructions".
  const base = git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${asked}^{commit}`,
  ])?.trim();
  if (!base) {
    process.stderr.write(`review-scope: ${asked} is not a commit\n`);
    return 2;
  }
  const show = (path) => git(["show", `${base}:${path}`]);
  const committed = git(["diff", "--name-only", `${base}...HEAD`]) ?? "";
  const uncommitted = (
    git(["status", "--porcelain", "--untracked-files=all"]) ?? ""
  )
    .split("\n")
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? "");
  const files = [...new Set([...committed.split("\n"), ...uncommitted])].filter(
    Boolean,
  );
  const review = show("REVIEW.md");
  const owners = show(".github/CODEOWNERS");
  const result = {
    base,
    ...scope(files, review ?? "", owners ?? ""),
    // A file the base does not have yet cannot have judged anything.
    instructions:
      review === undefined
        ? "none at the base commit"
        : `REVIEW.md at ${base.slice(0, 12)}`,
    owners:
      owners === undefined
        ? "none at the base commit: no change is high risk by its paths"
        : `.github/CODEOWNERS at ${base.slice(0, 12)}`,
  };
  if (argv.includes("--json"))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(
      `risk: ${result.risk}${result.ownerReads ? " (the owner reads this change)" : ""}\n  because: ${result.why}\nreview effort: ${result.effort}\nfiles changed: ${result.files}\ninstructions: ${result.instructions}\nowners: ${result.owners}\nalways check (${result.check.length}):\n${result.check.map((item, index) => `- ${item}\n  because: ${result.because[index]}`).join("\n")}\n`,
    );
  return 0;
}

// Run as a script, not imported. Real paths: a folder with a space in its
// name, or one reached through a link, must not make this print nothing.
let asScript = false;
try {
  asScript =
    realpathSync(process.argv[1] ?? "") ===
    realpathSync(fileURLToPath(import.meta.url));
} catch {
  // Not a file on disk: imported.
}
if (asScript) process.exitCode = main(process.argv.slice(2));
