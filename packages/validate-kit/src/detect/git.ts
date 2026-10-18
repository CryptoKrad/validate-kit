import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "../config/schema.js";
import { run } from "../core/exec.js";
import { toPosix } from "./languages.js";

export type ChangedMode = "staged" | "changed" | "since";

/**
 * git's output, run in `root` (the hook's index, when a hook runs the kit),
 * with `input` on stdin; undefined when git fails or is not there. For the
 * checks that read git while they run, which is synchronous.
 */
export function gitSync(
  root: string,
  args: string[],
  input?: string,
): string | undefined {
  return gitBytes(root, args, input)?.toString("utf8");
}

/** gitSync's output as bytes: `cat-file --batch` counts sizes in bytes. */
export function gitBytes(
  root: string,
  args: string[],
  input?: string,
): Buffer | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    return undefined;
  }
}

/**
 * The main branch's commit at its merge base with HEAD: the trusted ref's
 * under --trusted-ref, else origin's default branch (`origin/HEAD`, else
 * `origin/main` or `origin/master`). Undefined when there is none (a
 * shallow CI checkout).
 */
export function mainBase(
  root: string,
  trustedCommit?: string,
): string | undefined {
  const mergeBase = (ref: string) =>
    gitSync(root, ["merge-base", "HEAD", ref])?.trim() || undefined;
  return trustedCommit === undefined
    ? ["origin/HEAD", "origin/main", "origin/master"]
        .map(mergeBase)
        .find(Boolean)
    : mergeBase(trustedCommit);
}

async function git(
  rootDir: string,
  args: string[],
  scopeLabel: string,
): Promise<string[]> {
  const raw = await run("git", args, { cwd: rootDir, timeoutMs: 15_000 });
  if (raw.spawnError || raw.exitCode !== 0) {
    const detail =
      `${raw.stderr}\n${raw.stdout}`.trim() ||
      `git ${args.join(" ")} exited ${raw.exitCode}`;
    throw new ConfigError(`Unable to compute ${scopeLabel}: ${detail}`);
  }
  return raw.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The repository folder of the checkout at `rootDir` (a worktree has its
 * own), or undefined outside a repository: a place for per-checkout data
 * that goes when the checkout does.
 */
export async function gitDirOf(rootDir: string): Promise<string | undefined> {
  const raw = await run("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: rootDir,
    timeoutMs: 15_000,
  });
  return gitRan(raw) ? raw.stdout.trim() || undefined : undefined;
}

/**
 * HEAD and whether the work tree differs from it. Never throws: outside a
 * repository, or before the first commit, there is nothing to report.
 */
export async function gitState(
  rootDir: string,
): Promise<{ revision: string | null; dirty: boolean | null }> {
  const [head, status] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: rootDir, timeoutMs: 15_000 }),
    run("git", ["status", "--porcelain"], { cwd: rootDir, timeoutMs: 15_000 }),
  ]);
  return {
    revision: gitRan(head) ? head.stdout.trim() : null,
    dirty: gitRan(status) ? status.stdout.trim() !== "" : null,
  };
}

/**
 * The commit a user-given ref names, as a full object id. Exit 2 (ConfigError)
 * for a ref git does not know, or a directory outside a repository.
 */
export async function resolveCommit(
  rootDir: string,
  ref: string,
  flag: string,
): Promise<string> {
  // Read by git as an option, not a revision (see changedSet).
  if (ref.startsWith("-")) {
    throw new ConfigError(
      `Invalid ${flag} '${ref}': refs may not start with '-'`,
    );
  }
  const raw = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: rootDir, timeoutMs: 15_000 },
  );
  const commit = raw.stdout.trim();
  if (!gitRan(raw) || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new ConfigError(
      `${flag} '${ref}' is not a commit of the git repository at ${rootDir}${raw.stderr.trim() ? `: ${raw.stderr.trim()}` : ""}`,
    );
  }
  return commit;
}

/**
 * The work tree's root and `rootDir`'s path inside it (`""` at the root, else
 * ending in "/"), as git sees them: the real path, in the case git records,
 * whatever spelling or symlink led to `rootDir`.
 */
