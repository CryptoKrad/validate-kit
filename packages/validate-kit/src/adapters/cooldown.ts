import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { globSync } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { gitListed, toPosix } from "../detect/languages.js";
import {
  absPosix,
  compareSemver,
  escapeRegex,
  finding,
  lineOf,
} from "./base.js";
import { durationMinutes, type Fresh, gained, LOOKUP } from "./lockfile-age.js";

/** The lockfiles that say pnpm, uv or npm is the project's manager. */
const LOCKFILES = ["pnpm-lock.yaml", "uv.lock", "package-lock.json"];

/** Folders whose lockfiles are not the project's own. */
const NOT_OWN = [
  "**/node_modules/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/target/**",
  "**/dist/**",
];

interface CooldownTask {
  /** Each lockfile outside the config's `ignore` and git's (absolute, POSIX). */
  lockfiles: string[];
  /** The registry packages the change added, to look up (lockfile-age.ts). */
  fresh?: Fresh[];
  /** Added packages past the lookup's cap, per lockfile. */
  dropped?: Record<string, number>;
}

/** What the lookup prints per package. */
interface Looked extends Fresh {
  published?: string;
  /** The registry's Date header: ages by its clock, not this machine's. */
  now?: string;
  error?: string;
}

/** The registry npm and pnpm read their public packages from. */
const NPMJS = "https://registry.npmjs.org";

/** A day: the cooldown a manager waits when its own setting says none. */
const DAY = 1440;

interface Policy {
  /** Minutes a release must be public before it is installed. */
  minutes: number;
  /** A package the project exempted, or one from another registry. */
  skip(name: string, version: string): boolean;
}

/** `@scope/*` and `name@1.0.0` as pnpm's minimumReleaseAgeExclude reads them. */
function excludes(entries: unknown, name: string, version: string): boolean {
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    if (typeof entry !== "string") return false;
    if (entry === name || entry === `${name}@${version}`) return true;
    return (
      entry.includes("*") &&
      new RegExp(`^${entry.split("*").map(escapeRegex).join(".*")}$`).test(name)
    );
  });
}

/** Where `.npmrc` sends a package: its scope's registry, else the default. */
function registryOf(npmrc: string | undefined, name: string): string {
  const scope = /^(@[^/]+)\//.exec(name)?.[1];
  return (
    (scope && npmrcValue(npmrc, `${escapeRegex(scope)}:registry`)) ??
    npmrcValue(npmrc, "registry") ??
    NPMJS
  );
}

/** How long `lockfile`'s manager waits, and what it leaves out. */
function policyFor(dir: string, lockfile: string, now: number): Policy {
  const npmrc = read(join(dir, ".npmrc"));
  // A package from a private registry is not public npm's to date.
  const elsewhere = (name: string) =>
    !registryOf(npmrc, name).startsWith(NPMJS);
  if (lockfile === "pnpm-lock.yaml") {
    let settings: {
      minimumReleaseAge?: unknown;
      minimumReleaseAgeExclude?: unknown;
    } = {};
    try {
      settings =
        (parseYaml(read(join(dir, "pnpm-workspace.yaml")) ?? "") as
          typeof settings | null) ?? {};
    } catch {
      // pnpm reports a workspace file it cannot read itself.
    }
    const minutes = Number(
      settings.minimumReleaseAge ?? npmrcValue(npmrc, "minimum-release-age"),
    );
    return {
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DAY,
      skip: (name, version) =>
        elsewhere(name) ||
        excludes(settings.minimumReleaseAgeExclude, name, version),
    };
  }
  if (lockfile === "uv.lock") {
    const name = existsSync(join(dir, "uv.toml"))
      ? "uv.toml"
      : "pyproject.toml";
    let uv: { "exclude-newer"?: unknown; "exclude-newer-package"?: unknown } =
      {};
    try {
      const doc = parseToml(read(join(dir, name)) ?? "") as {
        tool?: { uv?: typeof uv };
      } & typeof uv;
      uv = (name === "uv.toml" ? doc : doc.tool?.uv) ?? {};
    } catch {
      // An unreadable file sets nothing.
    }
    const value = uv["exclude-newer"];
    // A duration, or a date: nothing published after it (its age in minutes).
    const date = typeof value === "string" ? Date.parse(value) : Number.NaN;
    const minutes =
      typeof value === "string"
        ? (durationMinutes(value) ??
          (Number.isNaN(date) ? DAY : Math.max(0, (now - date) / 60_000)))
        : DAY;
    const own = uv["exclude-newer-package"];
    return {
      minutes,
      // A package with its own setting is the project's call.
      skip: (pkg) =>
        typeof own === "object" && own !== null && Object.hasOwn(own, pkg),
    };
  }
  const days = Number(npmrcValue(npmrc, "min-release-age"));
  return {
    minutes: Number.isFinite(days) && days > 0 ? days * DAY : DAY,
    skip: (name) => elsewhere(name),
  };
}

