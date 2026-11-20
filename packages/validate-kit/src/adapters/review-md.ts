import { lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Finding } from "../core/types.js";
import {
  fileFinding,
  gitFiles,
  gitSync,
  ignorePatterns,
  ignoring,
  nativeCheck,
} from "./native.js";

// Every number and folder name below is from Claude Code's "Customize Code
// Review" (https://code.claude.com/docs/en/code-review-customize, read
// 2026-11-16 and again 2026-11-19;
// docs/research/verification-continuum/anthropic-2026-11-16). Its
// troubleshooting page gives two more causes of a skipped file that are not
// checked: a link "the review can't parse" (the page does not say what makes
// one malformed) and a link to a file the pull request changes (it depends on
// the pull request, and the review often drops those lines only).

/** REVIEW.md and the files it includes, combined; and the subfolder files. */
const TOTAL_BYTES = 150_000;
/** Different files the root REVIEW.md may include, and skill lines. */
const MAX_INCLUDES = 8;
const SKILL_BYTES = 30_000;
/**
 * Markdown links to repository files: across REVIEW.md and its includes, and
 * in each subfolder file (the troubleshooting page: past it the review skips
 * "the root `REVIEW.md`, or the number of subdirectory `REVIEW.md` files").
 */
const MAX_LINKS = 64;

/** A REVIEW.md in or below a folder with one of these names is never applied. */
const SKIPPED_FOLDERS = new Set(
  // tests, examples, generated code, third-party code
  `test tests __tests__ testdata fixtures __fixtures__ golden corpus snapshots
  __snapshots__ example examples sample samples demo demos generated vendor
  third_party third-party thirdparty node_modules bower_components external
  extern deps godeps pods carthage site-packages contrib`.split(/\s+/),
);

const SKILL_PATH = /^\.claude\/skills\/[^/\s]+\/SKILL\.md$/;

/**
 * A target that reads as a file: a lone `@security-team`, or a decorator in a
 * sample, is prose, and Code Review leaves it as plain text.
 */
const fileLike = (target: string) =>
  target.includes("/") || /\.(md|mdx|markdown|txt)$/i.test(target);

/** One `@` line of a REVIEW.md that asks for a file. */
export interface IncludeLine {
  line: number;
  target: string;
  /** Inside a code fence or an unclosed HTML block: never read as an include. */
  fenced: boolean;
}

/**
 * The lines of a REVIEW.md that hold only `@` and a path, and the ones that
 * look like an include but hold a space (they stay plain text).
 */
