import { lstatSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import type { Finding } from "../core/types.js";
import { toolOptions } from "./base.js";
import { gitBytes } from "../detect/git.js";
import {
  fileFinding,
  gitSync,
  headOf,
  indexEntries,
  nativeCheck,
} from "./native.js";

const Options = z
  .object({
    /** A file larger than this (bytes) and not in LFS is a warning. */
    maxBytes: z.number().int().min(0).optional(),
  })
  .strict();

/** GitHub warns on a push at 50 MB and refuses one at 100 MB. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** The first bytes of a git-lfs pointer file (git-lfs docs/spec.md). */
const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";

/** A pointer is under 200 bytes; a stored file this small is read whole. */
const POINTER_MAX = 1024;

/** Lockfiles: large by nature, and no package manager reads one from LFS. */
const LOCKFILE =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|Gemfile\.lock|composer\.lock|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json|flake\.lock)$/;

/** What compiled output a file's first bytes say it is, if any. */
function compiled(path: string, head: Buffer): string | undefined {
  const u32 = (at: number) =>
    head.length >= at + 4 ? head.readUInt32BE(at) : -1;
  const magic = u32(0);
  if (magic === 0x7f454c46) return "an ELF binary";
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
    return "a Mach-O binary";
  // Both a universal Mach-O and a Java class start CAFEBABE; a class file's
  // next four bytes hold its major version, 45 or more.
  if (magic === 0xcafebabe)
    return path.endsWith(".class") || u32(4) >= 45
      ? "a Java class file"
      : "a universal Mach-O binary";
  if (head.subarray(0, 2).toString("latin1") === "MZ" && head.length >= 64) {
    const pe = head.readUInt32LE(0x3c);
    if (head.subarray(pe, pe + 4).toString("latin1") === "PE\0\0")
      return "a Windows executable";
  }
  if (head.subarray(0, 8).toString("latin1") === "!<arch>\n")
    return "an ar archive (a static library)";
  if (magic === 0x0061736d) return "a WebAssembly module";
  if (head.subarray(0, 16).toString("latin1") === "SQLite format 3\0")
    return "a SQLite database";
  if (/\.py[co]$/.test(path)) return "Python bytecode";
  return undefined;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** Of `files`, those `.gitattributes` stores in LFS (names on stdin). */
function inLfs(root: string, files: string[]): Set<string> {
  const out = gitSync(
    root,
    ["check-attr", "-z", "--stdin", "filter"],
    files.join("\0"),
  );
  const lfs = new Set<string>();
  if (!out) return lfs;
  const fields = out.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3)
    if (fields[i + 2] === "lfs") lfs.add(fields[i] ?? "");
  return lfs;
}

/**
 * Of the objects `ids`, those stored as the file itself, not as an LFS
 * pointer: one `git cat-file --batch` for all of them. An empty file is
 * stored empty by git-lfs too.
 */
function storedWhole(root: string, ids: string[]): Map<string, number> {
  const whole = new Map<string, number>();
  const sizes = gitSync(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    `${ids.join("\n")}\n`,
  );
  const small: string[] = [];
  for (const line of (sizes ?? "").split("\n")) {
    const [id, n] = line.split(" ");
    const bytes = Number(n);
    if (!id || !Number.isFinite(bytes) || bytes === 0) continue;
    if (bytes > POINTER_MAX) whole.set(id, bytes);
    else small.push(id);
  }
  if (small.length === 0) return whole;
  // `<id> blob <size>\n<content>\n` per object, sizes in bytes.
  const out =
    gitBytes(root, ["cat-file", "--batch"], `${small.join("\n")}\n`) ??
    Buffer.alloc(0);
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(10, at);
    if (end === -1) break;
    const [id, , n] = out.subarray(at, end).toString("latin1").split(" ");
    const bytes = Number(n);
    if (!id || !Number.isFinite(bytes)) break;
    const content = out.subarray(end + 1, end + 1 + bytes).toString("latin1");
    if (!content.startsWith(LFS_POINTER)) whole.set(id, bytes);
    at = end + 1 + bytes + 1;
  }
  return whole;
}

/**
 * blobs — compiled output and oversized files in git: an agent's `go build`
 * leaves an extensionless binary that .gitignore misses, and `git add .`
 * commits it. A file's first bytes say what it is (ELF, Mach-O, PE, a Java
 * class, an ar archive, WebAssembly, SQLite, Python bytecode). Reads git's
 * whole file list, build folders and dotfolders included. A path
 * `.gitattributes` gives to LFS is not checked for that, but git must store
 * it as an LFS pointer: a file added without `git lfs install` holds the
 * whole file. Lockfiles may be large.
 */
export const blobs = nativeCheck({
  id: "blobs",
  layer: "lint",
  allPaths: true,
  plan: (_files, env) =>
    toolOptions(env, "blobs", Options).maxBytes ?? DEFAULT_MAX_BYTES,
  check(root, task) {
    const maxBytes = task.extra as number;
    const at = (
      path: string,
      ruleId: string,
      message: string,
      severity: "error" | "warning",
    ) =>
      fileFinding("blobs", "lint", root, path, { ruleId, severity, message });
    const lfs = inLfs(root, task.files);
    const findings: Finding[] = [];
    for (const path of task.files) {
      if (lfs.has(path)) continue;
      const file = posix.join(root, path);
      let bytes: number;
      try {
        // A symlink is stored as its target's name, not its content.
        const stat = lstatSync(file);
        if (!stat.isFile()) continue;
        bytes = stat.size;
      } catch {
        continue;
      }
      const kind = compiled(path, headOf(file, 512));
      if (kind)
        findings.push(
          at(
            path,
            "binary",
            `${kind} (${size(bytes)}), built or generated, not source: remove it from git and list it in .gitignore`,
            "error",
          ),
        );
      else if (maxBytes > 0 && bytes > maxBytes && !LOCKFILE.test(path))
        findings.push(
          at(
            path,
            "large",
            `${size(bytes)}, over the ${size(maxBytes)} limit: git keeps every version of it in every clone; store it in LFS, or raise tools.blobs.options.maxBytes`,
            "warning",
          ),
        );
    }
    if (lfs.size === 0) return findings;
    // A path for LFS whose blob is the file itself: added before
    // `git lfs install`, or by a tool that skips the clean filter.
    const index = indexEntries(root);
    const ids = new Map<string, string>();
    for (const path of lfs) {
      const entry = index.get(path);
      if (entry) ids.set(path, entry.id);
    }
    const whole = storedWhole(root, [...new Set(ids.values())]);
    for (const [path, id] of ids) {
      const bytes = whole.get(id);
      if (bytes === undefined) continue;
      findings.push(
        at(
          path,
          "not-in-lfs",
          `.gitattributes stores this path in LFS, but git holds the file itself (${size(bytes)}): run \`git lfs install\`, then \`git add --renormalize ${path}\``,
          "error",
        ),
      );
    }
    return findings;
  },
});
