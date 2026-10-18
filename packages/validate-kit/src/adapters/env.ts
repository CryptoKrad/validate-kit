import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import type { Finding } from "../core/types.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import { fileFinding, gitSync, ignoredBy, nativeCheck } from "./native.js";

/** The file a project lists its environment variables in: `.env.example`, `.env.local.example`. */
const EXAMPLE = /(?:^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)$/;

/** A name, then not an assignment: `process.env.X = "y"` sets it. */
const NAME = String.raw`([A-Z_][A-Z0-9_]*)`;
const READ = String.raw`(?!\s*=(?!=))`;

/** A variable read in code, per language: its name is the first group. */
const READS: Partial<Record<string, RegExp[]>> = {
  ts: [
    new RegExp(String.raw`\bprocess\.env\??\.${NAME}\b${READ}`, "g"),
    new RegExp(
      String.raw`\bprocess\.env\??\.?\[\s*["'\x60]${NAME}["'\x60]\s*\]${READ}`,
      "g",
    ),
    new RegExp(String.raw`\bimport\.meta\.env\.${NAME}\b${READ}`, "g"),
    new RegExp(
      String.raw`\b(?:Deno\.env\.get|Bun\.env\.get)\(\s*["'\x60]${NAME}["'\x60]`,
      "g",
    ),
  ],
  python: [
    new RegExp(
      String.raw`\b(?:os\.)?environ\[\s*["']${NAME}["']\s*\]${READ}`,
      "g",
    ),
    new RegExp(
      String.raw`\b(?:os\.environ\.get|os\.getenv|environ\.get|getenv)\(\s*["']${NAME}["']`,
      "g",
    ),
  ],
  go: [new RegExp(String.raw`\bos\.(?:Getenv|LookupEnv)\(\s*"${NAME}"`, "g")],
  rust: [
    new RegExp(String.raw`\benv::var(?:_os)?\(\s*"${NAME}"`, "g"),
    new RegExp(String.raw`\b(?:option_)?env!\(\s*"${NAME}"`, "g"),
  ],
};
READS.js = READS.ts;

/** `const { A, B: b } = process.env`: the names read. */
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*process\.env\b/g;

/**
 * Set by the platform, the shell, CI or a toolchain, never by the project's
 * own `.env`: reading one needs no entry. Go's and Python's own variables
 * have no underscore after the prefix (GOPATH, PYTHONPATH).
 */
const PLATFORM =
  /^(?:CI|HOME|PATH|PWD|USER|USERNAME|SHELL|TERM|LANG|LC_\w+|TZ|TMPDIR|TEMP|TMP|HOSTNAME|NODE_ENV|NODE_OPTIONS|DEBUG|NO_COLOR|FORCE_COLOR|EDITOR|XDG_\w+|GITHUB_\w+|RUNNER_\w+|VERCEL\w*|NETLIFY\w*|NEXT_RUNTIME|NEXT_PHASE|npm_\w+|PYTHON[A-Z0-9]*|VIRTUAL_ENV|GO[A-Z0-9]*|CARGO\w*|RUST_\w+)$/;

/** Test code reads the variables its own runs set. */
const TEST =
  /(?:^|\/)(?:tests?|__tests__|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|(?:^|\/)conftest\.py$/;

interface Example {
  path: string;
  /** Each declared key and its line; a commented-out `# KEY=` declares it too. */
  keys: [string, number][];
}

interface EnvPlan {
  examples: Example[];
  /** Every tracked text file, to tell whether a listed key is named anywhere. */
  everywhere: string[];
  /** Every source file in scope, for a change to an example file. */
  sources: string[];
}

function declared(text: string): [string, number][] {
  const keys: [string, number][] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match =
      /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.push([match[1], index + 1]);
  });
  return keys;
}

/** The example file whose folder holds `path` most closely. */
function governing(path: string, examples: Example[]): Example | undefined {
  return examples
    .filter((example) => {
      const dir = posix.dirname(example.path);
      return dir === "." || path.startsWith(`${dir}/`);
    })
    .toSorted((a, b) => b.path.length - a.path.length)[0];
}