export function includeLines(text: string): {
  includes: IncludeLine[];
  spaced: number[];
} {
  const includes: IncludeLine[] = [];
  const spaced: number[] = [];
  let fence: string | undefined;
  // What closes the HTML comment or raw-text element that is open, if any.
  let closer: string | undefined;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const mark = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark && (fence === undefined || line.startsWith(fence))) {
      fence = fence === undefined ? mark : undefined;
      return;
    }
    const include = /^@(\S+)$/.exec(line)?.[1];
    if (include !== undefined)
      includes.push({
        line: index + 1,
        target: include,
        fenced: fence !== undefined || closer !== undefined,
      });
    else if (/^@\S+(\s+\S+)+\.md$/i.test(line)) spaced.push(index + 1);
    if (fence !== undefined) return;
    // Markup still open at the end of this line; inline code is not markup.
    let rest = line.replace(/`[^`]*`/g, "").toLowerCase();
    for (;;) {
      if (closer === undefined) {
        const open = /<!--|<(pre|script|style|textarea)\b/.exec(rest);
        if (!open) break;
        closer = open[1] === undefined ? "-->" : `</${open[1]}`;
        rest = rest.slice(open.index + open[0].length);
      } else {
        const end = rest.indexOf(closer);
        if (end < 0) break;
        rest = rest.slice(end + closer.length);
        closer = undefined;
      }
    }
  });
  return { includes, spaced };
}

/** Markdown links that are not to a web or mail address or an anchor. */
export function fileLinks(text: string): number {
  let count = 0;
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)/g))
    if (!/^(https?:|mailto:|#)/i.test(match[1] ?? "")) count++;
  return count;
}

function read(root: string, path: string): string | undefined {
  try {
    return readFileSync(posix.join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

/** A symbolic link at the path or at a folder on the way to it. */
function linked(root: string, path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, depth) => {
    try {
      return lstatSync(
        posix.join(root, ...parts.slice(0, depth + 1)),
      ).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * review-md — a REVIEW.md that Claude Code's Code Review would drop, in whole
 * or in part, without saying so in a way the author sees: an `@` include that
 * names no file beside it, a path into a folder, a ninth file, a skill file
 * over its size, a symbolic link, an `@` line inside a code fence or in an
 * included file (one level only), more than 64 links to repository files
 * (the whole file is then skipped, the root one or a subfolder's), 150,000
 * bytes passed, and a REVIEW.md in or below a folder Code Review never reads
 * one from (`tests`, `fixtures`, `vendor`, ...). Runs where the repository
 * has a REVIEW.md, on every commit, with nothing to install. Whether the
 * branch it is read from is protected is GitHub's to say and is not checked.
 */
export const reviewMd = nativeCheck({
  id: "review-md",
  layer: "lint",
  allPaths: true,
  select: (files) =>
    files.filter(
      (path) =>
        posix.basename(path) === "REVIEW.md" ||
        SKILL_PATH.test(path) ||
        (!path.includes("/") && /\.md$/i.test(path)),
    ),
  // The patterns only: a plan is printed by `check list`, so git's file
  // list is read when the check runs.
  plan: (_files, env) => ignorePatterns(env),
  check(root, task) {
    const ignored = ignoring(task.extra as string[]);
    // Every file git lists: an include of a file the config's `ignore` covers
    // is still one Code Review reads.
    const names = new Set(gitFiles(root, task.staged) ?? []);
    const listed = [...names].filter(
      (path) => posix.basename(path) === "REVIEW.md",
    );
    const reviews = listed.filter((path) => !ignored(path));
    if (reviews.length === 0) return [];
    const findings: Finding[] = [];
    const at = (
      path: string,
      ruleId: string,
      message: string,
      line = 1,
      severity: Finding["severity"] = "error",
    ) =>
      findings.push(
        fileFinding("review-md", "lint", root, path, {
          ruleId,
          severity,
          message,
          line,
        }),
      );
    // Code Review reads from the repository's top: a project below it has
    // only subfolder files.
    const prefix = (gitSync(root, ["rev-parse", "--show-prefix"]) ?? "").trim();

    const skippedFolder = (path: string) =>
      `${prefix}${path}`
        .split("/")
        .slice(0, -1)
        .find((name) => SKIPPED_FOLDERS.has(name.toLowerCase()));
    // The subfolder files a review applies, with their sizes: a change to a
    // file in a folder reads the REVIEW.md of that folder and of each folder
    // above it, and those share the limit.
    // The sum takes every file a review reads, also the ones this check does
    // not report on: a file the config's `ignore` covers, and, for a project
    // below the repository's top, the file of each folder between the two.
    const levels = prefix.split("/").filter(Boolean).length;
    const outer = Array.from(
      { length: Math.max(levels - 1, 0) },
      (_, up) => `${"../".repeat(up + 1)}REVIEW.md`,
    );
    const tracked =
      outer.length === 0
        ? []
        : (gitSync(root, ["ls-files", "-z", "--", ...outer]) ?? "")
            .split("\0")
            .filter(Boolean);
    const applied = new Map<string, number>();
    for (const path of [...listed, ...tracked])
      if (
        !(path === "REVIEW.md" && prefix === "") &&
        skippedFolder(path) === undefined
      )
        applied.set(path, bytes(read(root, path) ?? ""));
    const above = (path: string) => {
      const folder = posix.dirname(path);
      return [...applied.keys()].filter((other) => {
        const parent = posix.dirname(other);
        return (
          other !== path &&
          (parent === "." ||
            other.startsWith("../") ||
            folder.startsWith(`${parent}/`))
        );
      });
    };
    for (const path of reviews) {
      if (path === "REVIEW.md" && prefix === "") continue;
      const skipped = skippedFolder(path);
      const text = read(root, path) ?? "";
      if (skipped !== undefined)
        at(
          path,
          "skipped-folder",
          `Code Review never applies a REVIEW.md in or below a folder named \`${skipped}\`: put these checks in the root REVIEW.md, or in a REVIEW.md of a folder above it`,
        );
      if (bytes(text) > TOTAL_BYTES)
        at(
          path,
          "too-large",
          `${bytes(text)} bytes: the subfolder REVIEW.md files a pull request touches share ${TOTAL_BYTES} bytes, so this one never fits`,
        );
      else if (skipped === undefined) {
        const parents = above(path);
        const sum = [path, ...parents].reduce(
          (all, name) => all + (applied.get(name) ?? 0),
          0,
        );
        if (
          sum > TOTAL_BYTES &&
          parents.every((name) => (applied.get(name) ?? 0) <= TOTAL_BYTES)
        )
          at(
            path,
            "too-large",
            `${sum} bytes with ${parents.map((name) => `\`${name}\``).join(" and ")}: a change in this folder reads them together, and subfolder REVIEW.md files share ${TOTAL_BYTES} bytes`,
          );
      }
      const linkCount = fileLinks(text);
      if (skipped === undefined && linkCount > MAX_LINKS)
        at(
          path,
          "too-many-links",
          `${linkCount} links to repository files: past ${MAX_LINKS} the review skips this REVIEW.md whole. Say in words what a link points to (web, mail and \`#\` links do not count)`,
        );
      for (const include of includeLines(text).includes)
        if (!include.fenced && fileLike(include.target))
          at(
            path,
            "nested-include",
            `\`@${include.target}\` stays plain text here: only the root REVIEW.md includes files`,
            include.line,
          );
    }

    if (prefix !== "" || !reviews.includes("REVIEW.md")) return findings;
    const rootText = read(root, "REVIEW.md") ?? "";
    const { includes, spaced } = includeLines(rootText);
    for (const line of spaced)
      at(
        "REVIEW.md",
        "include-with-space",
        "this line reaches the review as plain text: an include is `@` and a file name with no space in it",
        line,
      );
    let total = bytes(rootText);
    let links = fileLinks(rootText);
    let skillLines = 0;
    const included = new Set<string>();

    /**
     * The first reason Code Review does not apply this include, if any: its
     * rule, what to say, and the file it is reported at when not REVIEW.md.
     */
    const dropped = (
      target: string,
      skill: boolean,
      text: string | undefined,
    ): [ruleId: string, message: string, at?: string] | undefined => {
      if (skill && !SKILL_PATH.test(target))
        return [
          "skill-path",
          `\`@${target}\` is not included: only \`.claude/skills/<folder>/SKILL.md\` is, with the folder directly under \`skills/\`. Copy other guidance into a file beside REVIEW.md`,
        ];
      if (skill && skillLines > MAX_INCLUDES)
        return [
          "too-many-includes",
          `the ${skillLines}th skill line: Code Review reads at most ${MAX_INCLUDES} (a repeated line counts again)`,
        ];
      if (!skill && target.includes("/"))
        return [
          "include-path",
          `\`@${target}\` is not included: a file must sit at the repository root beside REVIEW.md (only a skill's SKILL.md may be a path)`,
        ];
      if (skill && linked(root, target))
        return [
          "skill-symlink",
          `\`@${target}\` is not included: Code Review does not follow a symbolic link, at the file or at a folder on its path`,
        ];
      if (text === undefined)
        return [
          "include-missing",
          skill
            ? `\`@${target}\` names no file, so the skill is not included`
            : `\`@${target}\` matches no file beside REVIEW.md (the name is compared with its case), so the line reaches the review as plain text and the check run does not say so`,
        ];
      const size = bytes(text);
      if (skill && size > SKILL_BYTES)
        return [
          "skill-too-large",
          `${size} bytes: Code Review includes a SKILL.md of at most ${SKILL_BYTES} bytes, frontmatter counted, and skips this one whole`,
          target,
        ];
      if (included.has(target)) return undefined;
      if (included.size === MAX_INCLUDES)
        return [
          "too-many-includes",
          `\`@${target}\` is a ninth file: Code Review includes at most ${MAX_INCLUDES} different files`,
        ];
      if (total + size >= TOTAL_BYTES)
        return [
          "too-large",
          `\`@${target}\` is skipped whole: REVIEW.md and the files it includes hold ${total + size} bytes, and the limit is ${TOTAL_BYTES} combined`,
        ];
      return undefined;
    };

    for (const { target, line, fenced } of includes) {
      const skill = target.startsWith(".claude/");
      if (fenced) {
        // In a fence a plain name is an example; a skill line is skipped and
        // counted by the check run.
        if (skill)
          at(
            "REVIEW.md",
            "include-in-block",
            `\`@${target}\` is inside a code fence or an unclosed HTML block, so the skill is not included: move the line out, or close the block above it`,
            line,
          );
        continue;
      }
      if (!skill && !fileLike(target)) continue;
      if (skill) skillLines++;
      const text = names.has(target) ? read(root, target) : undefined;
      const problem = dropped(target, skill, text);
      if (problem !== undefined) {
        const [ruleId, message, file] = problem;
        at(file ?? "REVIEW.md", ruleId, message, file === undefined ? line : 1);
      }
      if (problem !== undefined || text === undefined) continue;
      if (!included.has(target)) {
        included.add(target);
        total += bytes(text);
        if (!skill) links += fileLinks(text);
      }
      if (!skill) {
        for (const nested of includeLines(text).includes)
          if (!nested.fenced && fileLike(nested.target))
            at(
              target,
              "nested-include",
              `\`@${nested.target}\` stays plain text here: list every file in the root REVIEW.md (includes go one level)`,
              nested.line,
            );
        continue;
      }
      // What a review does not get from a skill: commands, arguments and
      // the files it links to.
      text.split(/\r?\n/).forEach((raw, index) => {
        if (/(^|\s)!`/.test(raw))
          at(
            target,
            "skill-command",
            "Code Review does not run a `!` command: it replaces the whole line or block with a placeholder. Write out what the command would supply, or include a copy beside REVIEW.md",
            index + 1,
            "warning",
          );
        else if (/\$ARGUMENTS\b|\$\{CLAUDE_SKILL_DIR\}/.test(raw))
          at(
            target,
            "skill-substitution",
            "a review passes no arguments and leaves this substitution as written: use fixed text, or include a copy beside REVIEW.md",
            index + 1,
            "warning",
          );
        else if (fileLinks(raw) > 0)
          at(
            target,
            "skill-link",
            "Code Review does not load a file a skill links to: the review sees the path as plain text or a placeholder. Say in words what the file holds, or copy what a review needs into SKILL.md",
            index + 1,
            "warning",
          );
      });
    }
    if (bytes(rootText) >= TOTAL_BYTES)
      at(
        "REVIEW.md",
        "too-large",
        `${bytes(rootText)} bytes: REVIEW.md and the files it includes must stay under ${TOTAL_BYTES} combined`,
      );
    if (links > MAX_LINKS)
      at(
        "REVIEW.md",
        "too-many-links",
        `${links} links to repository files across REVIEW.md and the files it includes: past ${MAX_LINKS} the review skips the whole root REVIEW.md. Say in words what a link points to (web, mail and \`#\` links do not count)`,
      );
    return findings;
  },
});
