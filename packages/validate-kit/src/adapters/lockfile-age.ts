import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { toPosix } from "../detect/languages.js";

/** A registry package a lockfile pins. */
export interface Locked {
  registry: "npm" | "pypi";
  name: string;
  version: string;
}

/** A package a change added, and the age it must be (cooldown.ts). */
export interface Fresh extends Locked {
  /** The lockfile, relative to the project root. */
  lockfile: string;
  /** Minutes it must have been public, from the manager's own setting. */
  minutes: number;
}

const key = (p: Locked) => `${p.registry}\0${p.name}\0${p.version}`;

/** The registry packages a lockfile names (pnpm 9, npm 7+, uv). */
export function lockedPackages(file: string, text: string): Locked[] {
  try {
    if (file.endsWith("pnpm-lock.yaml")) {
      const doc = parseYaml(text) as {
        packages?: Record<
          string,
          { resolution?: { tarball?: unknown } } | null
        >;
      };
      return Object.entries(doc.packages ?? {}).flatMap(([id, entry]) => {
        // name@version; a git, file or link dependency names no version, and
        // a tarball URL is not the registry's.
        const m = /^((?:@[^/@]+\/)?[^@/]+)@(\d[^()]*)$/.exec(id);
        return m?.[1] && m[2] && entry?.resolution?.tarball === undefined
          ? [{ registry: "npm" as const, name: m[1], version: m[2] }]
          : [];
      });
    }
    if (file.endsWith("package-lock.json")) {
      const doc = JSON.parse(text) as {
        packages?: Record<
          string,
          { name?: string; version?: string; resolved?: string }
        >;
      };
      return Object.entries(doc.packages ?? {}).flatMap(([path, pkg]) => {
        // An alias (`string-width-cjs`) names the real package in `name`.
        const name =
          pkg.name ??
          /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path)?.[1];
        return name &&
          pkg.version &&
          (pkg.resolved ?? "").startsWith("https://registry.npmjs.org/")
          ? [{ registry: "npm" as const, name, version: pkg.version }]
          : [];
      });
    }
    if (file.endsWith("uv.lock")) {
      const doc = parseToml(text) as {
        package?: {
          name?: string;
          version?: string;
          source?: { registry?: string };
        }[];
      };
      return (doc.package ?? []).flatMap((pkg) =>
        pkg.name &&
        pkg.version &&
        (pkg.source?.registry ?? "").startsWith("https://pypi.org/")
          ? [
              {
                registry: "pypi" as const,
                name: pkg.name,
                version: pkg.version,
              },
            ]
          : [],
      );
    }
  } catch {
    // A lockfile that does not parse names nothing the kit can check.
  }
  return [];
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * The packages `lockfile` (relative to `root`) gained against what was
 * pushed: the upstream's merge base, else HEAD. A staged run compares the
 * index with HEAD. Undefined when git cannot say (no history).
 */
export function gained(
  root: string,
  lockfile: string,
  staged: boolean,
): Locked[] | undefined {
  const top = git(root, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return undefined;
  // git names the real path (/private/var on macOS).
  const rel = posix.relative(
    toPosix(top),
    posix.join(toPosix(realpathSync(root)), lockfile),
  );
  // What was pushed: the upstream, else the remote's default branch (a
  // pre-push worktree is detached; a branch may track nothing). With no
  // shared history (a shallow clone), only the uncommitted change.
  const pushed = staged
    ? undefined
    : ["@{upstream}", "origin/HEAD", "origin/main"]
        .map((ref) => git(root, ["merge-base", "HEAD", ref])?.trim())
        .find(Boolean);
  const base = pushed || "HEAD";
  const before = git(root, ["show", `${base}:${rel}`]) ?? "";
  let after: string | undefined;
  if (staged) after = git(root, ["show", `:${rel}`]);
  else
    try {
      after = readFileSync(posix.join(toPosix(root), lockfile), "utf8");
    } catch {
      after = undefined;
    }
  if (after === undefined) return [];
  const had = new Set(lockedPackages(lockfile, before).map(key));
  const seen = new Set<string>();
  return lockedPackages(lockfile, after).filter((p) => {
    const k = key(p);
    if (had.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `"7 days"`, `"24 hours"`, `"P7D"`, `"PT36H"` as minutes; else undefined. */
export function durationMinutes(value: string): number | undefined {
  const words = /^\s*(\d+)\s*(day|hour|minute|week)s?\s*$/i.exec(value);
  if (words?.[1] && words[2])
    return (
      Number(words[1]) *
      { minute: 1, hour: 60, day: 1440, week: 10_080 }[
        words[2].toLowerCase() as "minute" | "hour" | "day" | "week"
      ]
    );
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(
    value.trim(),
  );
  if (iso && value.trim().length > 1)
    return (
      Number(iso[1] ?? 0) * 10_080 +
      Number(iso[2] ?? 0) * 1440 +
      Number(iso[3] ?? 0) * 60 +
      Number(iso[4] ?? 0)
    );
  return undefined;
}

/**
 * Run by the kit's own node with the packages as argv[1] (JSON; the caller
 * caps them at 100); prints [{...package, now?, published?, error?}]. 8 at a
 * time, 10 s each, 15 s in all. VK_NPM_REGISTRY / VK_PYPI_URL point it
 * elsewhere (the tests' local server).
 */
export const LOOKUP = `
const pkgs = JSON.parse(process.argv[1]);
const npm = process.env.VK_NPM_REGISTRY || "https://registry.npmjs.org";
const pypi = process.env.VK_PYPI_URL || "https://pypi.org/pypi";
// One deadline for the whole lookup, and none after the network failed once:
// an offline machine waits seconds, not minutes.
const deadline = AbortSignal.timeout(15000);
let down;
async function one(p) {
  if (down) return { ...p, error: "not looked up: " + down };
  try {
    const url = p.registry === "npm"
      ? npm + "/" + p.name.replace("/", "%2f")
      : pypi + "/" + p.name + "/" + p.version + "/json";
    const res = await fetch(url, { signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]) });
    if (!res.ok) return { ...p, error: "HTTP " + res.status };
    const doc = await res.json();
    // The registry's clock, not this machine's.
    const now = res.headers.get("date") || undefined;
    if (p.registry === "npm") return { ...p, now, published: doc.time && doc.time[p.version] };
    const times = (doc.urls || []).map((u) => u.upload_time_iso_8601).filter(Boolean).sort();
    return { ...p, now, published: times[0] };
  } catch (e) {
    down = String((e && e.cause && e.cause.code) || (e && e.message) || e);
    return { ...p, error: down };
  }
}
const out = [];
for (let i = 0; i < pkgs.length; i += 8) out.push(...(await Promise.all(pkgs.slice(i, i + 8).map(one))));
process.stdout.write(JSON.stringify(out));
`;