function read(file: string): string | undefined {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return undefined;
    const text = readFileSync(file, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * env — environment variables a project reads and the `.env.example` (or
 * `.env.sample`, `.env.template`, `.env.dist`, `.env.local.example`) it
 * documents them in, where it has one: a variable read in code that the
 * nearest example file above it does not list (`env/undeclared`, a warning
 * at the read), and a listed one that no other tracked file names
 * (`env/unused`, info: an SDK may read it by itself). Platform and CI
 * variables, writes, and reads in test code are left out.
 */
export const env = nativeCheck({
  id: "env",
  layer: "lint",
  // Nothing to compare with where there is no example file; a changed-file
  // run that touched only the example (a dotfile, out of scope) checks it.
  select(files, planEnv) {
    const ignored = ignoredBy(planEnv);
    const examples = (
      gitSync(planEnv.projectRoot, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]) ?? ""
    )
      .split("\0")
      .filter((path) => EXAMPLE.test(path) && !ignored(path));
    if (examples.length === 0) return [];
    const changed = planEnv.changedPaths
      ? new Set(planEnv.changedPaths.map(toPosix))
      : undefined;
    return [
      ...files,
      ...examples.filter((path) => !changed || changed.has(path)),
    ];
  },
  plan(_files, planEnv): EnvPlan {
    const root = toPosix(planEnv.projectRoot);
    const ignored = ignoredBy(planEnv);
    const tracked = (
      gitSync(root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]) ?? ""
    )
      .split("\0")
      .filter(Boolean);
    const examples = tracked
      .filter((path) => EXAMPLE.test(path) && !ignored(path))
      .map((path) => ({
        path,
        keys: declared(read(posix.join(root, path)) ?? ""),
      }));
    return {
      examples,
      everywhere: tracked.filter((path) => !EXAMPLE.test(path)),
      sources: planEnv.scopedFiles
        .map((file) => posix.relative(root, file))
        .filter((path) => READS[languageForFile(path) ?? ""] !== undefined),
    };
  },
  check(root, task) {
    const { examples, everywhere, sources } = task.extra as EnvPlan;
    if (examples.length === 0) return [];
    const findings: Finding[] = [];
    const at = (
      path: string,
      line: number,
      col: number,
      ruleId: string,
      severity: "warning" | "info",
      message: string,
    ) =>
      findings.push(
        fileFinding("env", "lint", root, path, {
          ruleId,
          severity,
          message,
          line,
          col,
        }),
      );
    // An example in the change re-checks every file it governs: removing a
    // key breaks the files that read it, which this change did not touch.
    const changedExamples = examples.filter((example) =>
      task.files.includes(example.path),
    );
    const readers = new Set(task.files);
    if (task.changed)
      for (const example of changedExamples)
        for (const path of sources)
          if (governing(path, examples) === example) readers.add(path);
    for (const path of readers) {
      const patterns = READS[languageForFile(path) ?? ""];
      if (!patterns || TEST.test(path)) continue;
      const example = governing(path, examples);
      if (!example) continue;
      const keys = new Set(example.keys.map(([key]) => key));
      const text = read(posix.join(root, path));
      if (text === undefined) continue;
      const reported = new Set<string>();
      text.split("\n").forEach((line, index) => {
        const reads: [string, number][] = [];
        for (const pattern of patterns)
          for (const match of line.matchAll(pattern))
            reads.push([match[1] ?? "", match.index]);
        if (patterns === READS.ts)
          for (const match of line.matchAll(DESTRUCTURED))
            for (const part of (match[1] ?? "").split(","))
              if (/^\s*[A-Z_][A-Z0-9_]*\s*(?::|=|$)/.test(part))
                reads.push([part.trim().split(/[:=\s]/)[0] ?? "", match.index]);
        for (const [name, column] of reads) {
          if (
            !name ||
            keys.has(name) ||
            PLATFORM.test(name) ||
            reported.has(name)
          )
            continue;
          reported.add(name);
          at(
            path,
            index + 1,
            column + 1,
            "undeclared",
            "warning",
            `reads ${name}, which ${example.path} does not list: add it there (with an example value), so the next person knows to set it`,
          );
        }
      });
    }
    // A listed key no other file names: in a changed-file run, only for an
    // example that changed. One pass over the tracked files for every key.
    const checked = task.changed ? changedExamples : examples;
    const unread = new Map<string, Example[]>();
    for (const example of checked)
      for (const [key] of example.keys)
        unread.set(key.toLowerCase(), [
          ...(unread.get(key.toLowerCase()) ?? []),
          example,
        ]);
    if (unread.size > 0) {
      const names = [...unread.keys()].map((key) =>
        key.replaceAll(/[^a-z0-9_]/g, ""),
      );
      const any = new RegExp(`\\b(?:${names.join("|")})\\b`, "gi");
      for (const path of everywhere) {
        if (unread.size === 0) break;
        const text = read(posix.join(root, path));
        if (text === undefined) continue;
        for (const match of text.matchAll(any))
          unread.delete(match[0].toLowerCase());
      }
    }
    for (const example of checked)
      for (const [key, line] of example.keys)
        if (unread.has(key.toLowerCase()))
          at(
            example.path,
            line,
            1,
            "unused",
            "info",
            `${key} is listed here, but no other file of the project names it: if nothing reads it (an SDK may), remove it`,
          );
    return findings;
  },
});
