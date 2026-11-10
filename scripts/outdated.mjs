#!/usr/bin/env node
// Is every version this repository pins the newest release?
//
// Reads the pins CI installs (.github/workflows, the baseline script), the
// packages pnpm installs and the Homebrew formulas in the Brewfile, asks each
// one's own registry for its newest stable release, and prints what is
// behind, with the projects beside this repository whose kit is not the
// committed one (scripts/consumer-upgrade.mjs --status). Nothing is printed
// when nothing is: it is run by a hook.
//
//   node scripts/outdated.mjs            what is behind; exit 1 when anything is
//   node scripts/outdated.mjs --all      also what is held, too new, or not compared
//   node scripts/outdated.mjs --apply    move every pin that is behind, in every file that names it
//   node scripts/outdated.mjs --machine  `brew upgrade` the Brewfile's formulas that are behind (old versions
//                                        stay on disk), and write the new versions into library/README.md
//   node scripts/outdated.mjs --daily    for the SessionStart hook: prints what the last look found, at once;
//                                        looks again in the background when that is a day old
//   node scripts/outdated.mjs --self-test
//
// Not behind: a pre-release, a release younger than a day (pnpm's
// minimumReleaseAge here), and the pins HOLDS names with the reason.
// After --apply: `pnpm install`, then the done gate, since a tool's new
// version can change the output the kit parses.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60_000;
const AGENT = "validate-kit-outdated";
// What the last look found: empty when nothing was behind.
const FOUND = join(repoRoot, "node_modules", ".cache", "outdated.txt");
// Where a pin is written, besides the workflows: the guards that expect it.
const APPLY_SKIP =
  /^(docs\/(research|evidence)\/|tasks\/learning\.md$|pnpm-lock\.yaml$)/;

// Pins that stay behind on purpose. Delete a line when its reason is gone.
const HOLDS = {
  "npm:@types/node":
    "follows the Node 22 floor the kit supports, not the newest Node",
  "npm:npm":
    "release.yml only, which runs on a version tag: move it at a release, where the publish proves it",
  "npm:lefthook":
    "pnpm refuses 2.2.2 as a trust downgrade: earlier releases had a trusted publisher, this one none",
};

// Pins that follow one major line: the newest release of that line is what
// they are compared with.
const WITHIN = {
  "npm:pnpm": [
    "10",
    "a package-manager major changes the lockfile and the settings the cooldown check reads: a migration of its own",
  ],
};

/** `v2.15.0` or `1.51.1` as numbers, for an order. */
function key(version) {
  return (version.match(/\d+/g) ?? []).map(Number);
}

/** Is release `a` older than release `b`? */
export function older(a, b) {
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

function stable(version) {
  return !/(alpha|beta|rc|snapshot|preview|nightly|dev|canary|next|\d[ab]\d+$)/i.test(
    version,
  );
}

/**
 * The pins in a workflow or script: what installs them says where to ask.
 * `token` is the pin as written, the text --apply replaces everywhere.
 */
export function pinsIn(text) {
  const pins = [];
  const add = (source, name, version, token) =>
    pins.push({ source, name, version, token });
  for (const m of text.matchAll(/go install (\S+?)@(v[\w.-]+)/g))
    add("go", m[1], m[2], `${m[1]}@${m[2]}`);
  for (const line of text.matchAll(/(?:pip install|uv tool install)[^\n]*/g))
    for (const m of line[0].matchAll(/([A-Za-z0-9_.-]+)==([\w.]+)/g))
      add("pypi", m[1], m[2], `${m[1]}==${m[2]}`);
  for (const m of text.matchAll(
    /npm install (?:-g|--global) (@?[\w./-]+)@(\d[\w.]*)/g,
  ))
    add("npm", m[1], m[2], `${m[1]}@${m[2]}`);
  // The version a setup action is told to install: pnpm, uv.
  for (const m of text.matchAll(
    /pnpm\/action-setup@[^\n]*\n\s*with:\n\s*(version: ([\d.]+))/g,
  ))
    add("npm", "pnpm", m[2], m[1]);
  for (const m of text.matchAll(
    /astral-sh\/setup-uv@[^\n]*\n\s*with:\n\s*(version: "([\d.]+)")/g,
  ))
    add("pypi", "uv", m[2], m[1]);
  for (const m of text.matchAll(/SEMGREP_VERSION: "([\d.]+)"/g))
    add("pypi", "semgrep", m[1], m[0]);
  for (const m of text.matchAll(/k6-version: ([\d.]+)/g))
    add("github", "grafana/k6", m[1], m[0]);
  for (const m of text.matchAll(
    /github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/(v[\w.]+)\//g,
  ))
    add("github", m[1], m[2], m[0]);
  for (const m of text.matchAll(
    /uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v[\d.]+)/g,
  ))
    add("action", m[1], m[3], `${m[1]}@${m[2]} # ${m[3]}`);
  return pins;
}

