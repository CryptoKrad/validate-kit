import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { isCode, languageForFile, toPosix } from "../detect/languages.js";
import { finding, parseFindings } from "./base.js";

/** One side of a clone (docs/research/lint-toolchain/jscpd-cli.md, 1). */
interface Side {
  name: string;
  start: number;
  end: number;
  startLoc: { column: number };
  endLoc: { column: number };
}

interface Clone {
  format: string;
  kind: string;
  method?: string;
  tokens: number;
  lines?: number;
  firstFile: Side;
  secondFile: Side;
}

interface JscpdTask {
  /** The code files compared (absolute, POSIX): the kit's whole scope. */
  files: string[];
  /** Files whose findings count: the scope, or what a change touched. */
  keep: string[];
  /** The project's detection settings, from its own .jscpd.json. */
  settings: Record<string, unknown>;
}

/** Detection keys a project's .jscpd.json may set; never its gates or output. */
const DETECTION_KEYS = [
  "minTokens",
  "minLines",
  "maxLines",
  "maxSize",
  "mode",
  "ignore",
  "ignorePattern",
  "ignoreCase",
  "ignoreIdentifiers",
  "ignoreLiterals",
  "skipComments",
  "formatsExts",
  "formatsNames",
  "skipLocal",
];

const ALLOWED_ARGS =
  /^--(min-tokens|min-lines|max-lines|max-size|mode|skip-comments|ignore|ignore-pattern|ignore-case|ignore-identifiers|ignore-literals|ignore-annotations|max-gap-lines|cross-formats|formats-exts|formats-names|skip-local|skip-isolated|follow-symlinks|no-gitignore|workers)(=|$)/;

/** jscpd's own rule names (jscpd-cli.md, 6). */
function ruleOf(clone: Clone): string {
  if (clone.kind === "renamed") return "renamed-code";
  if (clone.kind === "semantic") return "semantic-code";
  if (clone.kind === "similar")
    return clone.method === "ast" ? "similar-function" : "similar-code";
  return "duplicate-code";
}

// The report folder of each task, between buildArgs and parseOutput.
const outputs = new WeakMap<ToolContext, string>();

function isSide(side: unknown): side is Side {
  const s = side as Partial<Side> | undefined;
  return (
    typeof s?.name === "string" &&
    typeof s.start === "number" &&
    typeof s.end === "number" &&
    typeof s.startLoc?.column === "number" &&
    typeof s.endLoc?.column === "number"
  );
}

