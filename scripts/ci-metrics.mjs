#!/usr/bin/env node
// What CI costs and how long a change waits for it, from GitHub's records of
// a repository's last runs. Measure before a change to CI and again after it,
// and read cost and waiting time together (Vincent Koc, "Making OpenClaw CI
// faster and 95% cheaper", 2026-11-17: "measure a baseline", "look at cost
// and waiting time together", "PR creation to merge").
//
//   node scripts/ci-metrics.mjs [--repo <owner/name>] [--runs <n>]
//       default: the repository `gh` finds here, its last 100 runs
//   node scripts/ci-metrics.mjs --self-test
//
//   billed minutes    each job's time rounded up to a minute, as GitHub bills
//                     it, before the multiplier of the runner's system
//   proven before     pushes whose tree a pull request run of the same
//                     workflow had already passed: the same proof, run twice
//   slowest steps     the median time of a step, across its job's runs: what
//                     a change waits for, apart from setup
//   created to merged how long a pull request took, the whole of it
//   over ten minutes  a job whose median is past the ten-minute build (Fowler,
//                     "Continuous Integration"; DORA's capability pages)
//   mainline          each time a workflow's push runs on a branch went red (a
//                     failure, a timeout, a run that did not start), and how
//                     long until its next pass ("fix broken builds immediately")
//   same tree         a workflow that ran one tree more than once and did not
//                     get one result: a flaky test, or a job only one event
//                     runs (the same code with two results is the sign of a
//                     flaky test: Luo et al. 2014; Google Testing Blog 2016)
//   last preflight    the seconds per step that scripts/verify-clean.sh kept
//                     for HEAD on this machine: its preflight, or its done gate
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** Nearest rank: share 0.5 is the median. */
const percentile = (numbers, share) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.ceil(sorted.length * share) - 1];
};
const median = (numbers) => percentile(numbers, 0.5);
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
const billed = (duration) => Math.max(1, Math.ceil(duration / 60));

const TEN_MINUTES = 600;
const tree = (run) => `${run.path} ${run.head_commit?.tree_id}`;
const red = (run) =>
  ["failure", "timed_out", "startup_failure"].includes(run.conclusion);

/** Push runs: the seconds from a workflow's first red run to its next pass. */
function recoveries(pushes) {
  const times = [];
  let stillRed = 0;
  // A branch's red run is answered by a pass on the same branch only.
  for (const runs of Map.groupBy(
    pushes,
    (run) => `${run.path} ${run.head_branch}`,
  ).values()) {
    let since;
    for (const run of runs.toSorted(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    )) {
      if (red(run)) since ??= run.updated_at;
      else if (run.conclusion === "success" && since) {
        times.push(seconds(since, run.updated_at));
        since = undefined;
      }
    }
    if (since) stillRed += 1;
  }
  return { times, stillRed };
}

/**
 * runs: GitHub's workflow runs. jobs: their jobs, each with `run_id`.
 * pulls: closed pull requests.
 */
export function summarize({ runs, jobs, pulls = [] }) {
  const event = new Map(runs.map((run) => [run.id, run.event]));
  const ran = jobs.filter(
    (job) =>
      job.started_at &&
      job.completed_at &&
      job.conclusion !== "skipped" &&
      job.conclusion !== null,
  );
  const minutes = {};
  const byJob = new Map();
  const steps = new Map();
  for (const job of ran) {
    const duration = seconds(job.started_at, job.completed_at);
    const kind = event.get(job.run_id) ?? "other";
    minutes[kind] = (minutes[kind] ?? 0) + billed(duration);
    byJob.set(job.name, [...(byJob.get(job.name) ?? []), duration]);
    for (const step of job.steps ?? []) {
      if (!step.started_at || !step.completed_at) continue;
      const key = `${job.name} / ${step.name}`;
      steps.set(key, [
        ...(steps.get(key) ?? []),
        seconds(step.started_at, step.completed_at),
      ]);
    }
  }
  // A pull request run that passed, by workflow and tree.
  const passed = new Set(
    runs
      .filter((r) => r.event === "pull_request" && r.conclusion === "success")
      .map(tree),
  );
  const pushes = runs.filter((run) => run.event === "push");
  const { times, stillRed } = recoveries(pushes);
  // The results a workflow got on one tree, where it ran the tree twice.
  const repeated = [
    ...Map.groupBy(
      runs.filter((run) => run.conclusion === "success" || red(run)),
      tree,
    ).values(),
  ].filter((group) => group.length > 1);
  const merged = pulls
    .filter((pull) => pull.merged_at)
    .map((pull) => seconds(pull.created_at, pull.merged_at));
  return {
    runs: runs.length,
    events: Object.fromEntries(
      [...new Set(runs.map((run) => run.event))]
        .toSorted()
        .map((name) => [name, runs.filter((r) => r.event === name).length]),
    ),
    minutes,
    pushes: pushes.length,
    provenBefore: pushes.filter((run) => passed.has(tree(run))).length,
    jobs: [...byJob]
      .map(([name, durations]) => ({
        name,
        n: durations.length,
        median: median(durations),
        max: Math.max(...durations),
        billed: durations.reduce((sum, d) => sum + billed(d), 0),
      }))
      .toSorted((a, b) => b.billed - a.billed),
    steps: [...steps]
      .map(([name, durations]) => ({ name, median: median(durations) }))
      .toSorted((a, b) => b.median - a.median)
      .slice(0, 8),
    merged: merged.length,
    mergedMedian: median(merged),
    mergedP90: percentile(merged, 0.9),
    red: times.length + stillRed,
    stillRed,
    recoveryMedian: median(times),
    repeated: repeated.length,
    differed: repeated.filter((group) => new Set(group.map(red)).size > 1)
      .length,
  };
}

