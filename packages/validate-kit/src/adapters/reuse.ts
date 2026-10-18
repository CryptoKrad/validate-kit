import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
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
import { absPosix, finding, parseJsonOutput } from "./base.js";
import { gitFiles, ignoredBy } from "./native.js";

/** `reuse lint --json` (infra-files.md, 7); the lists hold paths or licence ids. */
interface ReuseReport {
  files?: { path?: unknown; spdx_expressions?: unknown }[];
  non_compliant?: Record<string, unknown>;
}

interface ReuseTask {
  /**
   * The paths whose findings count (project-relative): git's files less the
   * config's `ignore`, as reuse reads the whole tree and, under `--root`,
   * not the .gitignore of a repository above it; in a changed-file run, the
   * changed ones, unless REUSE.toml or a licence text changed.
   */
  keep: string[];
}

/**
 * What adopts REUSE, at the project root (the REUSE spec 3.3). Not
 * LICENSES/ alone: a project keeps vendor notices there too.
 */
const MARKERS = ["REUSE.toml", ".reuse/dep5"];

/** A change to what reuse judges every file by. */
const POLICY = /^(?:REUSE\.toml|\.reuse\/dep5|LICENSES\/.*)$/;

/** Each list of paths in `non_compliant`: its rule id and what to do. */
const PATH_PROBLEMS: Record<string, [string, string]> = {
  missing_copyright_info: [
    "missing-copyright",
    "no copyright notice: add an `SPDX-FileCopyrightText:` line, or cover the file in REUSE.toml",
  ],
  missing_licensing_info: [
    "missing-licence",
    "no licence: add an `SPDX-License-Identifier:` line, or cover the file in REUSE.toml",
  ],
  read_errors: ["read-error", "reuse could not read the file"],
};

/** Each list of licence ids in `non_compliant`: its rule id and what to do. */
const LICENCE_PROBLEMS: Record<string, [string, (id: string) => string]> = {
  missing_licenses: [
    "missing-licence-text",
    (id) =>
      `\`${id}\` is used but LICENSES/ holds no text for it: run \`reuse download ${id}\``,
  ],
  bad_licenses: [
    "bad-licence",
    (id) =>
      `\`${id}\` is not an SPDX licence identifier: use one from https://spdx.org/licenses/, or name a custom licence LicenseRef-…`,
  ],
  deprecated_licenses: [
    "deprecated-licence",
    (id) => `\`${id}\` is a deprecated SPDX identifier: use its current one`,
  ],
  licenses_without_extension: [
    "licence-without-extension",
    (id) => `the licence text LICENSES/${id} has no file extension: add .txt`,
  ],
  unused_licenses: [
    "unused-licence",
    (id) =>
      `no file uses the licence \`${id}\`: delete its text from LICENSES/, or license a file under it`,
  ],
};

/**
 * reuse — REUSE licence compliance: every file has a copyright notice and an
 * SPDX licence (in its header, or covered by REUSE.toml), and each licence
 * used has its text in LICENSES/ and each text there is used. Where the
 * project adopted REUSE: a `REUSE.toml` or `.reuse/dep5` at the project
 * root, a task or CI step that runs `reuse lint`, or `tools.reuse.enabled`.
 * Always with `--root`, without
 * which reuse lints the whole git repository the project sits in. It reads
 * the whole tree (0.36 s), so it is in the verify tier; only files git
 * would commit are reported, less the config's `ignore`. Recorded on 6.2.0:
 * docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 7.
 */
