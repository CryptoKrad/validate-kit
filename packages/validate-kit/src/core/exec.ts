import { accessSync, constants, existsSync, statSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { execa } from "execa";
import { getKitRoot } from "./paths.js";
import type { RawOutput } from "./types.js";

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  /**
   * Run the tool in its own process group and kill the whole group on
   * timeout, or when this process is interrupted. For commands that fork (a
   * shell running `a && b`): killing only the direct child leaves the rest
   * running with the output pipes open, so the wait never ends.
   */
  ownProcessGroup?: boolean;
  /**
   * Look a bare `bin` up on PATH only, never by walking up to a node_modules
   * or among the kit's own dependencies: the executable a `tools.<id>.bin`
   * names.
   */
  pathOnly?: boolean;
  /**
   * The tool runs in the project's Python environment (it imports the
   * project's code): a `.venv` on the way up is searched before anything
   * else.
   */
  pythonEnv?: boolean;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
}

// Groups still running. One pair of signal listeners serves them all: one
// pair per group passes Node's limit of 10 listeners once more groups run at
// once (concurrency defaults to the CPU count).
const liveGroups = new Set<number>();

// `once`: by the time the signal is re-raised this listener is gone, so the
// default action (terminate) applies.
function onSignal(signal: NodeJS.Signals): void {
  for (const pid of liveGroups) killGroup(pid);
  process.kill(process.pid, signal);
}

/** Arm the timeout and interrupt handling for a group; returns the disarm. */
function watchGroup(
  pid: number,
  timeoutMs: number,
  onTimeout: () => void,
): () => void {
  const timer = setTimeout(() => {
    onTimeout();
    killGroup(pid);
  }, timeoutMs);
  // Armed whenever it is not attached: a host that survives a signal (its
  // own listener kept it alive) has used up the `once`.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (!process.listeners(signal).includes(onSignal))
      process.once(signal, onSignal);
  }
  liveGroups.add(pid);
  return () => {
    clearTimeout(timer);
    liveGroups.delete(pid);
    if (liveGroups.size === 0) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };
}

/**
 * Programs no npm package provides, which the engine itself relies on: git
 * decides the scope and reads the trusted config, sh runs the formal tools
 * and gates. A project must not be able to put its own in their place (a
 * dependency with a `bin` named git), so they never come from a
 * node_modules/.bin, nor from PATH entries inside one (`pnpm run` puts the
 * project's first) or relative ones.
 */
const SYSTEM_BINS = new Set(["git", "sh"]);

const WINDOWS = process.platform === "win32";

/**
 * One variable of `env`. Windows ignores the case of names, and with two
 * spellings (Path, PATH) Node passes the first in sorted order.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!WINDOWS) return env[name];
  const key = Object.keys(env)
    .toSorted()
    .find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * What a PATH search would run: a regular file, executable on POSIX; on
 * Windows the extension decides (X_OK means nothing there), and an App
 * Execution Alias (WindowsApps) runs although stat says EACCES.
 */
function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (WINDOWS) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    return WINDOWS && (error as NodeJS.ErrnoException).code === "EACCES";
  }
}

// What execa starts on Windows: .exe and .com directly, .cmd and .bat
// through cmd.exe. A PowerShell-only shim (.ps1) would go to cmd.exe too,
// which cannot run it.
const WINDOWS_RUNNABLE = new Set([".COM", ".EXE", ".BAT", ".CMD"]);

/**
 * The files a search for `path` tries: on Windows `path` as written when it
 * has an extension (execa tries it whatever PATHEXT says, and runs a script
 * through its shebang's interpreter), except a PowerShell-only .ps1; then
 * `path` plus each runnable PATHEXT extension (`git` is `git.exe`);
 * elsewhere `path` itself. docs/research/windows/system-bin-lookup.md
 */
function executableVariants(path: string, env: NodeJS.ProcessEnv): string[] {
  if (!WINDOWS) return [path];
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(delimiter)
    .filter((ext) => WINDOWS_RUNNABLE.has(ext.toUpperCase()));
  const own = extname(path).toUpperCase();
  return [
    ...(own && own !== ".PS1" ? [path] : []),
    ...exts.map((ext) => path + ext),
  ];
}

/** Not installed: run() reports it as such (exit 3), with nothing spawned. */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

/** Inside a node_modules folder, however the path is spelled. */
function inNodeModules(dir: string): boolean {
  return dir
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .includes("node_modules");
}

/** The first absolute PATH directory holding `bin`, as its full path. */
function onPath(
  bin: string,
  skipNodeModules: boolean,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const entry of (envValue(env, "PATH") ?? "").split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(dir)) continue;
    if (skipNodeModules && inNodeModules(dir)) continue;
    const found = executableVariants(join(dir, bin), env).find(isRunnableFile);
    if (found) return found;
  }
  return undefined;
}

/**
 * `bin` from PATH's absolute folders (outside any node_modules unless asked
 * otherwise), by its full path. Never the bare name: on Windows that runs a project's own git.exe or
 * git.cmd first (execa searches the current folder before PATH), and one that
 * resolves nowhere goes to cmd.exe, which exits 1 instead of ENOENT.
 */