/** The slowest steps of a pass record of scripts/verify-clean.sh. */
export function preflightSteps(record) {
  const steps = record
    .split("\n")
    .map((line) => /^(\d+)s (.+)$/.exec(line))
    .filter(Boolean)
    .map(([, time, command]) => ({ seconds: Number(time), command }));
  return {
    steps: steps.length,
    seconds: steps.reduce((sum, step) => sum + step.seconds, 0),
    slowest: steps.toSorted((a, b) => b.seconds - a.seconds).slice(0, 5),
  };
}

const time = (value) =>
  value >= 90 ? `${(value / 60).toFixed(1)}min` : `${Math.round(value)}s`;

export function report(result) {
  const { minutes } = result;
  const total = Object.values(minutes).reduce((sum, value) => sum + value, 0);
  const share = Object.entries(minutes)
    .map(([name, value]) => `${name} ${value}`)
    .join(", ");
  return [
    `runs: ${result.runs} (${Object.entries(result.events)
      .map(([name, n]) => `${n} ${name}`)
      .join(", ")})`,
    `billed minutes: ${total} (${share})`,
    `proven before: ${result.provenBefore} of ${result.pushes} push runs repeat a pull request run that passed the same tree`,
    "jobs, by billed minutes:",
    ...result.jobs.map(
      (job) =>
        `  ${String(job.billed).padStart(4)}  ${job.name}: ${job.n} runs, median ${time(job.median)}, longest ${time(job.max)}`,
    ),
    "slowest steps (median):",
    ...result.steps.map(
      (step) => `  ${time(step.median).padStart(7)}  ${step.name}`,
    ),
    `created to merged: ${result.merged} pull requests, median ${time(result.mergedMedian)}, 90th percentile ${time(result.mergedP90)}`,
    `over ten minutes: ${
      result.jobs
        .filter((job) => job.median > TEN_MINUTES)
        .map((job) => `${job.name} (median ${time(job.median)})`)
        .join(", ") || "no job"
    }`,
    `mainline: a workflow's push runs went red ${result.red} times${result.red > result.stillRed ? `, green again in a median ${time(result.recoveryMedian)}` : ""}${result.stillRed > 0 ? `; ${result.stillRed} still red` : ""}`,
    `same tree, different result: ${result.differed} of ${result.repeated} trees that a workflow ran more than once`,
    "",
  ].join("\n");
}

// The self-test's records: a time, and a run as GitHub lists it.
const instant = (second) =>
  new Date(Date.UTC(2026, 10, 17, 0, 0, second)).toJSON();
const listed = (id, event, tree_id, conclusion = "success") => ({
  id,
  event,
  conclusion,
  path: ".github/workflows/validate.yml",
  head_commit: { tree_id },
  created_at: instant(id * 100),
  updated_at: instant(id * 100 + 30),
});

