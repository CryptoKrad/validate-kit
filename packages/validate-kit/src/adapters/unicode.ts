import { lstatSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Finding } from "../core/types.js";
import { isCode } from "../detect/languages.js";
import { finding } from "./base.js";
import { nativeCheck } from "./native.js";

/**
 * The characters that reorder how a line displays, so code can run otherwise
 * than it reads (Trojan Source, CVE-2021-42574; rustc's
 * text_direction_codepoint_in_literal lists the same nine).
 */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Characters that show nothing, in code: a zero-width space or word joiner
 * splits a name in two that looks like one, a soft hyphen hides inside one.
 * The joiners U+200C and U+200D are left out: emoji and several scripts need
 * them. A byte-order mark is one only at the start of the file.
 */
const INVISIBLE = /[\u200B\u2060\u00AD\uFEFF]/g;

/**
 * A homoglyph: a word part (split at `_`, digits and a lower-to-upper case
 * change) of Latin letters with a Cyrillic one that looks Latin among them,
 * as `paypal` spelled with a Cyrillic `\u0440` and `\u0430`. A name of
 * Cyrillic and Latin parts (`\u0444\u0443\u043D\u043A\u0446\u0438\u044F_unicode`) is not
 * one.
 */
const WORD = /[\p{L}\p{M}\p{N}_$]+/gu;
const PART = /[_$\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LOOKS_LATIN =
  /^[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u04BB\u04AF\u0501\u051B\u051D\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425\u0406\u0408\u0405]$/u;

function homoglyph(word: string): boolean {
  return word.split(PART).some((part) => {
    const cyrillic = part.match(CYRILLIC);
    return (
      cyrillic !== null &&
      LATIN.test(part) &&
      cyrillic.every((char) => LOOKS_LATIN.test(char))
    );
  });
}

const NAMES: Record<string, string> = {
  "\u202A": "LEFT-TO-RIGHT EMBEDDING",
  "\u202B": "RIGHT-TO-LEFT EMBEDDING",
  "\u202C": "POP DIRECTIONAL FORMATTING",
  "\u202D": "LEFT-TO-RIGHT OVERRIDE",
  "\u202E": "RIGHT-TO-LEFT OVERRIDE",
  "\u2066": "LEFT-TO-RIGHT ISOLATE",
  "\u2067": "RIGHT-TO-LEFT ISOLATE",
  "\u2068": "FIRST STRONG ISOLATE",
  "\u2069": "POP DIRECTIONAL ISOLATE",
  "\u200B": "ZERO WIDTH SPACE",
  "\u2060": "WORD JOINER",
  "\u00AD": "SOFT HYPHEN",
  "\uFEFF": "ZERO WIDTH NO-BREAK SPACE",
};

function codepoint(char: string): string {
  const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
  return `U+${hex.padStart(4, "0")} (${NAMES[char] ?? "?"})`;
}

/** The distinct characters matched, named. */
function named(matches: RegExpMatchArray[]): string {
  return [...new Set(matches.map((m) => codepoint(m[0])))].join(", ");
}

/** One form for one distinct character, another for several. */
function verb(matches: RegExpMatchArray[], one: string, many: string): string {
  return new Set(matches.map((m) => m[0])).size > 1 ? many : one;
}

/** Prose and data files, where these characters are text, not code. */
const PROSE =
  /\.(?:md|markdown|mdx|txt|text|rst|adoc|csv|tsv|json|jsonl|ndjson|geojson|po|pot|xliff|xlf|srt|vtt|log)$/i;

/** Larger text files are data, not code someone reads. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * unicode — characters that make code read otherwise than it runs: the
 * bidirectional controls of Trojan Source (an error), and in source files,
 * characters that show nothing and Cyrillic letters that look Latin inside a
 * Latin word (warnings). Each is reported where it is, once per line. Reads
 * git's whole file list (CI workflows in dotfolders too); prose and data
 * (Markdown, text, CSV, JSON, translations) are left alone.
 */
export const unicode = nativeCheck({
  id: "unicode",
  layer: "security",
  allPaths: true,
  check(root, task) {
    const findings: Finding[] = [];
    const at = (
      file: string,
      line: number,
      col: number,
      ruleId: string,
      severity: "error" | "warning",
      message: string,
    ) =>
      findings.push(
        finding({
          tool: "unicode",
          layer: "security",
          file,
          line,
          col,
          ruleId,
          severity,
          message,
          fixable: false,
        }),
      );
    for (const path of task.files) {
      // Not prose or data: scraped CSV, JSON and Markdown hold these
      // characters in text no one runs.
      if (PROSE.test(path)) continue;
      const file = posix.join(root, path);
      let bytes: Buffer;
      try {
        // A symlink is stored as its target's name, not its content.
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        bytes = readFileSync(file);
      } catch {
        continue;
      }
      // Binary: a NUL byte near the start.
      if (bytes.subarray(0, 8192).includes(0)) continue;
      const source = isCode(file);
      bytes
        .toString("utf8")
        .split("\n")
        .forEach((text, index) => {
          const line = index + 1;
          const bidi = [...text.matchAll(BIDI)];
          if (bidi[0])
            at(
              file,
              line,
              bidi[0].index + 1,
              "bidi",
              "error",
              `${named(bidi)} ${verb(bidi, "reorders", "reorder")} how this line displays, so it can run otherwise than it reads (Trojan Source): remove ${verb(bidi, "it", "them")}, or write ${verb(bidi, "it", "them")} as an escape`,
            );
          if (!source) return;
          const hidden = [...text.matchAll(INVISIBLE)].filter(
            (m) => !(index === 0 && m.index === 0),
          );
          if (hidden[0])
            at(
              file,
              line,
              hidden[0].index + 1,
              "invisible",
              "warning",
              `${named(hidden)} ${verb(hidden, "shows", "show")} nothing, so two names that look alike can differ: remove ${verb(hidden, "it", "them")}, or write ${verb(hidden, "it", "them")} as an escape`,
            );
          const mixed = [...text.matchAll(WORD)].find((m) => homoglyph(m[0]));
          if (mixed)
            at(
              file,
              line,
              mixed.index + 1,
              "mixed-script",
              "warning",
              `\`${mixed[0]}\` mixes Latin and Cyrillic letters: one that looks Latin makes it a different name`,
            );
        });
    }
    return findings;
  },
});
