import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Finding } from "../core/types.js";
import {
  fileFinding,
  gitSync,
  ignorePatterns,
  ignoring,
  nativeCheck,
} from "./native.js";

/** Where a tool saves the failing cases it found, beside what it tests. */
interface Store {
  /** The tool, as a reader knows it. */
  tool: string;
  /** A tracked file with this name (a git glob) marks a folder the tool works in. */
  marker: string;
  /** A changed file that can mean a fix is being committed. */
  source: RegExp;
  /** The folder of saved cases, relative to the marker's folder. */
  folder: string;
  /** Of the files in it, the saved cases. */
  saved: RegExp;
  /** A saved case beside a source file, anywhere below the marker (a git glob). */
  beside?: string;
}

// proptest: "The first thing we should do is add these to source control"
// (the proptest book, Getting Started); an integration test's case goes
// beside its source, `tests/api.proptest-regressions` (run on 1.12.0:
// docs/research/verification-continuum/anthropic-2026-11-16/assets/
// proptest-where-it-saves.txt). go test -fuzz: "submit the patch with
// the new testdata file acting as your regression test" (go.dev/doc/security/
// fuzz). rapid: "Persistence and automatic re-running of minimized failing
// test cases" (its README; persist.go writes testdata/rapid/<Test>/*.fail).
const STORES: readonly Store[] = [
  {
    tool: "proptest",
    marker: "Cargo.toml",
    source: /\.rs$|(^|\/)Cargo\.toml$/,
    folder: "proptest-regressions",
    saved: /\.txt$/,
    beside: "*.proptest-regressions",
  },
  {
    tool: "`go test -fuzz`",
    marker: "*_test.go",
    source: /\.go$/,
    folder: "testdata/fuzz",
    saved: /^Fuzz[^/]*\/[^/]+$/,
  },
  {
    tool: "rapid",
    marker: "*_test.go",
    source: /\.go$/,
    folder: "testdata/rapid",
    saved: /\.fail$/,
  },
];

/** NUL-separated paths git lists for these arguments. */
function listed(root: string, args: string[]): string[] {
  return (gitSync(root, ["ls-files", "-z", ...args]) ?? "")
    .split("\0")
    .filter(Boolean);
}

/**
 * saved-failures — a failing case that a property test or a fuzz run saved
 * to disk and git does not track: proptest's `proptest-regressions/`, Go's
 * `testdata/fuzz/<FuzzName>/` and rapid's `testdata/rapid/`. Each tool replays
 * its saved cases before it generates new ones, so a case left out of the
 * commit is replayed on this machine only: CI and everyone else test without
 * it. One the repository ignores is reported with that said. Looks only in
 * those folders beside a tracked Cargo.toml or `_test.go`, and for proptest's
 * `<test>.proptest-regressions` below a tracked Cargo.toml, on every commit.
 */
export const savedFailures = nativeCheck({
  id: "saved-failures",
  layer: "lint",
  allPaths: true,
  // A changed-file run looks when the change can be a fix, or touches a
  // saved case or an ignore rule.
  select: (files) =>
    files.filter(
      (path) =>
        posix.basename(path) === ".gitignore" ||
        path.endsWith(".proptest-regressions") ||
        STORES.some(
          (store) =>
            store.source.test(path) || `/${path}`.includes(`/${store.folder}/`),
        ),
    ),
  plan: (_files, env) => ignorePatterns(env),
  check(root, task) {
    const ignored = ignoring(task.extra as string[]);
    // The folders a tool would save in, beside its markers in the index (a
    // case that is staged is in the commit), where one is on disk.
    const folders = new Map<string, Store>();
    // A marker's folder, for the stores that also save beside a source file.
    const besides = new Map<string, Store>();
    for (const marker of new Set(STORES.map((store) => store.marker)))
      for (const path of listed(root, ["--", `:(glob)**/${marker}`])) {
        if (ignored(path)) continue;
        const dir = posix.dirname(path);
        for (const store of STORES) {
          if (store.marker !== marker) continue;
          if (store.beside !== undefined) besides.set(dir, store);
          const folder = posix.join(dir, store.folder);
          if (!folders.has(folder) && existsSync(posix.join(root, folder)))
            folders.set(folder, store);
        }
      }
    const findings: Finding[] = [];
    const report = (path: string, store: Store, hidden: boolean) =>
      findings.push(
        fileFinding("saved-failures", "lint", root, path, {
          ruleId: hidden ? "ignored" : "untracked",
          severity: "warning",
          message: hidden
            ? `a failing case ${store.tool} saved, and a .gitignore rule hides it (\`git check-ignore -v ${path}\`): take the rule out and commit the file, so every run replays the case`
            : `a failing case ${store.tool} saved, and git does not track it: \`git add\` it with the fix, so every run replays the case`,
        }),
      );
    const untracked = ["--others", "--exclude-standard", "--"];
    if (folders.size > 0) {
      const under = [...folders.keys()].map((folder) => `:(literal)${folder}`);
      const hidden = new Set(
        listed(root, ["--ignored", ...untracked, ...under]),
      );
      for (const path of [
        ...listed(root, [...untracked, ...under]),
        ...hidden,
      ]) {
        const [folder, store] =
          [...folders].find(([name]) => path.startsWith(`${name}/`)) ?? [];
        if (
          folder !== undefined &&
          store !== undefined &&
          !ignored(path) &&
          store.saved.test(path.slice(folder.length + 1))
        )
          report(path, store, hidden.has(path));
      }
    }
    // Beside a source file: listed without the ignored ones, which would
    // mean a walk of `target/`.
    for (const glob of new Set(
      [...besides.values()].map((store) => store.beside),
    ))
      for (const path of listed(root, [...untracked, `:(glob)**/${glob}`])) {
        const store = [...besides].find(
          ([dir]) => dir === "." || path.startsWith(`${dir}/`),
        )?.[1];
        if (store !== undefined && !ignored(path)) report(path, store, false);
      }
    return findings;
  },
});
