import { glob } from "tinyglobby";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import picomatch from "picomatch";
import { run } from "../core/exec.js";
import type {
  Detection,
  DetectedLanguage,
  Language,
  ScopeNote,
} from "../core/types.js";
import { LANGUAGE_SPECS, LANGUAGES } from "../core/types.js";

const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/.git/**",
  "**/coverage/**",
  "**/.ruff_cache/**",
];

/**
 * Folders out of scope unless `include` names them: archives, backups, logs
 * and superseded copies, as the code atlas treats them (the operator's
 * decision, 2026-10-04). Matched against each folder name in a path.
 */
export const DEFAULT_SKIPPED_FOLDERS = [
  "archive",
  "backups",
  "logs",
  "_superseded*",
];

/**
 * Oversized and minified source files are out of scope by default (the
 * operator's decision R3, 2026-10-04). Limits and rules from
 * docs/research/scope/size-and-generated-files.md: Biome's 1 MiB default;
 * oxlint's minified names; GitHub Linguist's JavaScript average line over 110
 * characters; any line over 10,000 bytes. Files no larger than one such line
 * are not read: they cannot hold one, nor flood a tool's output.
 */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const LONG_LINE_BYTES = 10_000;
const AVERAGE_LINE_CHARS = 110;
const HEAD_BYTES = 128 * 1024;
const MINIFIED_NAME = /[._-]min\./;

export interface ScopeScan {
  files: string[];
  /** What a default left out of scope, and why. */
  skipped: ScopeNote[];
}

export interface ScopeOptions {
  include?: string[];
  ignore?: string[];
  /** 0: no limit. Default DEFAULT_MAX_FILE_BYTES. */
  maxFileBytes?: number;
  /** Default true. */
  skipMinified?: boolean;
}

export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** `path` is `dir` or inside it, however either is spelled. */
export function isUnder(path: string, dir: string): boolean {
  const p = toPosix(path);
  const d = toPosix(dir);
  return p === d || p.startsWith(d.endsWith("/") ? d : `${d}/`);
}

/**
 * The language a file's extension names, matched exactly: the tools decide
 * by the lower-case extension, and oxlint and ast-grep skip `App.TSX`
 * (docs/research/lint-toolchain/extension-case.md).
 */
export function languageForFile(file: string): Language | undefined {
  for (const lang of LANGUAGES) {
    if (LANGUAGE_SPECS[lang].extensions.some((e) => file.endsWith(e)))
      return lang;
  }
  const name = basename(file);
  for (const lang of LANGUAGES)
    if (LANGUAGE_SPECS[lang].names?.test(name)) return lang;
  return byShebang.get(file);
}

/** A file of program code (not configuration, markup or prose). */
export function isCode(file: string): boolean {
  const lang = languageForFile(file);
  return lang !== undefined && LANGUAGE_SPECS[lang].data !== true;
}

/**
 * A `#!` line naming a shell shellcheck reads (directly, or through `env`,
 * with flags after it): `#!/bin/sh -e`, `#!/usr/bin/env -S bash -eu`.
 */
const SHELL_SHEBANG =
  /^#![ \t]*(?:\/usr\/bin\/env[ \t]+(?:-S[ \t]+)?)?(?:\/\S*\/)?(?:sh|bash|dash|ksh|bats)(?:[ \t]|\r?$)/;

/**
 * Extensionless files whose `#!` line names a shell, found when the scope is
 * scanned: a script in bin/ or a hook is shell to every tool that asks
 * languageForFile, as a `.sh` file is.
 */
const byShebang = new Map<string, Language>();