function fromPath(
  bin: string,
  env: NodeJS.ProcessEnv,
  why = "",
  skipNodeModules = true,
): string {
  const found = onPath(bin, skipNodeModules, env);
  if (found) return found;
  throw notFound(`${bin} is not on PATH${why}`);
}

function systemBin(bin: string, env: NodeJS.ProcessEnv): string {
  // POSIX puts sh here.
  if (bin === "sh" && existsSync("/bin/sh")) return "/bin/sh";
  return fromPath(
    bin,
    env,
    ` (the kit runs the system ${bin}, never a project's)`,
  );
}

/** A file that exists, as Windows would run it; elsewhere the file itself. */
function existing(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!WINDOWS) return existsSync(path) ? path : undefined;
  return executableVariants(path, env).find(isRunnableFile);
}

/**
 * Resolve a project-local binary to its absolute node_modules/.bin path so we can
 * spawn it directly — never by mutating PATH. This keeps us working even when the
 * project directory contains characters illegal in PATH (e.g. a colon), which is
 * exactly the case pnpm's PATH injection chokes on. Global tools (cargo, go,
 * ast-grep, ruff, …) aren't in node_modules and fall through to the system PATH.
 * `env` is the one the tool will run with (its PATH and PATHEXT decide).
 */
export function resolveBin(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  pathOnly = false,
  pythonEnv = false,
): string {
  const pathLike =
    bin.includes("/") || (WINDOWS && bin.includes("\\")) || isAbsolute(bin);
  if (pathLike) {
    if (!WINDOWS) return bin;
    // A relative path is the tool's, from the folder it runs in.
    const found = existing(resolve(cwd, bin), env);
    if (found) return found;
    throw notFound(`${bin} does not exist`);
  }
  if (SYSTEM_BINS.has(bin)) return systemBin(bin, env);
  // A configured name: PATH as the run has it, a node_modules/.bin that
  // `pnpm run` put there included, never the kit's own copy.
  if (pathOnly) return fromPath(bin, env, "", false);
  // 1) walk up from the run dir — finds project-local tools (the app's own tsc, …)
  let dir = cwd;
  for (let i = 0; i < 16; i++) {
    const found =
      (pythonEnv
        ? existing(join(dir, ".venv", WINDOWS ? "Scripts" : "bin", bin), env)
        : undefined) ?? existing(join(dir, "node_modules", ".bin", bin), env);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) fall back to bins shipped with the kit (oxlint/prettier/@ast-grep/cli are
  //    validate-kit dependencies), so they work even when `check` runs against a
  //    project that doesn't depend on them. Cover both npm and pnpm layouts:
  //    - npm:  the kit's deps' bins are hoisted near the kit's node_modules
  //    - pnpm: they live in the sibling .bin of the kit's virtual-store dir
  try {
    const kitRoot = getKitRoot();
    const candidates = [
      join(kitRoot, "node_modules", ".bin", bin), // kit's own nested .bin
      join(dirname(kitRoot), ".bin", bin), // pnpm virtual-store sibling .bin
    ];
    // also walk up from the kit root (catches hoisted consumer .bin)
    let kdir = kitRoot;
    for (let i = 0; i < 8; i++) {
      candidates.push(join(kdir, "node_modules", ".bin", bin));
      const parent = dirname(kdir);
      if (parent === kdir) break;
      kdir = parent;
    }
    for (const candidate of candidates) {
      const found = existing(candidate, env);
      if (found) return found;
    }
  } catch {
    /* getKitRoot best-effort */
  }
  // 3) otherwise the system PATH (cargo, go, ruff, golangci, semgrep, …). On
  //    Windows the kit searches it itself: execa would try the project folder
  //    first, and send a name found nowhere to cmd.exe (exit 1, not ENOENT).
  if (!WINDOWS) return bin;
  const found = onPath(bin, false, env);
  if (found) return found;
  throw notFound(`${bin} is not on PATH`);
}

/**
 * The variables that tie a process to one repository: what `git rev-parse
 * --local-env-vars` lists, less the config ones git itself passes on to
 * another repository (sanitize_repo_env in git's run-command.c). A git hook
 * exports some of them (GIT_DIR in a worktree, GIT_INDEX_FILE in every
 * pre-commit), and a tool run from the hook inherits them: a `git init` it
 * runs elsewhere (lake does) set core.bare=true in the config all the
 * worktrees share, and a `git clone` or `git add` elsewhere writes into the
 * index being committed. Only git itself, run by the kit on the hook's
 * repository, keeps them; a tool that reads that repository's staged files
 * is handed the index (`hookIndex`).
 */
const REPOSITORY_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

function tied(name: string): boolean {
  return REPOSITORY_ENV.has(name.toUpperCase());
}

function withoutRepository(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!Object.keys(env).some(tied)) return env;
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !tied(name)),
  );
}