function get(url) {
  const done = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "20", "-A", AGENT, url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (done.status !== 0) throw new Error(`no answer from ${url}`);
  return done.stdout;
}

/** The GitHub API through `gh` when it is here: signed in, so not limited to 60 requests an hour. */
function github(path) {
  const gh = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (gh.status === 0) return JSON.parse(gh.stdout);
  return JSON.parse(get(`https://api.github.com/${path}`));
}

/** The module a Go package path belongs to: the longest prefix the proxy knows. */
function goLatest(path) {
  const parts = path.split("/");
  for (let n = parts.length; n >= 2; n--) {
    const module = parts
      .slice(0, n)
      .join("/")
      .replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
    try {
      return JSON.parse(get(`https://proxy.golang.org/${module}/@latest`));
    } catch {
      // not a module: one path element shorter
    }
  }
  throw new Error(`no Go module for ${path}`);
}

/** { version, released, sha } of the newest stable release, as the pin's own registry says. */
function newest(pin) {
  if (pin.source === "npm") {
    const doc = JSON.parse(
      get(`https://registry.npmjs.org/${pin.name.replace("/", "%2f")}`),
    );
    const line = WITHIN[`npm:${pin.name}`]?.[0];
    const version = line
      ? Object.keys(doc.versions)
          .filter((v) => v.startsWith(`${line}.`) && stable(v))
          .toSorted((a, b) => (older(a, b) ? -1 : 1))
          .at(-1)
      : doc["dist-tags"].latest;
    return { version, released: doc.time?.[version] };
  }
  if (pin.source === "pypi") {
    const doc = JSON.parse(get(`https://pypi.org/pypi/${pin.name}/json`));
    const versions = Object.entries(doc.releases)
      .filter(([v, files]) => files.length > 0 && stable(v))
      .map(([v]) => v)
      .toSorted((a, b) => (older(a, b) ? -1 : 1));
    const version = versions.at(-1);
    return {
      version,
      released: doc.releases[version][0].upload_time_iso_8601,
    };
  }
  if (pin.source === "go") {
    const latest = goLatest(pin.name);
    return { version: latest.Version, released: latest.Time };
  }
  const release = github(`repos/${pin.name}/releases/latest`);
  const found = { version: release.tag_name, released: release.published_at };
  if (pin.source === "action")
    found.sha = github(`repos/${pin.name}/commits/${release.tag_name}`).sha;
  // A pin written without the tag's `v` (k6-version: 2.0.0) keeps that form.
  if (!pin.version.startsWith("v"))
    found.version = found.version.replace(/^v/, "");
  return found;
}

/** { verdict, line } for one pin: behind, held, new (under a day old), ok or unknown. */
export function judge(pin, latest, now) {
  const label = `${pin.where}  ${pin.name}`;
  if (!latest?.version)
    return { verdict: "unknown", line: `${label}: could not be compared` };
  if (!older(pin.version, latest.version))
    return { verdict: "ok", line: label };
  const date = latest.released
    ? `, released ${String(latest.released).slice(0, 10)}`
    : "";
  const line = `${label}: ${pin.version} -> ${latest.version}${date}`;
  const hold = HOLDS[`${pin.source}:${pin.name}`];
  if (hold) return { verdict: "held", line: `${line} (held: ${hold})` };
  if (latest.released && now - Date.parse(latest.released) < DAY_MS)
    return { verdict: "new", line: `${line} (under a day old: not yet)` };
  return { verdict: "behind", line };
}