/** jscpd — the same code copied between files, in any language it knows. */
export const jscpd: ToolAdapter = {
  id: "jscpd",
  layer: "lint",
  languages: ["ts", "js", "rust", "go", "python", "shell"],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "jscpd",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  // kind, exit 1 on errors, no double scan of nested paths, byte columns
  // in CRLF files (jscpd-cli.md, 6).
  minVersion: "5.3.3",
  installHint: "pnpm add -D jscpd",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [".jscpd.json"],
      dep: "jscpd",
      key: "jscpd",
    }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // A copy is found only between the paths jscpd is given: always the
    // whole scope, even when a change touched one file (jscpd-cli.md, 4).
    const files = env.scopedFiles.filter(
      (file) => isCode(file) && languageForFile(file) !== "sql",
    );
    if (files.length === 0) return [];
    const changed = env.changedPaths
      ? new Set(env.changedPaths.map((path) => toPosix(join(seed.cwd, path))))
      : undefined;
    // The project's own detection settings: its .jscpd.json, else a
    // `jscpd` key in its package.json.
    const own = env.toolConfig.configPath ?? join(seed.cwd, ".jscpd.json");
    const manifest = join(seed.cwd, "package.json");
    let parsed: Record<string, unknown> = {};
    try {
      if (existsSync(own))
        parsed = JSON.parse(readFileSync(own, "utf8")) as Record<
          string,
          unknown
        >;
      else if (existsSync(manifest))
        parsed =
          ((JSON.parse(readFileSync(manifest, "utf8")) as { jscpd?: unknown })
            .jscpd as Record<string, unknown> | undefined) ?? {};
    } catch (err) {
      return [
        {
          ...seed,
          cannotRun: `its settings are not JSON (${existsSync(own) ? own : manifest}: ${err instanceof Error ? err.message : String(err)})`,
        },
      ];
    }
    const settings = Object.fromEntries(
      DETECTION_KEYS.filter((key) => key in parsed).map((key) => [
        key,
        parsed[key],
      ]),
    );
    const task: JscpdTask = {
      files,
      keep: changed ? files.filter((file) => changed.has(file)) : files,
      settings,
    };
    return task.keep.length === 0 ? [] : [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    const refused = extraArgs.find(
      (arg) => !ALLOWED_ARGS.test(arg) && arg.startsWith("-"),
    );
    if (refused)
      return `${refused} is not one of jscpd's detection options: the kit sets the paths, the report and the gate`;
    if (
      extraArgs.some(
        (arg, i) =>
          !arg.startsWith("-") && !(extraArgs[i - 1] ?? "").startsWith("--"),
      )
    )
      return "a path replaces the files the kit compares";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as JscpdTask;
    if (!ctx.tempDir) throw new Error("jscpd needs a scratch folder");
    const dir = ctx.tempDir();
    const config = join(dir, "jscpd.json");
    writeFileSync(
      config,
      JSON.stringify({
        // Copies shorter than this were noise here (jscpd-cli.md, 5).
        minTokens: 100,
        minLines: 10,
        mode: "mild",
        ...task.settings,
        path: task.files,
      }),
    );
    const out = join(dir, "out");
    outputs.set(ctx, out);
    return {
      bin: this.bin,
      args: [
        "--config",
        config,
        "--absolute",
        "--reporters",
        "json",
        "--output",
        out,
        "--silent",
        "--no-colors",
        "--no-tips",
        ...ctx.extraArgs,
      ],
      // No gate is set, so any other exit is an error.
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as JscpdTask;
    const out = outputs.get(ctx);
    const report = out ? join(out, "jscpd-report.json") : undefined;
    if (!report || !existsSync(report))
      throw new Error(`jscpd wrote no report: ${raw.stderr.trim()}`);
    const { root, items: clones } = parseFindings<Clone>(
      "jscpd",
      { ...raw, stdout: readFileSync(report, "utf8") },
      "duplicates",
    );
    const total = (root as { statistics?: { total?: unknown } }).statistics
      ?.total;
    if (typeof total !== "object" || total === null)
      throw new Error(
        "jscpd's report has no statistics.total: its output format may have changed; refusing to report it.",
      );
    // --absolute prints real paths; the kit reports the project's spelling.
    const cwd = toPosix(ctx.cwd);
    const realCwd = toPosix(realpathSync(ctx.cwd));
    const fileOf = (name: string): string => {
      let file = toPosix(name);
      if (file.startsWith(`${realCwd}/`))
        file = `${cwd}${file.slice(realCwd.length)}`;
      // A name can carry its format (`a.ts:typescript`).
      const bare = file.replace(/:[a-z0-9-]+$/i, "");
      return bare !== file && existsSync(bare) ? bare : file;
    };
    // One finding per file per copied stretch: overlapping sides merge, so
    // a new copy elsewhere does not add findings to files nobody touched.
    interface Stretch {
      file: string;
      rule: string;
      start: number;
      end: number;
      col: number;
      endCol: number;
      lines: number;
      tokens: number;
      partners: string[];
    }
    const sides: Stretch[] = [];
    for (const clone of clones) {
      if (
        typeof clone.format !== "string" ||
        typeof clone.kind !== "string" ||
        typeof clone.tokens !== "number" ||
        !isSide(clone.firstFile) ||
        !isSide(clone.secondFile)
      )
        throw new Error(
          "jscpd's report has a clone without a format, kind, token count or two sides: its output format may have changed; refusing to report it.",
        );
      const rule = ruleOf(clone);
      for (const [side, other] of [
        [clone.firstFile, clone.secondFile],
        [clone.secondFile, clone.firstFile],
      ] as const) {
        const partner = posix.relative(cwd, fileOf(other.name));
        sides.push({
          file: fileOf(side.name),
          rule,
          start: side.start,
          end: side.end,
          col: side.startLoc.column + 1,
          endCol: side.endLoc.column + 1,
          lines: side.end - side.start + 1,
          tokens: clone.tokens,
          partners: [`${partner}:${other.start}-${other.end}`],
        });
      }
    }
    const merged: Stretch[] = [];
    for (const side of sides.toSorted(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.rule.localeCompare(b.rule) ||
        a.start - b.start,
    )) {
      const last = merged.at(-1);
      if (
        last &&
        last.file === side.file &&
        last.rule === side.rule &&
        side.start <= last.end
      ) {
        if (side.end > last.end) {
          last.end = side.end;
          last.endCol = side.endCol;
        }
        last.lines = last.end - last.start + 1;
        last.tokens = Math.max(last.tokens, side.tokens);
        last.partners = [...new Set([...last.partners, ...side.partners])];
      } else merged.push({ ...side });
    }
    const keep = new Set(task.keep);
    const findings: Finding[] = merged
      .filter((stretch) => keep.has(stretch.file))
      .map((stretch) => {
        const [first] = stretch.partners;
        const message =
          stretch.partners.length === 1
            ? `Duplicated in ${first} (${stretch.lines} lines, ${stretch.tokens} tokens)`
            : `Duplicated in ${stretch.partners.length} places: ${stretch.partners.slice(0, 3).join(", ")}${stretch.partners.length > 3 ? ` and ${stretch.partners.length - 3} more` : ""}`;
        return finding({
          tool: "jscpd",
          layer: "lint",
          language: languageForFile(stretch.file),
          file: stretch.file,
          line: stretch.start,
          col: stretch.col,
          endLine: stretch.end,
          endCol: stretch.endCol,
          ruleId: stretch.rule,
          severity: "warning",
          message,
          fixable: false,
        });
      });
    return {
      findings,
      filesProcessed:
        typeof (total as { sources?: unknown }).sources === "number"
          ? (total as { sources: number }).sources
          : task.files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