export async function workTreeOf(
  rootDir: string,
): Promise<{ top: string; prefix: string }> {
  const raw = await run(
    "git",
    ["rev-parse", "--show-toplevel", "--show-prefix"],
    {
      cwd: rootDir,
      timeoutMs: 15_000,
    },
  );
  const [top, prefix = ""] = raw.stdout.split("\n");
  if (!gitRan(raw) || !top) {
    throw new ConfigError(
      `Unable to find the git work tree of ${rootDir}: ${raw.stderr.trim() || `git exited ${raw.exitCode}`}`,
    );
  }
  return { top, prefix };
}

/**
 * Which of `relPaths` (relative to `rootDir`) the commit has. A failure is
 * an error, never "absent": a partial clone that cannot fetch must not make
 * a later config name win.
 */
export async function pathsAtCommit(
  rootDir: string,
  commit: string,
  relPaths: readonly string[],
): Promise<Set<string>> {
  return new Set(
    await gitTokens(
      rootDir,
      ["ls-tree", "-z", "--name-only", commit, "--", ...relPaths],
      `the files of commit ${commit}`,
    ),
  );
}

/** A file's bytes as committed, by a path relative to `rootDir`. */
export async function fileAtCommit(
  rootDir: string,
  commit: string,
  relPath: string,
): Promise<string> {
  const raw = await run("git", ["cat-file", "blob", `${commit}:./${relPath}`], {
    cwd: rootDir,
    timeoutMs: 15_000,
  });
  if (!gitRan(raw)) {
    throw new ConfigError(
      `Unable to read ${relPath} at ${commit}: ${raw.stderr.trim() || `git exited ${raw.exitCode}`}`,
    );
  }
  return raw.stdout;
}

function gitRan(raw: { spawnError?: boolean; exitCode: number }): boolean {
  return !raw.spawnError && raw.exitCode === 0;
}

async function ensureGitWorkTree(
  rootDir: string,
  scopeLabel: string,
): Promise<void> {
  const out = await git(
    rootDir,
    ["rev-parse", "--is-inside-work-tree"],
    scopeLabel,
  );
  if (out[0] !== "true") {
    throw new ConfigError(
      `Unable to compute ${scopeLabel}: not a git worktree`,
    );
  }
}

/** One path a change touched, relative to the project root. */
interface ChangedPath {
  /** git's status letter: A, M, D, T, U …; untracked files are "A". */
  status: string;
  path: string;
}

/**
 * What a change touched. `files` are the ones to validate: added, copied,
 * modified or renamed, still on disk, absolute POSIX paths. `paths` is every
 * path the change touched under the project root, deletions and both sides
 * of a rename included, relative POSIX paths: what a gate's `covers` is
 * matched against.
 */
export interface ChangedSet {
  files: string[];
  paths: string[];
}

const LINTABLE = new Set(["A", "C", "M", "R"]);

/**
 * `git diff --name-status`, NUL-separated (`-z`, so no path is quoted or
 * escaped), relative to the project root (`--relative`: git otherwise
 * reports paths from the repository top, which resolve to the wrong place
 * when the project is a sub-directory), with renames split into a deletion
 * and an addition (`--no-renames`).
 */
async function diffStatus(
  rootDir: string,
  extra: string[],
  scopeLabel: string,
): Promise<ChangedPath[]> {
  const tokens = await gitTokens(
    rootDir,
    ["diff", "--name-status", "-z", "--no-renames", "--relative", ...extra],
    scopeLabel,
  );
  const out: ChangedPath[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    out.push({
      status: (tokens[i] ?? "").charAt(0),
      path: tokens[i + 1] ?? "",
    });
  }
  return out;
}

/** New files git does not ignore, as additions. */
async function untracked(
  rootDir: string,
  scopeLabel: string,
): Promise<ChangedPath[]> {
  // ls-files already reports paths relative to its working directory.
  const paths = await gitTokens(
    rootDir,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    scopeLabel,
  );
  return paths.map((path) => ({ status: "A", path }));
}

async function gitTokens(
  rootDir: string,
  args: string[],
  scopeLabel: string,
): Promise<string[]> {
  const raw = await run("git", args, { cwd: rootDir, timeoutMs: 15_000 });
  if (raw.spawnError || raw.exitCode !== 0) {
    const detail =
      `${raw.stderr}\n${raw.stdout}`.trim() ||
      `git ${args.join(" ")} exited ${raw.exitCode}`;
    throw new ConfigError(`Unable to compute ${scopeLabel}: ${detail}`);
  }
  return raw.stdout.split("\0").filter((token) => token !== "");
}

