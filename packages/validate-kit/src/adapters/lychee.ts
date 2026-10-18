import { existsSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import {
  absPosix,
  finding,
  findingsArray,
  fromRealCwd,
  parseJsonOutput,
  scratchOf,
} from "./base.js";

/** One link lychee could not resolve (infra-files.md, 5). */
interface LycheeEntry {
  url?: unknown;
  status?: { text?: unknown; details?: unknown };
  span?: { line?: unknown; column?: unknown };
}

interface LycheeTask {
  /** The documents to read, relative to the project root (POSIX). */
  files: string[];
}

/**
 * A path as lychee's `--files-from` reads it literally: each line is a glob,
 * and one starting with `#` a comment, so those characters go in brackets.
 */
function literal(path: string): string {
  return path.replace(/[[\]*?]|^#/g, (c) => `[${c}]`);
}

/** A document lychee reads links from. */
function isDocument(path: string): boolean {
  const lang = languageForFile(path);
  return lang === "markdown" || lang === "html";
}

/**
 * Each changed path that can break a link: a document (its links, its
 * anchors) or a path that is gone (a deleted or moved target).
 */
function touchesLinks(env: PlanEnv): boolean {
  return (env.changedPaths ?? []).some(
    (path) => isDocument(path) || !existsSync(join(env.projectRoot, path)),
  );
}

/**
 * lychee — broken links in the project's Markdown and HTML: a link to a file
 * that does not exist, or to an anchor (`#heading`) its target lacks.
 * Always `--offline`: no request leaves the machine, and web links are
 * counted as excluded, not checked. Where the project chose it: a
 * `lychee.toml` at the project root (lychee reads it from where it runs),
 * `tools.lychee.enabled` or `tools.lychee.configPath`. Reads every document
 * in scope, since a moved file breaks links in documents nobody changed; in
 * a changed-file run, only when a document changed or a path went away.
 * Recorded on 0.24.2:
 * docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 5.
 */
export const lychee: ToolAdapter = {
  id: "lychee",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "lychee",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.24.2",
  installHint: "brew install lychee  (or: cargo install lychee)",
  // 2: a link failed (and a usage error, which prints no report).
  findingExitCodes: [2],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, { configs: ["lychee.toml"] });
    if (!chosen || (env.changedPaths && !touchesLinks(env))) return [];
    const top = toPosix(root);
    const files = env.scopedFiles
      .filter(isDocument)
      .map((file) => posix.relative(top, toPosix(file)));
    if (files.length === 0) return [];
    const task: LycheeTask = { files };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-o|--output|--files-from|--offline|--dump|--dump-inputs|-v|--verbose|-q|--quiet)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit runs lychee offline on its own file list and reads its JSON report on stdout"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // The list goes in a file: a large project's would not fit on a
    // command line.
    const list = join(scratchOf(ctx), "lychee-files.txt");
    writeFileSync(
      list,
      `${(ctx.options as LycheeTask).files.map(literal).join("\n")}\n`,
    );
    return {
      bin: this.bin,
      args: [
        "--offline",
        "--no-progress",
        // Without it a link to a missing anchor passes.
        "--include-fragments",
        "--format",
        "json",
        // A config's `cache = true` would write .lycheecache into the project.
        "--cache=false",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        "--files-from",
        list,
      ],
      // 1: an input it cannot read; 3: a config it cannot load.
      okExitCodes: [0, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const report = parseJsonOutput<unknown>("lychee", raw, undefined) as
      { errors?: unknown; error_map?: unknown } | undefined;
    const map = report?.error_map;
    if (
      typeof report?.errors !== "number" ||
      typeof map !== "object" ||
      map === null ||
      Array.isArray(map)
    )
      throw new Error(
        "lychee's report has no error count or error_map: its output format may have changed; refusing to report zero findings.",
      );
    const cwd = toPosix(ctx.cwd);
    // Targets are absolute file:// URLs of the real path.
    const fileOf = fromRealCwd(ctx.cwd);
    const findings: Finding[] = [];
    for (const [input, entries] of Object.entries(map)) {
      for (const e of findingsArray<LycheeEntry>("lychee", entries)) {
        const text = e.status?.details ?? e.status?.text;
        if (
          typeof e.url !== "string" ||
          typeof text !== "string" ||
          typeof e.span?.line !== "number"
        )
          throw new Error(
            "lychee reported a link without a URL, status or line: its output format may have changed; refusing to report it.",
          );
        let message = text;
        if (e.url.startsWith("file://")) {
          const url = new URL(e.url);
          const target = posix.relative(cwd, fileOf(fileURLToPath(url)));
          message = `broken link to ${target}${url.hash}: ${text}`;
        }
        const file = absPosix(cwd, input);
        findings.push(
          finding({
            tool: "lychee",
            layer: "lint",
            language: languageForFile(file),
            file,
            line: e.span.line,
            col: typeof e.span.column === "number" ? e.span.column : 1,
            ruleId: "broken-link",
            severity: "error",
            message,
            fixable: false,
          }),
        );
      }
    }
    if (findings.length !== report.errors)
      throw new Error(
        `lychee counted ${report.errors} failed links but listed ${findings.length}: its output format may have changed; refusing to report them.`,
      );
    return {
      findings,
      filesProcessed: (ctx.options as LycheeTask).files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