/** The pin as it reads once moved to `latest`. */
export function moved(pin, latest) {
  if (pin.source === "action")
    return `${pin.name}@${latest.sha} # ${latest.version}`;
  return pin.token.replace(pin.version, latest.version);
}

/** `v0.61.0` as `0.61.0`. */
function bare(version) {
  return version.replace(/^v/, "");
}

/**
 * Every text a pin is written as, with what it becomes: the pin itself, and
 * the other forms the same version takes elsewhere.
 */
export function movesOf(pin, latest) {
  const moves = [[pin.token, moved(pin, latest)]];
  // A release's version is also written bare beside the tool's name
  // ("Install agnix 0.60.3").
  if (pin.source === "github") {
    const tool = pin.name.split("/")[1];
    moves.push([
      `${tool} ${bare(pin.version)}`,
      `${tool} ${bare(latest.version)}`,
    ]);
  }
  // A package is also pinned where it is not installed: package.json's
  // packageManager, corepack, mise.toml.
  if (pin.source === "npm" || pin.source === "pypi")
    moves.push(
      [`${pin.name}@${pin.version}`, `${pin.name}@${latest.version}`],
      [`${pin.name} = "${pin.version}"`, `${pin.name} = "${latest.version}"`],
    );
  return moves;
}

/** The name a pin's tool goes by in the inventory: `golangci-lint`, `quint`, `ast-grep`, `k6`. */
export function toolName(pin) {
  const parts = pin.name.split("/");
  const last = parts.at(-1);
  return last === "cli" ? parts.at(-2).replace(/^@/, "") : last;
}

/** Every workflow pin, once each. */
function workflowPins() {
  const dir = join(repoRoot, ".github", "workflows");
  const files = [
    ...readdirSync(dir).map((name) => join(dir, name)),
    join(repoRoot, "scripts", "update-visual-baseline.sh"),
  ];
  const seen = new Map();
  for (const file of files)
    for (const pin of pinsIn(readFileSync(file, "utf8")))
      seen.set(pin.token, { ...pin, where: "ci" });
  return [...seen.values()];
}

/** What `pnpm outdated` lists, as pins. */
function packagePins() {
  const out = spawnSync("pnpm", ["outdated", "-r", "--format", "json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  let listed = {};
  try {
    listed = JSON.parse(out.stdout || "{}");
  } catch {
    return [];
  }
  return Object.entries(listed).map(([name, info]) => ({
    source: "npm",
    name,
    version: info.current,
    where: "pnpm",
  }));
}

/** The Brewfile's formulas Homebrew has a newer version of. */
function brewBehind() {
  const brewfile = join(repoRoot, "Brewfile");
  if (!existsSync(brewfile)) return [];
  const ours = new Set(
    [...readFileSync(brewfile, "utf8").matchAll(/^brew "([^"]+)"/gm)].map((m) =>
      m[1].split("/").at(-1),
    ),
  );
  const out = spawnSync("brew", ["outdated", "--quiet"], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout.split("\n").filter((name) => ours.has(name));
}

/**
 * A release download pinned by checksum (`curl … <url>`, then `echo "<sha256>
 * …" | sha256sum -c`): for each such pair whose checksum is not the one
 * GitHub records for that asset, [written, recorded].
 */
function checksumMoves(text) {
  const pairs = text.matchAll(
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/\s]+)\/(\S+)\n\s*echo "([0-9a-f]{64}) /g,
  );
  return [...pairs].flatMap(([found, repo, tag, asset, written]) => {
    const url = found.split("\n")[0];
    const release = github(`repos/${repo}/releases/tags/${tag}`);
    const digest = release.assets.find((a) => a.name === asset)?.digest;
    // A release older than GitHub's digests has none: hash the download.
    const recorded =
      /^sha256:([0-9a-f]{64})$/.exec(digest ?? "")?.[1] ??
      /^[0-9a-f]{64}/.exec(
        spawnSync(
          "sh",
          ["-c", 'curl -fsSL --max-time 300 "$1" | shasum -a 256', "sh", url],
          { encoding: "utf8" },
        ).stdout,
      )?.[0];
    if (!recorded) throw new Error(`no sha256 for ${url}`);
    return recorded === written ? [] : [[written, recorded]];
  });
}