function toChangedSet(rootDir: string, changes: ChangedPath[]): ChangedSet {
  const files = new Set<string>();
  const paths = new Set<string>();
  for (const { status, path } of changes) {
    paths.add(toPosix(path));
    const abs = resolve(rootDir, path);
    if (LINTABLE.has(status) && existsSync(abs)) files.add(toPosix(abs));
  }
  return { files: [...files], paths: [...paths] };
}

/**
 * Files whose working copy is not what a commit of the index would hold, and
 * that the index does not touch: unstaged edits and untracked files, minus
 * anything staged. Real, absolute POSIX paths.
 */
export async function unstagedOnly(rootDir: string): Promise<Set<string>> {
  const label = "unstaged files";
  const [unstaged, staged, added] = await Promise.all([
    diffStatus(rootDir, [], label),
    diffStatus(rootDir, ["--cached"], label),
    untracked(rootDir, label),
  ]);
  const inCommit = new Set(toChangedSet(rootDir, staged).files);
  // Real paths: a tool may report the target of a symlinked project root.
  return new Set(
    toChangedSet(rootDir, [...unstaged, ...added])
      .files.filter((file) => !inCommit.has(file))
      .map((file) => toPosix(realpathSync(file))),
  );
}

/**
 * Files in scope for a given changed-file mode, as absolute POSIX paths that
 * still exist (deletions are excluded — you never lint a deleted file).
 * See `changedSet` for every touched path.
 */
export async function changedFiles(
  rootDir: string,
  mode: ChangedMode,
  sinceRef?: string,
): Promise<string[]> {
  return (await changedSet(rootDir, mode, sinceRef)).files;
}

/**
 * What a changed-file mode touched under the project root:
 *   - staged:  index vs HEAD
 *   - changed: working tree vs index ∪ index vs HEAD ∪ untracked new files
 *   - since:   merge-base(<ref>, HEAD) vs the working tree ∪ untracked new files
 */
export async function changedSet(
  rootDir: string,
  mode: ChangedMode,
  sinceRef?: string,
): Promise<ChangedSet> {
  // A ref starting with "-" would be parsed by git as an OPTION (e.g.
  // --upload-pack=...), not a revision — argv-array spawning blocks shell
  // injection, but not option smuggling. Reject at the boundary.
  if (sinceRef?.startsWith("-")) {
    throw new ConfigError(
      `Invalid --since ref '${sinceRef}': refs may not start with '-'`,
    );
  }
  const scopeLabel =
    mode === "since"
      ? `since file scope for ref '${sinceRef ?? "HEAD"}'`
      : `${mode} file scope`;
  await ensureGitWorkTree(rootDir, scopeLabel);

  if (mode === "staged") {
    return toChangedSet(
      rootDir,
      await diffStatus(rootDir, ["--cached"], scopeLabel),
    );
  }

  if (mode === "changed") {
    // `git diff` alone compares worktree vs index: a fully-staged edit
    // (index ≠ HEAD, worktree = index — the normal pre-commit state) shows in
    // NEITHER that diff nor the untracked list. Union in index-vs-HEAD.
    const [unstaged, staged, added] = await Promise.all([
      diffStatus(rootDir, [], scopeLabel),
      diffStatus(rootDir, ["--cached"], scopeLabel),
      untracked(rootDir, scopeLabel),
    ]);
    return toChangedSet(rootDir, [...unstaged, ...staged, ...added]);
  }

  // since
  const ref = sinceRef ?? "HEAD";
  const base = await git(rootDir, ["merge-base", ref, "HEAD"], scopeLabel);
  const mergeBase = base[0] ?? ref;
  // The merge base against the working tree, plus untracked files: what
  // differs from <ref> now, committed or not (DV10). Commits alone reported
  // a dirty tree as all clear.
  const [tracked, added] = await Promise.all([
    diffStatus(rootDir, [mergeBase], scopeLabel),
    untracked(rootDir, scopeLabel),
  ]);
  return toChangedSet(rootDir, [...tracked, ...added]);
}