/**
 * The index a git hook's commit is made from (a pathspec commit's is a
 * temporary one), for a tool's `env` when it reads the project's staged
 * files: run() hands it to no tool by itself.
 */
export function hookIndex(): Record<string, string> {
  const index = process.env.GIT_INDEX_FILE;
  return index ? { GIT_INDEX_FILE: index } : {};
}

/**
 * Spawn a tool and capture stdout/stderr/exit code without throwing on a
 * non-zero exit (linters legitimately exit non-zero). A genuine spawn failure
 * (binary not found, ENOENT) is reported via `spawnError: true`.
 */
export async function run(
  bin: string,
  args: string[],
  opts: RunOptions,
): Promise<RawOutput> {
  try {
    // PWD names the folder the tool runs in. Go's os.Getwd (golangci-lint,
    // the Go-native tsc) trusts PWD when it is the same folder, so the
    // caller's PWD (a symlink to the project) made a tool print paths
    // relative to another spelling of its folder than the kit resolved
    // them against: findings at paths that do not exist. Windows has no PWD
    // (Go ignores it there), and its process.env matches names in any case,
    // which a copy does not: it is passed on as it is.
    const own = /^git(\.exe)?$/i.test(basename(bin))
      ? process.env
      : withoutRepository(process.env);
    const env = WINDOWS
      ? opts.env
        ? { ...own, ...opts.env }
        : own
      : { ...own, ...opts.env, PWD: resolve(opts.cwd) };
    const resolved = resolveBin(
      bin,
      opts.cwd,
      env,
      opts.pathOnly,
      opts.pythonEnv,
    );
    const timeoutMs = opts.timeoutMs ?? 180_000;
    // Negative-pid group kills are POSIX; elsewhere fall back to execa's own
    // timeout on the direct child.
    const group = opts.ownProcessGroup === true && process.platform !== "win32";
    const subprocess = execa(resolved, args, {
      cwd: opts.cwd,
      // The whole environment, so execa adds back nothing it leaves out.
      env,
      extendEnv: false,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(group ? { detached: true } : { timeout: timeoutMs }),
      reject: false,
      all: false,
      stripFinalNewline: false,
      windowsHide: true,
    });
    // Set by the group watcher, which TypeScript's narrowing does not follow.
    let groupTimedOut = false as boolean;
    const disarm =
      group && subprocess.pid !== undefined
        ? watchGroup(subprocess.pid, timeoutMs, () => {
            groupTimedOut = true;
          })
        : undefined;
    let result;
    try {
      result = await subprocess;
    } finally {
      disarm?.();
    }

    // With reject:false, execa resolves (does not throw) even on a spawn failure.
    // A missing/inaccessible binary surfaces as an undefined exitCode + an error code.
    const code = (result as { code?: string }).code;
    const timedOut =
      groupTimedOut || (result as { timedOut?: boolean }).timedOut === true;
    const exitNum =
      typeof result.exitCode === "number" ? result.exitCode : undefined;
    // A spawn failure leaves the streams unset, whatever execa's types say.
    const { stdout, stderr } = result as { stdout?: string; stderr?: string };
    // spawnError means exactly "binary not installed/executable" (ENOENT/
    // EACCES). Any OTHER spawn failure with an undefined exitCode — E2BIG
    // (oversized argv), EMFILE, killed-by-signal, timeout — is a failure of a
    // tool that EXISTS; reporting those as spawnError would mark an optional
    // tool "not installed" and silently skip it → false CLEAN. They fall
    // through with exitCode 127 and crash loud in the runner instead.
    const spawnError = !timedOut && (code === "ENOENT" || code === "EACCES");

    // Output past execa's capture limit is cut mid-line: parsing it would
    // fail as "invalid JSON", or, worse, read a partial result as complete.
    if ((result as { isMaxBuffer?: boolean }).isMaxBuffer === true) {
      return {
        stdout: "",
        stderr: `${bin} wrote more output than the kit captures (execa's maxBuffer): minified or generated files in scope? Add them to \`ignore\`.\n${stderr ?? ""}`,
        exitCode: 127,
        spawnError: false,
        timedOut,
      };
    }

    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: exitNum ?? 127,
      spawnError,
      timedOut,
    };
  } catch (error) {
    const err = error as Partial<NodeJS.ErrnoException>;
    const spawnError = err.code === "ENOENT" || err.code === "EACCES";
    return {
      stdout: "",
      // A thrown non-Error has no message.
      stderr: err.message ?? String(error),
      exitCode: 127,
      spawnError,
    };
  }
}

/** Quick version probe. Returns undefined if the binary cannot be spawned. */
export async function probeVersion(
  bin: string,
  args: readonly string[] = ["--version"],
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const raw = await run(bin, [...args], { cwd, timeoutMs: 15_000 });
  if (raw.spawnError) return undefined;
  return `${raw.stdout}\n${raw.stderr}`.trim();
}

const SEMVER = /(\d+\.\d+\.\d+)/;

/** Default semver extractor — first x.y.z in the output. */
export function firstSemver(text: string): string | undefined {
  return SEMVER.exec(text)?.[1];
}
