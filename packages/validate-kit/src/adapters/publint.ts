import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding, lineOf } from "./base.js";
import { PACK_ENV, packTasks } from "./npm-package.js";

/** publint's sections, by the severity its items get. */
const SECTIONS: Record<string, Severity> = {
  "Errors:": "error",
  "Warnings:": "warning",
  "Suggestions:": "info",
};

/** `1. pkg.exports["."].default is ./dist/missing.js but the file does not exist.` */
const ITEM = /^\d+\. (.+)$/;

/**
 * The items of publint's sections, by severity. An item's text that wraps
 * goes on with the lines below it.
 */
function itemsOf(lines: string[]): { severity: Severity; message: string }[] {
  const items: { severity: Severity; message: string }[] = [];
  let severity: Severity | undefined;
  for (const line of lines) {
    const item = ITEM.exec(line)?.[1];
    const last = items.at(-1);
    if (Object.hasOwn(SECTIONS, line)) severity = SECTIONS[line];
    else if (severity && item) items.push({ severity, message: item });
    else if (last && line.trim()) last.message += ` ${line.trim()}`;
    else if (line.trim() && line !== "All good!")
      throw new Error(
        `publint printed ${JSON.stringify(line)} where a section or an item goes: its output format may have changed; refusing to report zero findings.`,
      );
  }
  return items;
}

/**
 * publint — what a package would publish against what its package.json
 * promises: an `exports`, `main` or `types` path the tarball lacks, ESM
 * read as CommonJS, conditions in the wrong order. Its errors are errors,
 * its warnings warnings, its suggestions info. It packs the package to see
 * what would be published, with no script of the package and no network.
 * Where a package it could publish (a name, a version, not private) chose
 * it: publint in its package.json or one above it, or
 * `tools.publint.enabled`; run from that package. Recorded on 0.3.25:
 * docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 2.
 */
export const publint: ToolAdapter = {
  id: "publint",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "publint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.3.25",
  installHint: "pnpm add -D publint",
  parseVersion: (out) => /publint, (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],

  expand: (seed, env) => packTasks(seed, env, "publint", []),

  buildArgs(ctx: ToolContext): BuiltCommand {
    // 1: errors, and a folder with no package.json.
    return {
      bin: this.bin,
      args: ["run", ...ctx.extraArgs, "."],
      env: PACK_ENV,
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const lines = stripVTControlCharacters(raw.stdout).split(/\r?\n/);
    const linted = lines.indexOf("Linting...");
    // Packing failed (npm's first `npm error`, quoted in publint's stack
    // trace on stderr, says why), or there is no package.
    if (linted < 0)
      throw new Error(
        `publint did not lint the package: ${/npm error [^\\"\n]+/.exec(raw.stderr)?.[0] ?? raw.stderr.split(/\r?\n/).findLast((line) => /\bError:/.test(line)) ?? lines.findLast(Boolean) ?? ""}`,
      );
    const items = itemsOf(lines.slice(linted + 1));
    const manifest = join(ctx.cwd, "package.json");
    const text = items.length > 0 ? readFileSync(manifest, "utf8") : "";
    const findings: Finding[] = items.map(({ severity, message }) => {
      // `pkg.exports[...]` names the field the message is about.
      const field = /^pkg\.([\w-]+)/.exec(message)?.[1];
      return finding({
        tool: "publint",
        layer: "lint",
        file: absPosix(ctx.cwd, manifest),
        line: field ? lineOf(text, new RegExp(`"${field}"\\s*:`)) : 1,
        col: 1,
        ruleId: "publint",
        severity,
        message,
        fixable: false,
      });
    });
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