/** The first line of a file, up to 256 bytes; "" when it cannot be read. */
export function firstLine(file: string): string {
  const buffer = Buffer.alloc(256);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const text = buffer.toString("latin1", 0, readSync(fd, buffer, 0, 256, 0));
    return text.split("\n", 1)[0] ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Generated wrappers: Gradle's and Maven's, and autoconf's. Nobody edits
 * them, and older ones hold dozens of shellcheck warnings.
 */
const GENERATED_SCRIPT =
  /^(?:gradlew|mvnw|configure|config\.guess|config\.sub|install-sh|depcomp|missing|compile|mkinstalldirs|libtool|ltmain)$/;

function noteShebangs(files: readonly string[]): void {
  for (const file of files) {
    if (extname(file) !== "" || GENERATED_SCRIPT.test(basename(file))) continue;
    if (SHELL_SHEBANG.test(firstLine(file))) byShebang.set(file, "shell");
    else byShebang.delete(file);
  }
}

/**
 * A file the run must route to some tool: one of a language whose files
 * every repository checks (not an opt-in one, LanguageSpec.optIn).
 */
export function isSourceFile(file: string): boolean {
  const lang = languageForFile(file);
  return lang !== undefined && LANGUAGE_SPECS[lang].optIn !== true;
}

/** A file whose extension names a language only in another case. */
export function miscasedSource(file: string): boolean {
  const ext = extname(file);
  return ext !== ext.toLowerCase() && isSourceFile(ext.toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*[\]{}()!]/.test(pattern);
}

function normalizeScopePattern(rootDir: string, pattern: string): string {
  const p = toPosix(pattern).replace(/^\.\//, "").replace(/\/$/, "");
  if (!p || p === ".") return "**/*";
  if (hasGlobSyntax(p)) return p;
  const abs = resolve(rootDir, p);
  // lstat (not stat): classify the entry itself, never what a symlink targets.
  if (existsSync(abs) && lstatSync(abs).isFile()) return p;
  return `${p}/**/*`;
}

/** All repo files in validation scope, after include/ignore config is applied. */
export async function listScopedFiles(
  rootDir: string,
  scope: ScopeOptions = {},
): Promise<string[]> {
  return (await scanScope(rootDir, scope)).files;
}

/**
 * The files in scope, and those a default left out (DEFAULT_SKIPPED_FOLDERS)
 * so a run can say so. A folder name an `include` pattern names is not
 * skipped: including `archive` brings archive/ back; including `src` does not
 * bring back src/logs/.
 */
export async function scanScope(
  rootDir: string,
  scope: ScopeOptions = {},
): Promise<ScopeScan> {
  const root = toPosix(resolve(rootDir));
  const patterns =
    scope.include && scope.include.length > 0
      ? scope.include.map((pattern) => normalizeScopePattern(rootDir, pattern))
      : ["**/*"];
  const ignore = [...IGNORE_GLOBS, ...(scope.ignore ?? [])].map((p) =>
    toPosix(p).replace(/^\.\//, ""),
  );
  // In a git work tree, only what git would track: tracked files and new
  // ones no ignore rule matches. A virtualenv, vendored code or build output
  // the project ignores is not the project's code.
  const [files, listed] = await Promise.all([
    glob(patterns, {
      cwd: root,
      ignore,
      onlyFiles: true,
      absolute: true,
      dot: false,
      // A folder pattern is not `folder/**` (tinyglobby's default would make
      // it so; fast-glob, which this replaced, did not).
      expandDirectories: false,
      // Never traverse symlinks: a linked dir can point OUTSIDE the scope root
      // (silent scope escape) or back into it (glob cycle).
      followSymbolicLinks: false,
    }),
    gitListed(root),
  ]);
  // Sorted: the glob returns traversal order, which varies between runs, and
  // spawn roots, task order and file-argument order all follow this list.
  const all = unique(files.map(toPosix))
    .filter((file) => !listed || listed(file))
    .toSorted();
  const named = new Set(
    (scope.include ?? []).flatMap((pattern) =>
      toPosix(pattern).replace(/^\.\//, "").split("/"),
    ),
  );
  const skippers = DEFAULT_SKIPPED_FOLDERS.filter(
    (folder) => ![...named].some((name) => picomatch.isMatch(name, folder)),
  ).map((folder) => ({ folder, match: picomatch(folder) }));
  const limit = scope.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const kept: string[] = [];
  const skippedFiles: string[] = [];
  const folders = new Set<string>();
  const oversized: string[] = [];
  const minified: string[] = [];
  const looks: string[] = [];
  // First, so an extensionless shell script is held to the size limit too.
  noteShebangs(all);
  for (const file of all) {
    const dirs = toPosix(relative(root, file)).split("/").slice(0, -1);
    const hit = skippers.find(({ match }) => dirs.some((dir) => match(dir)));
    if (hit) {
      skippedFiles.push(file);
      folders.add(hit.folder);
      continue;
    }
    const made = machineMade(file, limit, scope.skipMinified ?? true);
    if (made === "oversized") oversized.push(file);
    else if (made !== undefined) {
      minified.push(file);
      looks.push(made.why);
    } else kept.push(file);
  }
  const skipped: ScopeNote[] = [];
  if (skippedFiles.length > 0)
    skipped.push({
      reason: "default-ignored",
      folders: [...folders].toSorted(),
      files: skippedFiles,
    });
  if (oversized.length > 0)
    skipped.push({ reason: "oversized", limit, files: oversized });
  if (minified.length > 0)
    skipped.push({ reason: "minified", files: minified, why: looks });
  return { files: kept, skipped };
}

/**
 * Why a source file is out of scope by size or form, if it is; for a
 * minified one, what gave it away (said in the note, so a hand-written file
 * with one long fixture line can be told apart).
 */
function machineMade(
  file: string,
  limit: number,
  skipMinified: boolean,
): "oversized" | { why: string } | undefined {
  // An opt-in language's files (a SQL dump) are no source the run must route.
  if (!isSourceFile(file)) return undefined;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (limit > 0 && size > limit) return "oversized";
  if (!skipMinified) return undefined;
  if (MINIFIED_NAME.test(basename(file))) return { why: "a .min. name" };
  if (size <= LONG_LINE_BYTES) return undefined;
  const lines = head(file).split("\n");
  const long = lines.findIndex(
    (line) => Buffer.byteLength(line) > LONG_LINE_BYTES,
  );
  // Only the first HEAD_BYTES are read: a longer line's length is not known.
  if (long !== -1)
    return { why: `line ${long + 1} is over ${LONG_LINE_BYTES} bytes` };
  if (languageForFile(file) !== "js") return undefined;
  const chars = lines.reduce((sum, line) => sum + line.length, 0);
  const average = chars / lines.length;
  return average > AVERAGE_LINE_CHARS
    ? { why: `lines average ${Math.round(average)} characters` }
    : undefined;
}

/** The first HEAD_BYTES of a file, as text. */
function head(file: string): string {
  const buffer = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(file, "r");
  try {
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether git lists a file under `root` (`git ls-files --cached --others
 * --exclude-standard`); undefined outside a git work tree, or when `root`
 * itself is ignored (a scratch project inside an ignored directory is not
 * the repository's to scope). A tracked file deleted from disk is still
 * listed: callers ask only about files that exist. Names are compared in
 * NFC (git's form on macOS, while the disk may hold NFD), and without case
 * on a file system that ignores it (a case-only rename on disk).
 */
export async function gitListed(
  root: string,
): Promise<((file: string) => boolean) | undefined> {
  const raw = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, timeoutMs: 60_000 },
  );
  // Not a git work tree, or no git: the include/ignore globs decide alone.
  if (raw.spawnError || raw.exitCode !== 0) return undefined;
  const paths = raw.stdout.split("\0").filter((path) => path !== "");
  if (paths.length === 0) {
    const ignored = await run("git", ["check-ignore", "--quiet", "."], {
      cwd: root,
      timeoutMs: 15_000,
    });
    if (ignored.exitCode === 0) return undefined;
  }
  const fold = caseInsensitive(root)
    ? (path: string) => path.normalize("NFC").toLowerCase()
    : (path: string) => path.normalize("NFC");
  const listed = new Set(
    paths.map((path) => fold(toPosix(resolve(root, path)))),
  );
  return (file) => listed.has(fold(file));
}

/** Does the file system under `dir` ignore case? */
export function caseInsensitive(dir: string): boolean {
  const upper = dir.toUpperCase();
  const lower = dir.toLowerCase();
  return upper !== lower && existsSync(upper) && existsSync(lower);
}

/**
 * Detect which languages a tree contains. Extension presence is authoritative
 * (so loose fixtures with no manifest still detect); marker-file directories
 * refine the spawn roots (clippy must run in the Cargo crate dir, etc.).
 */
export async function detectLanguages(
  rootDir: string,
  scope: ScopeOptions = {},
): Promise<Detection> {
  return detectFromFiles(rootDir, await listScopedFiles(rootDir, scope));
}

/** `detectLanguages` over a scoped file list the caller already has. */
export function detectFromFiles(
  rootDir: string,
  scopedFiles: readonly string[],
): Detection {
  const root = toPosix(resolve(rootDir));
  const detection: Detection = new Map();

  for (const lang of LANGUAGES) {
    const extFiles = scopedFiles.filter(
      (file) => languageForFile(file) === lang,
    );
    if (extFiles.length === 0) continue;

    const markerFiles = scopedFiles.filter((file) =>
      LANGUAGE_SPECS[lang].markers.includes(basename(file)),
    );

    const roots =
      markerFiles.length > 0
        ? unique(markerFiles.map((m) => toPosix(dirname(m))))
        : [root];

    const entry: DetectedLanguage = {
      lang,
      roots,
      markerFiles: markerFiles.map(toPosix),
    };
    detection.set(lang, entry);
  }

  return detection;
}