/** `{ formula: version }` for the installed formulas among `names`. */
function brewVersions(names) {
  const out = spawnSync("brew", ["list", "--versions", ...names], {
    encoding: "utf8",
  });
  return Object.fromEntries(
    out.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").slice(0, 2)),
  );
}

/** A Homebrew version without its revision: `1.2.3_1` as `1.2.3`. */
function plain(version) {
  return version.replace(/_\d+$/, "");
}

/** `afl++` as a regular expression that matches those five characters. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The inventory with each upgraded tool's version moved: on a line that
 * names the tool, its old version becomes the new one. `changes` is
 * [name, from, to] each; a Homebrew revision (`1.2.3_1`) is written without it.
 */
export function syncVersions(text, changes) {
  return text
    .split("\n")
    .map((line) => {
      let next = line;
      for (const [name, from, to] of changes)
        if (
          new RegExp(`(^|[^\\w-])${literal(name)}([^\\w-]|$)`, "i").test(line)
        )
          next = next.replaceAll(plain(from), plain(to));
      return next;
    })
    .join("\n");
}

/** Upgrade the Brewfile's formulas Homebrew has newer, and say so in the inventory. */
function upgradeMachine() {
  const names = brewBehind();
  if (names.length === 0) return;
  const before = brewVersions(names);
  // Old versions stay on disk: a process started from one keeps running.
  spawnSync("brew", ["upgrade", ...names], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, HOMEBREW_NO_INSTALL_CLEANUP: "1" },
  });
  const after = brewVersions(names);
  const changes = names
    .filter(
      (name) => before[name] && after[name] && before[name] !== after[name],
    )
    .map((name) => [name, before[name], after[name]]);
  const inventory = join(repoRoot, "library", "README.md");
  if (existsSync(inventory))
    writeFileSync(
      inventory,
      syncVersions(readFileSync(inventory, "utf8"), changes),
    );
  process.stdout.write(
    `upgraded ${changes.length} formulas: run \`check doctor\`, then the done gate\n`,
  );
}

/** The projects beside this repository whose kit is not the committed one, a line each. */
function consumersBehind() {
  const script = join(repoRoot, "scripts", "consumer-upgrade.mjs");
  if (!existsSync(script)) return [];
  const out = spawnSync(process.execPath, [script, "--status"], {
    encoding: "utf8",
  });
  return out.stdout.split("\n").filter(Boolean);
}

/** Replace each moved pin's text in every tracked file that names it. */
function apply(moves) {
  const files = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && !APPLY_SKIP.test(file));
  let changed = 0;
  for (const file of files) {
    const path = join(repoRoot, file);
    if (statSync(path).size > 2 * 1024 * 1024) continue;
    const text = readFileSync(path, "utf8");
    let next = text;
    for (const [from, to] of moves) next = next.replaceAll(from, to);
    // Every run, not only after a move: a URL moved by hand heals too.
    if (file.startsWith(".github/workflows/"))
      for (const [from, to] of checksumMoves(next))
        next = next.replaceAll(from, to);
    if (next !== text) {
      writeFileSync(path, next);
      changed += 1;
    }
  }
  return changed;
}

/** A newer release of the self-test's pin, published at `released`. */
function at(released) {
  return { version: "0.18.0", released };
}