export const reuse: ToolAdapter = {
  id: "reuse",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "reuse",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "6.2.0",
  installHint: "brew install reuse  (or: uv tool install reuse)",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      toolAdopted(root, root, { configs: MARKERS, step: /\breuse\s+lint\b/ });
    if (!chosen) return [];
    const top = toPosix(root);
    const ignored = ignoredBy(env);
    let keep = (
      gitFiles(top, env.changedMode === "staged") ??
      env.scopedFiles.map((file) => posix.relative(top, file))
    ).filter((path) => !ignored(path));
    const changed = env.changedPaths?.map(toPosix);
    if (changed && !changed.some((path) => POLICY.test(path))) {
      const touched = new Set(changed);
      keep = keep.filter((path) => touched.has(path));
    }
    if (keep.length === 0) return [];
    const task: ReuseTask = { keep };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-j|--json|-p|--plain|-l|--lines|-q|--quiet)$/.test(arg),
    )
      ? "the kit reads reuse lint's JSON report"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["--root", ctx.cwd, "lint", "--json", ...ctx.extraArgs],
      // 2: a usage error or a root that does not exist.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const report = parseJsonOutput<ReuseReport | undefined>(
      "reuse",
      raw,
      undefined,
    );
    const problems = report?.non_compliant ?? {};
    const lists = [
      ...Object.keys(PATH_PROBLEMS),
      ...Object.keys(LICENCE_PROBLEMS),
    ].map((key) => problems[key]);
    if (
      !lists.every(
        (list) =>
          Array.isArray(list) && list.every((v) => typeof v === "string"),
      )
    )
      throw new Error(
        "reuse's report has no non_compliant lists of names: its output format may have changed; refusing to report it.",
      );
    // Exit 1 means non-compliant: checked before the kit's ignore list drops
    // any, and a kind of problem the kit does not know leaves these empty.
    const named = lists.some((list) => list.length > 0);
    if ((raw.exitCode === 1) !== named)
      throw new Error(
        `reuse exited ${raw.exitCode} with ${named ? "" : "no "}problems in its report: its output format may have changed; refusing to report it.`,
      );
    const cwd = toPosix(ctx.cwd);
    const keep = new Set((ctx.options as ReuseTask | undefined)?.keep);
    // A file whose licence expression does not parse lacks a licence too.
    const invalid = new Map<string, string>();
    // Where each licence id is used: a file's header, or REUSE.toml.
    const usedAt = new Map<string, Set<string>>();
    for (const f of report?.files ?? []) {
      const expressions = Array.isArray(f.spdx_expressions)
        ? (f.spdx_expressions as {
            value?: unknown;
            is_valid?: unknown;
            source?: unknown;
          }[])
        : [];
      const bad = expressions
        .filter((e) => e.is_valid === false && typeof e.value === "string")
        .map((e) => `\`${String(e.value)}\``);
      if (typeof f.path === "string" && bad.length > 0)
        invalid.set(f.path, bad.join(", "));
      for (const e of expressions)
        if (typeof e.value === "string" && typeof e.source === "string")
          for (const id of e.value.split(/[\s()]+/)) {
            const at = usedAt.get(id) ?? new Set<string>();
            usedAt.set(id, at.add(e.source));
          }
    }
    let texts: string[] = [];
    try {
      texts = readdirSync(join(cwd, "LICENSES"));
    } catch {
      /* no LICENSES/ folder */
    }
    const findings: Finding[] = [];
    const add = (
      path: string,
      ruleId: string,
      message: string,
      always = false,
    ): void => {
      // Its lists hold absolute paths under an absolute --root.
      const file = absPosix(cwd, path);
      if (!always && !keep.has(posix.relative(cwd, file))) return;
      findings.push(
        finding({
          tool: "reuse",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: 1,
          col: 1,
          ruleId,
          severity: "error",
          message,
          fixable: false,
        }),
      );
    };
    for (const [key, [ruleId, message]] of Object.entries(PATH_PROBLEMS))
      for (const path of problems[key] as string[]) {
        const expression = invalid.get(path);
        if (key === "missing_licensing_info" && expression)
          add(
            path,
            "invalid-spdx",
            `the licence expression ${expression} does not parse: correct its \`SPDX-License-Identifier:\` line`,
          );
        else add(path, ruleId, message);
      }
    for (const [key, [ruleId, message]] of Object.entries(LICENCE_PROBLEMS))
      for (const id of problems[key] as string[]) {
        // A text that is missing, at each place that uses it; any other, at
        // the text itself.
        const text =
          texts.find((name) => name === id || name.startsWith(`${id}.`)) ??
          `${id}.txt`;
        const at =
          key === "missing_licenses" ? [...(usedAt.get(id) ?? [])] : [];
        // A text no one is known to use is still a failed run: always shown.
        if (at.length === 0) add(`LICENSES/${text}`, ruleId, message(id), true);
        for (const path of at) add(path, ruleId, message(id));
      }
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