function selfTest() {
  const job = (run_id, name, length, steps = []) => ({
    run_id,
    name,
    conclusion: "success",
    started_at: instant(0),
    completed_at: instant(length),
    steps,
  });
  const got = summarize({
    runs: [
      listed(1, "pull_request", "tree-a"),
      listed(2, "push", "tree-a"),
      // A pull request run that failed proves nothing.
      listed(3, "pull_request", "tree-b", "failure"),
      listed(4, "push", "tree-b"),
      // The mainline goes red, and is green again 200 seconds later.
      listed(5, "push", "tree-c", "failure"),
      listed(6, "push", "tree-c", "timed_out"),
      listed(7, "push", "tree-d"),
    ],
    jobs: [
      job(1, "validate", 61, [
        { name: "smoke", started_at: instant(0), completed_at: instant(50) },
        { name: "setup", started_at: instant(50), completed_at: instant(61) },
      ]),
      job(2, "validate", 59),
      job(4, "validate", 120),
      job(4, "windows", 1),
      { ...job(4, "skipped", 5), conclusion: "skipped" },
    ],
    pulls: [
      { created_at: instant(0), merged_at: instant(600) },
      { created_at: instant(0), merged_at: instant(1200) },
      { created_at: instant(0), merged_at: null },
    ],
  });
  const record = preflightSteps("3s pnpm install\n150s smoke\n\n7s check\n");
  const want = {
    minutes: JSON.stringify({ pull_request: 2, push: 4 }),
    proven: "1 of 5",
    first: "validate 3 5",
    step: "validate / smoke 50",
    merged: "2 600 1200",
    record: "3 160 smoke",
    // tree-b passed on a push and failed on a pull request; tree-c failed twice.
    mainline: "1 0 200 1 of 3",
    slow: "over ten minutes: no job",
  };
  const have = {
    minutes: JSON.stringify(got.minutes),
    proven: `${got.provenBefore} of ${got.pushes}`,
    first: `${got.jobs[0]?.name} ${got.jobs[0]?.n} ${got.jobs[0]?.billed}`,
    step: `${got.steps[0]?.name} ${got.steps[0]?.median}`,
    merged: `${got.merged} ${got.mergedMedian} ${got.mergedP90}`,
    record: `${record.steps} ${record.seconds} ${record.slowest[0]?.command}`,
    mainline: `${got.red} ${got.stillRed} ${got.recoveryMedian} ${got.differed} of ${got.repeated}`,
    slow: report(got)
      .split("\n")
      .find((line) => line.startsWith("over ten")),
  };
  if (JSON.stringify(have) === JSON.stringify(want)) return 0;
  process.stderr.write(`ci-metrics self-test: ${JSON.stringify(have)}\n`);
  return 1;
}

async function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const gh = promisify(execFile);
  const api = async (path) =>
    JSON.parse((await gh("gh", ["api", path], { maxBuffer: 1 << 28 })).stdout);
  try {
    const repo =
      option("--repo") ??
      (
        await gh("gh", [
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "--jq",
          ".nameWithOwner",
        ])
      ).stdout.trim();
    const count = Math.min(100, Number(option("--runs", "100")) || 100);
    const runs = (
      await api(`repos/${repo}/actions/runs?per_page=${count}`)
    ).workflow_runs.filter((run) => run.status === "completed");
    // One request per run, eight at a time: each group starts when the one
    // before it has answered.
    const groups = Array.from({ length: Math.ceil(runs.length / 8) }, (_, at) =>
      runs.slice(at * 8, at * 8 + 8),
    );
    const jobs = await groups.reduce(
      async (before, group) => [
        ...(await before),
        ...(
          await Promise.all(
            group.map((run) =>
              api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`),
            ),
          )
        ).flatMap((page) => page.jobs),
      ],
      Promise.resolve([]),
    );
    const pulls = await api(`repos/${repo}/pulls?state=closed&per_page=50`);
    process.stdout.write(
      `${repo}\n${report(summarize({ runs, jobs, pulls }))}`,
    );
  } catch (error) {
    process.stderr.write(
      `ci-metrics: gh could not read the runs (${String(error.stderr ?? error.message).trim()})\n`,
    );
    return 2;
  }
  const head = git(["rev-parse", "HEAD"]);
  const common = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const records = common && join(common, "preflight");
  // A preflight's record is `<commit>.<base>`; the done gate's is in gate/.
  const record =
    head &&
    records &&
    existsSync(records) &&
    (readdirSync(records).find((name) => name.startsWith(`${head}.`)) ??
      (existsSync(join(records, "gate", head)) && join("gate", head)));
  if (record) {
    const last = preflightSteps(readFileSync(join(records, record), "utf8"));
    if (last.steps > 0)
      process.stdout.write(
        `last preflight here (${head.slice(0, 7)}): ${time(last.seconds)} in ${last.steps} steps; slowest: ${last.slowest.map((step) => `${time(step.seconds)} ${step.command}`).join("; ")}\n`,
      );
  }
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
// pnpm hands the `--` of `pnpm run ci:metrics -- --repo x` on as a word.
if (asScript)
  process.exitCode = await main(
    process.argv.slice(2).filter((word) => word !== "--"),
  );