/** The line of a lockfile that pins `name` at `version`, by its format. */
function pinnedAt(file: string, name: string, version: string): number {
  const lines = (read(file) ?? "").split("\n");
  const id = escapeRegex(name);
  const ver = escapeRegex(version);
  let at = -1;
  if (file.endsWith("pnpm-lock.yaml"))
    // `  name@1.0.0:` or `  '@scope/name@1.0.0':`, the packages: key.
    at = lines.findIndex((line) =>
      new RegExp(`^\\s*'?${id}@${ver}'?:\\s*$`).test(line),
    );
  else {
    // npm: a `node_modules/<name>"` block whose version is this one; uv: a
    // `name = "<name>"` line followed by `version = "<version>"`.
    const header = file.endsWith("uv.lock")
      ? new RegExp(`^name = "${id}"$`)
      : new RegExp(`node_modules/${id}": \\{`);
    const pinned = file.endsWith("uv.lock")
      ? new RegExp(`^version = "${ver}"$`)
      : new RegExp(`"version": "${ver}"`);
    at = lines.findIndex(
      (line, i) =>
        header.test(line.trim()) &&
        lines.slice(i + 1, i + 6).some((next) => pinned.test(next.trim())),
    );
  }
  return at < 0 ? 1 : at + 1;
}