function selfTest() {
  const pins = pinsIn(
    [
      "  go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0",
      '  run: python -m pip install "zizmor==1.32.0" "typos==1.51.1"',
      "  uv tool install ruff==0.17.3",
      "  npm install -g @ast-grep/cli@0.51.1",
      '  SEMGREP_VERSION: "1.183.0"',
      "  k6-version: 2.0.0",
      "  curl -o x https://github.com/agent-sh/agnix/releases/download/v0.60.3/agnix.tar.gz",
      "  uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
      "  node-version: 22",
      "  - uses: pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115 # v6.1.1",
      "    with:",
      "      version: 10.34.7",
      "  - uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3",
      "    with:",
      '      version: "0.9.30"',
    ].join("\n"),
  );
  assert.deepEqual(
    pins.map((pin) => `${pin.source} ${pin.name} ${pin.version}`),
    [
      "go github.com/golangci/golangci-lint/v2/cmd/golangci-lint v2.15.0",
      "pypi zizmor 1.32.0",
      "pypi typos 1.51.1",
      "pypi ruff 0.17.3",
      "npm @ast-grep/cli 0.51.1",
      "npm pnpm 10.34.7",
      "pypi uv 0.9.30",
      "pypi semgrep 1.183.0",
      "github grafana/k6 2.0.0",
      "github agent-sh/agnix v0.60.3",
      "action actions/checkout v4.3.1",
      "action pnpm/action-setup v6.1.1",
      "action astral-sh/setup-uv v10.3.3",
    ],
  );
  assert.ok(older("v2.15.0", "v2.16.0") && older("1.9.5", "1.10.0"));
  assert.ok(!older("1.51.1", "1.51.1") && !older("2.0.0", "1.99.9"));
  assert.ok(
    !stable("1.0.0-rc.1") && !stable("8.2.0b1") && stable("2026.10.23"),
  );
  const now = Date.parse("2026-11-09T12:00:00Z");
  const named = (name) => pins.find((found) => found.name === name);
  const pin = { ...named("ruff"), where: "ci" };
  assert.equal(judge(pin, at("2026-10-01T00:00:00Z"), now).verdict, "behind");
  assert.equal(judge(pin, at("2026-11-09T09:00:00Z"), now).verdict, "new");
  assert.equal(judge(pin, { version: "0.17.3" }, now).verdict, "ok");
  assert.equal(judge(pin, undefined, now).verdict, "unknown");
  const types = {
    source: "npm",
    name: "@types/node",
    version: "22.0.0",
    where: "pnpm",
  };
  assert.equal(
    judge(types, { version: "26.6.6", released: "2026-10-01T00:00:00Z" }, now)
      .verdict,
    "held",
  );
  assert.equal(moved(pin, { version: "0.18.0" }), "ruff==0.18.0");
  assert.deepEqual(
    ["@ast-grep/cli", "golangci-lint", "agent-sh/agnix", "ruff"].map((name) =>
      toolName(pins.find((found) => found.name.endsWith(name))),
    ),
    ["ast-grep", "golangci-lint", "agnix", "ruff"],
  );
  assert.equal(
    syncVersions(
      "| ruff, ruff format | 0.17.3 | brew |\n| sqruff | 0.17.3 | brew |\n| Buf | 1.73.0 | brew |",
      [
        ["ruff", "0.17.3", "0.17.4"],
        ["buf", "1.73.0_1", "1.75.0"],
        ["afl++", "5.02c", "5.03c"],
      ],
    ),
    "| ruff, ruff format | 0.17.4 | brew |\n| sqruff | 0.17.3 | brew |\n| Buf | 1.75.0 | brew |",
  );
  assert.deepEqual(movesOf(named("pnpm"), { version: "10.34.9" }), [
    ["version: 10.34.7", "version: 10.34.9"],
    ["pnpm@10.34.7", "pnpm@10.34.9"],
    ['pnpm = "10.34.7"', 'pnpm = "10.34.9"'],
  ]);
  assert.deepEqual(
    movesOf(named("agent-sh/agnix"), { version: "v0.61.0" })[1],
    ["agnix 0.60.3", "agnix 0.61.0"],
  );
  assert.equal(
    moved(named("pnpm"), { version: "10.34.9" }),
    "version: 10.34.9",
  );
  assert.equal(
    moved(named("semgrep"), { version: "1.190.0" }),
    'SEMGREP_VERSION: "1.190.0"',
  );
  assert.equal(
    moved(named("actions/checkout"), {
      version: "v5.0.0",
      sha: "a".repeat(40),
    }),
    `actions/checkout@${"a".repeat(40)} # v5.0.0`,
  );
  process.stdout.write("outdated self-test: ok\n");
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--self-test")) return selfTest();
  if (args.has("--machine")) return upgradeMachine();
  if (args.has("--daily")) {
    // The hook waits for nothing: it says what the last look found, and
    // starts the next look, detached, when that one is a day old.
    const known = existsSync(FOUND);
    if (known) process.stdout.write(readFileSync(FOUND, "utf8"));
    if (!known || Date.now() - statSync(FOUND).mtimeMs >= DAY_MS)
      spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    return;
  }
  const now = Date.now();
  const results = [...workflowPins(), ...packagePins()].map((pin) => {
    let latest;
    try {
      latest = newest(pin);
    } catch {
      // no answer: judged "not compared"
    }
    const { verdict, line } = judge(pin, latest, now);
    return { pin, latest, verdict, line };
  });
  const brew = brewBehind();
  // One line per pin, however many ways it is written (semgrep twice).
  const lines = (verdict) => [
    ...new Set(results.filter((r) => r.verdict === verdict).map((r) => r.line)),
  ];
  const consumers = consumersBehind();
  const behind = [
    ...lines("behind"),
    ...brew.map((name) => `brew  ${name}: Homebrew has a newer one`),
    ...consumers.map((line) => `kit  ${line}`),
  ];
  const report =
    behind.length === 0
      ? ""
      : [
          `${behind.length} behind:`,
          ...behind.map((line) => `  ${line}`),
          ...(lines("behind").length > 0
            ? ["  node scripts/outdated.mjs --apply"]
            : []),
          ...(brew.length > 0 ? [`  brew upgrade ${brew.join(" ")}`] : []),
          ...(consumers.length > 0
            ? ["  node scripts/consumer-upgrade.mjs <project> --apply"]
            : []),
          "",
        ].join("\n");
  if (args.has("--refresh")) {
    // Offline, every pin is "not compared": keep what the last look found.
    if (results.some((r) => r.verdict !== "unknown")) {
      mkdirSync(dirname(FOUND), { recursive: true });
      writeFileSync(FOUND, report);
    }
    return;
  }
  process.stdout.write(report);
  if (args.has("--all"))
    for (const [id, [line, why]] of Object.entries(WITHIN))
      process.stdout.write(`${id} stays on ${line}.x: ${why}\n`);
  if (args.has("--all"))
    for (const [title, verdict] of [
      ["Too new to take", "new"],
      ["Held", "held"],
      ["Not compared", "unknown"],
    ])
      if (lines(verdict).length > 0)
        process.stdout.write(
          `${title}:\n${lines(verdict)
            .map((line) => `  ${line}`)
            .join("\n")}\n`,
        );
  if (args.has("--apply")) {
    const due = results.filter((r) => r.verdict === "behind");
    const moves = due
      .filter((r) => r.pin.where === "ci")
      .flatMap((r) => movesOf(r.pin, r.latest));
    const files = apply(moves);
    // The inventory names each tool with the version CI installs.
    const inventory = join(repoRoot, "library", "README.md");
    if (existsSync(inventory))
      writeFileSync(
        inventory,
        syncVersions(
          readFileSync(inventory, "utf8"),
          due
            .filter((r) => r.pin.where === "ci" && r.pin.source !== "action")
            .map((r) => [
              toolName(r.pin),
              bare(r.pin.version),
              bare(r.latest.version),
            ]),
        ),
      );
    const packages = due
      .filter((r) => r.pin.where === "pnpm")
      .map((r) => r.pin.name);
    if (packages.length > 0)
      spawnSync("pnpm", ["update", "-r", "--latest", ...packages], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"],
      });
    process.stdout.write(
      `moved ${moves.length} CI pins in ${files} files and ${packages.length} packages: run the done gate\n`,
    );
    return;
  }
  if (behind.length > 0) process.exitCode = 1;
}

// Run, not imported: the functions above are also the inventory's to call.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
