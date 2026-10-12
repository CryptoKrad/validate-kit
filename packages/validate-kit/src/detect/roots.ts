import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { globSync } from "tinyglobby";
import type { Language } from "../core/types.js";
import { toPosix } from "./languages.js";

/**
 * Dirs that are members of the cargo workspace rooted at wsRoot, or undefined
 * when wsRoot's Cargo.toml is absent / not a workspace. Membership is checked
 * explicitly (members globs minus exclude) — collapsing a NON-member (e.g. an
 * excluded crate) would silently un-lint it.
 */
function cargoWorkspaceMembers(wsRoot: string): Set<string> | undefined {
  let toml: string;
  try {
    toml = readFileSync(resolve(wsRoot, "Cargo.toml"), "utf8");
  } catch {
    return undefined;
  }
  if (!/^\[workspace(\]|\.)/m.test(toml)) return undefined;
  const list = (key: string): string[] => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "ms").exec(
      toml,
    );
    return [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
  };
  const members = list("members");
  if (members.length === 0) return undefined;
  const manifests = globSync(
    members.map((m) => `${m}/Cargo.toml`),
    {
      cwd: wsRoot,
      absolute: true,
      ignore: list("exclude").map((e) => `${e}/Cargo.toml`),
      dot: false,
      followSymbolicLinks: false,
      expandDirectories: false,
    },
  );
  return new Set(manifests.map((p) => toPosix(dirname(p))));
}

/** A cargo WORKSPACE run already covers its member crates: keep the workspace root, drop the members. */
function collapseCargoWorkspaceRoots(roots: string[]): string[] {
  if (roots.length <= 1) return roots;
  const memberSets = new Map<string, Set<string> | undefined>();
  const membersOf = (r: string): Set<string> | undefined => {
    if (!memberSets.has(r)) memberSets.set(r, cargoWorkspaceMembers(r));
    return memberSets.get(r);
  };
  return roots.filter(
    (r) => !roots.some((w) => w !== r && membersOf(w)?.has(toPosix(r))),
  );
}

const ROOT_REFINERS: Partial<Record<Language, (roots: string[]) => string[]>> =
  { rust: collapseCargoWorkspaceRoots };

/**
 * Narrow a language's spawn roots for tools that run once per language root.
 * A language with no refiner keeps every marker directory.
 */
export function refineRoots(lang: Language, roots: string[]): string[] {
  return ROOT_REFINERS[lang]?.(roots) ?? roots;
}