/** The files a cooldown lives in, and the lockfiles that say a manager is used. */
const INPUT =
  /(?:^|\/)(?:pnpm-workspace\.yaml|pnpm-lock\.yaml|package\.json|package-lock\.json|\.npmrc|uv\.lock|uv\.toml|pyproject\.toml)$/;

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The pnpm version package.json's `packageManager` pins, if it does. */
function pinnedPnpm(root: string): string | undefined {
  try {
    const pkg = JSON.parse(read(join(root, "package.json")) ?? "") as {
      packageManager?: unknown;
    };
    return typeof pkg.packageManager === "string"
      ? /^pnpm@(\d+\.\d+\.\d+)/.exec(pkg.packageManager)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A key's value in an .npmrc, read as npm's ini parser does: the last line
 * wins, quotes and an inline `;`/`#` comment are dropped.
 */
function npmrcValue(text: string | undefined, key: string): string | undefined {
  let value: string | undefined;
  for (const line of (text ?? "").split("\n")) {
    const m = new RegExp(`^\\s*${key}\\s*=(.*)$`).exec(line);
    if (m?.[1] === undefined) continue;
    value = m[1]
      .replace(/\s[;#].*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
  return value;
}

interface Gap {
  file: string;
  line: number;
  rule: string;
  message: string;
}

/** What each package manager used in `root` lacks (release-age-cooldown.md). */
function gaps(root: string, has: (lockfile: string) => boolean): Gap[] {
  const out: Gap[] = [];
  const npmrcPath = join(root, ".npmrc");
  const npmrc = read(npmrcPath);
  if (has("pnpm-lock.yaml")) {
    const path = join(root, "pnpm-workspace.yaml");
    const text = read(path);
    let settings: Record<string, unknown> = {};
    try {
      const doc = parseYaml(text ?? "") as unknown;
      if (doc !== null && typeof doc === "object" && !Array.isArray(doc))
        settings = doc as Record<string, unknown>;
    } catch {
      // pnpm reports a workspace file it cannot read itself.
    }
    const pinned = pinnedPnpm(root);
    const major = pinned ? Number(pinned.split(".")[0]) : undefined;
    // pnpm 10 also reads its settings from .npmrc; pnpm 11 only login and
    // network keys.
    const fromNpmrc = (key: string) =>
      major === undefined || major < 11 ? npmrcValue(npmrc, key) : undefined;
    const file = text === undefined ? join(root, "pnpm-lock.yaml") : path;
    const age = settings.minimumReleaseAge ?? fromNpmrc("minimum-release-age");
    const minutes =
      typeof age === "number" || typeof age === "string" ? Number(age) : age;
    // pnpm 11 waits a day when it is not set; only an explicit 0 turns that
    // off.
    const waits =
      minutes === undefined
        ? (major ?? 0) >= 11
        : typeof minutes === "number" && minutes > 0;
    if (!waits)
      out.push({
        file,
        line: lineOf(text, /^minimumReleaseAge\s*:/),
        rule: "pnpm-minimum-release-age",
        message:
          "pnpm installs a version the minute it is published: set `minimumReleaseAge: 1440` (minutes) in pnpm-workspace.yaml",
      });
    const trust = settings.trustPolicy ?? fromNpmrc("trust-policy");
    if (trust !== "no-downgrade")
      out.push({
        file,
        line: lineOf(text, /^trustPolicy\s*:/),
        rule: "pnpm-trust-policy",
        message:
          "pnpm installs a release that lost its predecessors' provenance: set `trustPolicy: no-downgrade` in pnpm-workspace.yaml, with `trustPolicyIgnoreAfter: 43200` so a release from before its package adopted provenance does not block every add",
      });
    if (pinned && compareSemver(pinned, "10.27.0") < 0)
      out.push({
        file: join(root, "package.json"),
        line: lineOf(read(join(root, "package.json")), /"packageManager"/),
        rule: "pnpm-too-old",
        message: `pnpm ${pinned} lacks minimumReleaseAge (10.16.0), trustPolicy (10.21.0) or trustPolicyIgnoreAfter (10.27.0): pin pnpm 10.27.0 or later`,
      });
  }
  if (has("uv.lock")) {
    // With a uv.toml, uv ignores [tool.uv] in pyproject.toml.
    const name = existsSync(join(root, "uv.toml"))
      ? "uv.toml"
      : "pyproject.toml";
    const text = read(join(root, name));
    let value: unknown;
    try {
      const doc = parseToml(text ?? "") as {
        "exclude-newer"?: unknown;
        tool?: { uv?: { "exclude-newer"?: unknown } };
      };
      value =
        name === "uv.toml"
          ? doc["exclude-newer"]
          : doc.tool?.uv?.["exclude-newer"];
    } catch {
      value = undefined;
    }
    if (typeof value !== "string" || value.trim() === "")
      out.push({
        file: join(root, text === undefined ? "uv.lock" : name),
        line: lineOf(text, /^\s*\[tool\.uv\]|exclude-newer/),
        rule: "uv-exclude-newer",
        message:
          name === "uv.toml"
            ? 'uv installs a version the minute it is published: set `exclude-newer = "7 days"` in uv.toml (uv ignores [tool.uv] where a uv.toml is)'
            : 'uv installs a version the minute it is published: set `exclude-newer = "7 days"` under [tool.uv] (or in uv.toml)',
      });
  }
  if (has("package-lock.json")) {
    const days = Number(npmrcValue(npmrc, "min-release-age"));
    if (!Number.isFinite(days) || days <= 0)
      out.push({
        file: npmrc === undefined ? join(root, "package-lock.json") : npmrcPath,
        line: lineOf(npmrc, /^\s*min-release-age\s*=/),
        rule: "npm-min-release-age",
        message:
          "npm installs a version the minute it is published: set `min-release-age=1` (days) in .npmrc",
      });
  }
  return out;
}

/**
 * cooldown — each package manager the project uses waits before installing a
 * new release: a hijacked maintainer's malicious version is usually caught
 * and pulled within hours, after an agent's `install` would have taken it.
 * pnpm `minimumReleaseAge` + `trustPolicy: no-downgrade`, uv `exclude-newer`,
 * npm `min-release-age` (docs/research/lint-toolchain/release-age-cooldown.md).
 * It reads the config files beside each lockfile outside the config's
 * `ignore` and git's (a monorepo's folders too); the kit's own node is spawned only so
 * the run has a command. On by default where a lockfile shows the manager
 * is used; `tools.cooldown.enabled: false` turns it off.
 */
export const cooldown: ToolAdapter = {
  id: "cooldown",
  layer: "security",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: process.execPath,
  binSetting: false,
  supportsFix: false,
  fixWriteBack: false,
  minVersion: "18.0.0",
  installHint: "node (the kit's own runtime)",
  tier: "verify",

  async expand(seed: TaskSeed, env: PlanEnv): Promise<TaskSeed[]> {
    // A change that touches no manifest, lockfile or setting changes nothing
    // here.
    if (
      env.changedPaths &&
      !env.changedPaths.some((path) => INPUT.test(toPosix(path)))
    )
      return [];
    // Each lockfile of a manager it knows that git would list, as the
    // validation scope holds (an ignored clone of another project, or a
    // submodule, is not the project's): none, no run.
    const listed = await gitListed(env.projectRoot);
    const lockfiles = globSync(
      LOCKFILES.map((name) => `**/${name}`),
      {
        cwd: env.projectRoot,
        absolute: true,
        ignore: [...NOT_OWN, ...env.config.ignore],
        followSymbolicLinks: false,
      },
    )
      .map(toPosix)
      .filter((file) => !listed || listed(file))
      .toSorted();
    if (lockfiles.length === 0) return [];
    // The packages the change added, with the age each must be.
    const root = toPosix(env.projectRoot);
    const now = Date.now();
    const added = lockfiles.flatMap((file) => {
      const lockfile = posix.relative(root, file);
      const policy = policyFor(posix.dirname(file), posix.basename(file), now);
      return (gained(root, lockfile, env.changedMode === "staged") ?? [])
        .filter((p) => !policy.skip(p.name, p.version))
        .map((p) => ({
          registry: p.registry,
          name: p.name,
          version: p.version,
          lockfile,
          minutes: policy.minutes,
        }));
    });
    // Bounded: a new lockfile adds hundreds. The rest are counted, not lost.
    const fresh = added.slice(0, 100);
    const dropped: Record<string, number> = {};
    for (const p of added.slice(100))
      dropped[p.lockfile] = (dropped[p.lockfile] ?? 0) + 1;
    const task: CooldownTask = { lockfiles, fresh, dropped };
    return [{ ...seed, options: task }];
  },

  // The kit's own node, so no project's `node` is looked up: it asks the
  // registries when the added packages were published, or does nothing.
  buildArgs(ctx: ToolContext): BuiltCommand {
    const fresh = (ctx.options as CooldownTask).fresh ?? [];
    return {
      bin: process.execPath,
      args:
        fresh.length > 0
          ? ["--input-type=module", "-e", LOOKUP, JSON.stringify(fresh)]
          : ["-e", ""],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const { lockfiles, fresh = [], dropped = {} } = ctx.options as CooldownTask;
    const dirs = [...new Set(lockfiles.map((file) => posix.dirname(file)))];
    const findings: Finding[] = dirs
      .flatMap((dir) =>
        gaps(dir, (name) => lockfiles.includes(posix.join(dir, name))),
      )
      .map((gap) =>
        finding({
          tool: "cooldown",
          layer: "security",
          file: absPosix(cwd, toPosix(gap.file)),
          line: gap.line,
          col: 1,
          ruleId: gap.rule,
          severity: "warning",
          message: gap.message,
          fixable: false,
        }),
      );
    if (fresh.length > 0) {
      let looked: Looked[];
      try {
        looked = JSON.parse(raw.stdout) as Looked[];
      } catch {
        throw new Error(
          `the publish-date lookup printed no JSON: ${raw.stderr.trim().split("\n").at(-1) ?? ""}`,
        );
      }
      const unknown = new Map<string, Looked[]>();
      for (const p of looked) {
        const published = p.published ? Date.parse(p.published) : Number.NaN;
        if (Number.isNaN(published)) {
          unknown.set(p.lockfile, [...(unknown.get(p.lockfile) ?? []), p]);
          continue;
        }
        const clock = p.now ? Date.parse(p.now) : Number.NaN;
        const age =
          ((Number.isNaN(clock) ? Date.now() : clock) - published) / 60_000;
        if (age >= p.minutes) continue;
        const file = absPosix(cwd, p.lockfile);
        findings.push(
          finding({
            tool: "cooldown",
            layer: "security",
            file,
            line: pinnedAt(file, p.name, p.version),
            col: 1,
            ruleId: "young-package",
            severity: "warning",
            message: `${p.name}@${p.version} was published ${Math.floor(age / 60)} h ago, inside the ${Math.round(p.minutes / 60)} h cooldown: the lockfile took a release nobody has had time to vet (a cooldown overridden, or a lockfile from elsewhere)`,
            fixable: false,
          }),
        );
      }
      for (const [lockfile, ps] of unknown)
        findings.push(
          finding({
            tool: "cooldown",
            layer: "security",
            file: absPosix(cwd, lockfile),
            line: 1,
            col: 1,
            ruleId: "publish-date-unknown",
            severity: "info",
            message: `could not check when ${ps.length} new package(s) were published (${ps[0]?.name}@${ps[0]?.version}: ${ps[0]?.error ?? "no date"})`,
            fixable: false,
          }),
        );
    }
    for (const [lockfile, count] of Object.entries(dropped))
      findings.push(
        finding({
          tool: "cooldown",
          layer: "security",
          file: absPosix(cwd, lockfile),
          line: 1,
          col: 1,
          ruleId: "publish-date-unknown",
          severity: "info",
          message: `${count} more new package(s) were not looked up: at most 100 per run`,
          fixable: false,
        }),
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
