import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { z } from "zod";
import { ConfigError } from "../config/schema.js";
import { resolveBin, run } from "../core/exec.js";
import { groupBy } from "../core/group.js";
import type { PlannedTask } from "../core/plan.js";
import { configFolderOf } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import type {
  AvailabilityResult,
  BuiltCommand,
  Finding,
  Language,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";

/**
 * `tools.<id>.options`, parsed with the tool's own schema: a typo is a
 * config error (exit 2) naming the option, never a crash or silence.
 */
export function toolOptions<T>(
  env: PlanEnv,
  id: string,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(env.config.tools[id]?.options ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ConfigError(
    `tools.${id}.options${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`,
  );
}

const SEV_SET: ReadonlySet<string> = new Set([
  "error",
  "warning",
  "info",
  "hint",
]);

/** Normalize an arbitrary severity string to our enum (default warning). */
export function clampSeverity(value: string | undefined): Severity {
  if (!value) return "warning";
  const lower = value.toLowerCase();
  if (SEV_SET.has(lower)) return lower as Severity;
  if (lower === "err") return "error";
  if (lower === "warn") return "warning";
  if (lower === "note" || lower === "hint") return "hint";
  return "warning";
}

/**
 * The 1-based character column of a 0-based byte offset into line `line`
 * (1-based) of `lines`: tools that count bytes (typos, zizmor) against the
 * kit's characters. Without the text, the offset itself.
 */
export function charColumn(
  lines: readonly string[] | undefined,
  line: number,
  byte: number,
): number {
  const text = lines?.[line - 1];
  if (text === undefined) return byte + 1;
  return Buffer.from(text).subarray(0, byte).toString().length + 1;
}

/** The 1-based line of the first line of `text` matching `key`, else 1. */
export function lineOf(text: string | undefined, key: RegExp): number {
  const at = (text ?? "").split("\n").findIndex((line) => key.test(line));
  return at < 0 ? 1 : at + 1;
}

/**
 * Each file's lines, read once, for `charColumn`: undefined for a file that
 * cannot be read.
 */
export function sourceLines(): (file: string) => string[] | undefined {
  const read = new Map<string, string[] | undefined>();
  return (file) => {
    if (!read.has(file))
      read.set(
        file,
        existsSync(file) ? readFileSync(file, "utf8").split("\n") : undefined,
      );
    return read.get(file);
  };
}

/** `value` as a regular expression that matches exactly it (JS and RE2). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A file path as a glob that matches exactly it, for a tool that globs every
 * file it is named (solhint, html-validate): each glob character in a
 * character class. A `{a,b}` still expands there, so such a name throws.
 */
export function globLiteral(tool: string, path: string): string {
  if (/\{[^}]*,[^}]*\}/.test(path))
    throw new Error(
      `${tool} reads each file name as a glob and cannot be given ${path}: its {…,…} expands to other names. Rename the file or leave it out of the scope.`,
    );
  return path.replace(/[[\]*?{}()]/g, "[$&]");
}

export function absPosix(cwd: string, file: string): string {
  return toPosix(isAbsolute(file) ? file : resolve(cwd, file));
}

/**
 * A path a tool printed from its working directory's real path (taplo,
 * lychee: /private/tmp for /tmp), absolute in the kit's spelling of `cwd`.
 */
export function fromRealCwd(cwd: string): (path: string) => string {
  const kit = toPosix(cwd);
  const real = toPosix(realpathSync(cwd));
  return (path) => {
    const file = absPosix(kit, path);
    return file.startsWith(`${real}/`)
      ? `${kit}${file.slice(real.length)}`
      : file;
  };
}

/** The first line of `texts` that is not blank, trimmed. */
export function firstLineOf(...texts: string[]): string | undefined {
  for (const text of texts)
    for (const line of text.split(/\r?\n/)) if (line.trim()) return line.trim();
  return undefined;
}

/** A line of a Symfony Console error box: indented two spaces. */
const boxed = (line: string) => /^ {2}\S/.test(line);

/**
 * The message of a Symfony Console error (php-cs-fixer, PHPStan, Pint): its
 * boxed lines joined, else the first line `noise` does not match.
 */
export function consoleError(text: string, noise = /^$/): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(boxed);
  if (start >= 0) {
    const end = lines.findIndex((line, i) => i > start && !boxed(line));
    return lines
      .slice(start, end < 0 ? undefined : end)
      .map((line) => line.trim())
      .join(" ");
  }
  return lines.map((line) => line.trim()).find((l) => l && !noise.test(l));
}

/**
 * For every `dotnet` command: the SDK sends telemetry unless opted out,
 * prints a welcome banner on a first run, and its NuGet Audit fetches
 * vulnerability data on every restore, even with every package cached
 * (docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 1a).
 * MSBuild reads environment variables as properties.
 */
export const DOTNET_ENV = {
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  NuGetAudit: "false",
};

export function parseJsonOutput<T>(
  tool: string,
  raw: RawOutput,
  emptyValue: T,
): T {
  if (!raw.stdout.trim()) {
    if (raw.exitCode !== 0) {
      const firstLine = raw.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      throw new Error(
        `${tool} produced no JSON output on exit code ${raw.exitCode}${firstLine ? `: ${firstLine}` : ""}`,
      );
    }
    return emptyValue;
  }
  try {
    return JSON.parse(raw.stdout) as T;
  } catch (err) {
    throw new Error(
      `${tool} produced invalid JSON output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeOf(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The array a tool's JSON holds its findings in: the root itself (no `key`),
 * or `key` of a root object; every item an object. Anything else (null, a
 * string, a renamed key, an item of another type) means the tool's output
 * changed: it throws, which the runner reports as a crash, never as zero
 * findings (shapes: docs/research/lint-toolchain/exit-codes-and-json-shapes.md).
 * With `absentIsNone`, a root object without `key` holds none (osv leaves
 * `vulnerabilities` out of a package that has none); null still throws.
 */
export function findingsArray<T>(
  tool: string,
  parsed: unknown,
  key?: string,
  { absentIsNone = false }: { absentIsNone?: boolean } = {},
): T[] {
  const value =
    key === undefined ? parsed : isRecord(parsed) ? parsed[key] : undefined;
  if (Array.isArray(value) && value.every(isRecord)) return value as T[];
  if (absentIsNone && key !== undefined && isRecord(parsed) && !(key in parsed))
    return [];
  const want =
    key === undefined ? "an array" : `an object with a "${key}" array`;
  const got =
    key !== undefined && isRecord(parsed)
      ? `"${key}" holding ${shapeOf(value)}`
      : shapeOf(parsed);
  throw new Error(
    `${tool} output is not ${want} of objects (it holds ${got}): its output format may have changed; refusing to report zero findings.`,
  );
}

/**
 * A tool's JSON output and the findings array in it (`findingsArray`). No
 * output at all throws too: every recorded real run prints its JSON, even a
 * clean one (`[]`, or the object with an empty array).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape of the tool's JSON
export function parseFindings<T>(
  tool: string,
  raw: RawOutput,
  key?: string,
): { root: unknown; items: T[] } {
  const root = parseJsonOutput<unknown>(tool, raw, undefined);
  if (root === undefined)
    throw new Error(
      `${tool} printed no JSON on exit ${raw.exitCode}: even a clean run prints ${key === undefined ? "an array" : `its "${key}" array`}; its output format may have changed.`,
    );
  return { root, items: findingsArray<T>(tool, root, key) };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape of the tool's JSON
export function parseJsonLine<T>(tool: string, line: string): T {
  try {
    return JSON.parse(line) as T;
  } catch (err) {
    throw new Error(
      `${tool} produced invalid JSON output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function parts(version: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns negative/0/positive like a comparator. Unknown versions sort as equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Can the tool run here? Its version command must start and exit with one of
 * the adapter's `versionExitCodes`: a shim that exists but cannot run the
 * tool (mise: "osemgrep is not a valid shim") prints an error, and a version
 * read from that text would report a broken tool as working. The version
 * compare is informational.
 */
export async function checkAvailability(
  adapter: ToolAdapter,
  cwd: string,
  pathOnly = false,
): Promise<AvailabilityResult> {
  const args = adapter.versionArgs ?? ["--version"];
  const raw = await run(adapter.bin, [...args], {
    cwd,
    timeoutMs: 15_000,
    pathOnly,
    ...(adapter.pythonEnv ? { pythonEnv: true } : {}),
    ...(adapter.versionEnv ? { env: { ...adapter.versionEnv } } : {}),
  });
  const out = `${raw.stdout}\n${raw.stderr}`.trim();
  const ok = (adapter.versionExitCodes ?? [0]).includes(raw.exitCode);
  if (raw.spawnError || !ok) {
    const first = out.split("\n").find((line) => line.trim() !== "");
    return {
      available: false,
      minVersion: adapter.minVersion,
      installHint: adapter.installHint,
      ...(raw.spawnError
        ? {}
        : {
            problem: `\`${adapter.bin} ${args.join(" ")}\` exited ${raw.exitCode}${first ? `: ${first.trim()}` : ""}`,
          }),
    };
  }
  const version = adapter.parseVersion?.(out) ?? parts(out)?.join(".");
  return {
    available: true,
    ...(version ? { version } : {}),
    minVersion: adapter.minVersion,
    installHint: adapter.installHint,
  };
}

/** Probes a tool's version from one folder. */
export type AvailabilityProbe = (
  adapter: ToolAdapter,
  cwd: string,
  pathOnly?: boolean,
) => Promise<AvailabilityResult>;

/**
 * Can the tool run from each of `cwds`? One probe per executable the folders
 * resolve to (by real path), from the first folder of each: a tool installed
 * in one package (frontend/node_modules/.bin/tsc) is found from that
 * package's tasks, not from the project root (DV3).
 */
async function availabilityFrom(
  adapter: ToolAdapter,
  cwds: Iterable<string>,
  pathOnly: boolean,
  probe: AvailabilityProbe,
): Promise<Map<string, AvailabilityResult>> {
  const byBin = groupBy(new Set(cwds), (cwd) => {
    try {
      const bin = resolveBin(
        adapter.bin,
        cwd,
        process.env,
        pathOnly,
        adapter.pythonEnv,
      );
      return isAbsolute(bin) ? realpathSync(bin) : bin;
    } catch {
      return ""; // found nowhere: one probe says so for all of them
    }
  });
  const results = new Map<string, AvailabilityResult>();
  await Promise.all(
    [...byBin.values()].map(async (group) => {
      const result = await probe(adapter, group[0] ?? ".", pathOnly);
      for (const cwd of group) results.set(cwd, result);
    }),
  );
  return results;
}

/** One tool's availability over all its planned tasks. */
export interface ToolAvailability {
  /** Every version it was found at, sorted. */
  versions: string[];
  /** The tasks it cannot run. */
  lacking: PlannedTask[];
  /**
   * Why, when it cannot: the version command's own words, the configured
   * executable that is missing, or the folders it is missing from.
   */
  problem?: string;
  /**
   * A `tools.<id>.bin` the project named cannot run: required whatever the
   * tool's `optional`, since it was chosen, not left uninstalled.
   */
  configuredMissing: boolean;
}

/**
 * Probe a tool from the folders its tasks run in. A task with a configured
 * executable (`tools.<id>.bin`) has its own adapter object (plan.ts), looked
 * up on PATH only when it is a bare name.
 */
export async function toolAvailability(
  tasks: readonly PlannedTask[],
  projectRoot: string,
  probe: AvailabilityProbe = checkAvailability,
): Promise<ToolAvailability> {
  const answers = await Promise.all(
    [...groupBy(tasks, (t) => t.adapter)].map(async ([variant, own]) => {
      const configured = own[0]?.toolConfig.bin;
      const found = await availabilityFrom(
        variant,
        own.map((t) => t.cwd),
        configured !== undefined,
        probe,
      );
      return own.map((task) => ({
        task,
        configured,
        result: found.get(task.cwd),
      }));
    }),
  );
  const all = answers.flat();
  const versions = [
    ...new Set(
      all.flatMap(({ result }) => (result?.version ? [result.version] : [])),
    ),
  ].toSorted();
  const lacking = all.filter(({ result }) => result?.available !== true);
  const first = lacking[0];
  const dirs = [
    ...new Set(
      lacking.map(({ task }) => relative(projectRoot, task.cwd) || "."),
    ),
  ];
  const problem =
    first === undefined
      ? undefined
      : (first.result?.problem ??
        (first.configured !== undefined
          ? `tools.${first.task.adapter.id}.bin: ${first.configured} was not found`
          : lacking.length < all.length
            ? `${first.task.adapter.bin} was not found from ${dirs.join(", ")}`
            : undefined));
  return {
    versions,
    lacking: lacking.map(({ task }) => task),
    ...(problem ? { problem } : {}),
    configuredMissing: lacking.some(
      ({ configured }) => configured !== undefined,
    ),
  };
}

/**
 * The task's files in `languages` (by the language table), or "." for the
 * whole root when the task has no file list.
 */
export function filesIn(
  ctx: ToolContext,
  languages: readonly Language[],
): string[] {
  if (!ctx.files || ctx.files.length === 0) return ["."];
  return ctx.files.filter((file) => {
    const language = languageForFile(file);
    return language !== undefined && languages.includes(language);
  });
}

/**
 * The seed's files of `language` that exist: several tools pass a missing
 * path silently. A plan made without a file list (the four-argument
 * buildPlan) still finds the tool's files.
 */
export function existingFiles(
  seed: TaskSeed,
  env: PlanEnv,
  language: Language,
): string[] {
  return (
    seed.files ??
    env.scopedFiles.filter((file) => languageForFile(file) === language)
  ).filter((file) => existsSync(file));
}

/**
 * The task's files relative to the folder it runs in, each below it (so a
 * config's own exclude patterns match them). None is a bug in the plan: the
 * tool would read stdin or its whole folder.
 */
export function relativeFiles(ctx: ToolContext, tool: string): string[] {
  const files = ctx.files ?? [];
  if (files.length === 0) throw new Error(`${tool} needs the task's file list`);
  const cwd = toPosix(ctx.cwd);
  return files.map((file) => posix.relative(cwd, toPosix(file)));
}

/** One file's own run, after the run of them all failed. */
export interface EachRun {
  file: string;
  /** null: it did not exit (it could not start, or a signal ended it). */
  status: number | null;
  /** Its stdout, then its stderr. */
  out: string;
}

/** Run by node: the options, then every file; on a failure, each file. */
const BATCH_THEN_EACH = `
const { spawnSync } = require("node:child_process");
const [bin, options, ...files] = process.argv.slice(1);
const run = (list) => spawnSync(bin, [...JSON.parse(options), ...list], { encoding: "utf8", maxBuffer: 1 << 26 });
const all = run(files);
if (all.status === 0 && !all.stderr && !all.stdout) process.exit(0);
process.stdout.write(JSON.stringify(files.map((file) => {
  const one = run([file]);
  return { file, status: one.status, out: (one.stdout || "") + (one.stderr || "") + (one.error ? String(one.error) : "") };
})));
process.exit(all.status ?? 1);
`;

/**
 * For a tool whose output cannot name the file a finding is in
 * (ocamlformat prints nothing) or mixes files (ormolu): every file in one
 * process, and only when that run fails or prints anything, each file in
 * its own, as JSON `EachRun[]` on stdout (`eachRun` reads it). The exit
 * code is the first run's.
 */
export function batchThenEach(
  bin: string,
  options: readonly string[],
  files: readonly string[],
): BuiltCommand {
  return {
    bin: process.execPath,
    args: ["-e", BATCH_THEN_EACH, bin, JSON.stringify(options), ...files],
    okExitCodes: "any",
    // A timeout stops the per-file runs too.
    processGroup: true,
  };
}

/** batchThenEach's per-file runs: none when the run of them all passed. */
export function eachRun(tool: string, raw: RawOutput): EachRun[] {
  if (raw.exitCode === 0 && !raw.stdout.trim()) return [];
  return findingsArray<EachRun>(tool, parseJsonLine<unknown>(tool, raw.stdout));
}

/**
 * For a tool that reads one config from the folder it runs in (taplo,
 * yamllint, stylelint): the seed's files of `language` that exist (a
 * missing path passes silently), each run from the folder of its nearest
 * config in `configs` (or a package.json with `lookup.key`). A file none
 * reaches is not the tool's, unless `tools.<id>.enabled` runs it on the
 * tool's defaults; with `tools.<id>.configPath` every file runs from the
 * seed's folder. `lookup` is configFolderOf's.
 */
export function byConfigFolder(
  seed: TaskSeed,
  env: PlanEnv,
  language: Language,
  configs: readonly string[],
  lookup?: Parameters<typeof configFolderOf>[2],
): TaskSeed[] {
  const named = env.toolConfig.configPath !== undefined;
  const folderOf = configFolderOf(env.projectRoot, configs, lookup);
  const kept = existingFiles(seed, env, language).flatMap((file) => {
    const dir = named
      ? seed.cwd
      : (folderOf(file) ??
        (env.toolConfig.enabled === true ? seed.cwd : undefined));
    return dir === undefined ? [] : [{ file, dir: toPosix(dir) }];
  });
  return [...groupBy(kept, (k) => k.dir)].map(([cwd, own]) => ({
    cwd,
    files: own.map((k) => k.file),
  }));
}

/**
 * ESLint's and oxlint's `--quiet` drops warnings from the report while a
 * warning limit still counts them, so the tool exits 1 with no finding
 * (docs/research/lint-toolchain/quiet-with-warning-limit.md). `limits` are
 * the tool's limit flags; a value of -1 is no limit.
 */
export function quietWithWarningLimit(
  extraArgs: readonly string[],
  limits: readonly string[],
): string | undefined {
  if (!extraArgs.includes("--quiet")) return undefined;
  const limit = extraArgs.find((arg, i) => {
    const [flag = "", inline] = arg.split("=", 2);
    if (!limits.includes(flag)) return false;
    const value = inline ?? extraArgs[i + 1];
    return flag === "--deny-warnings" || value !== "-1";
  });
  return limit
    ? `--quiet with ${limit.split("=")[0]} exits 1 with no finding in the report (--quiet drops the warnings the limit counts); keep one of them`
    : undefined;
}

/** One SARIF 2.1.0 result, as Biome and knip write it. */
export interface SarifResult {
  ruleId?: unknown;
  level?: unknown;
  message?: { text?: unknown };
  locations?: {
    physicalLocation?: {
      artifactLocation?: { uri?: unknown };
      region?: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
    };
  }[];
}

/** The results of a report that must be exactly one SARIF 2.1.0 run. */
export function sarifResults(tool: string, raw: RawOutput): SarifResult[] {
  const { root } = parseFindings<unknown>(tool, raw, "runs");
  const sarif = root as { version?: unknown; runs: unknown[] };
  if (sarif.version !== "2.1.0" || sarif.runs.length !== 1)
    throw new Error(
      `${tool} output is not one SARIF 2.1.0 run: its output format may have changed; refusing to report zero findings.`,
    );
  return findingsArray<SarifResult>(tool, sarif.runs[0], "results");
}

/** Build a Finding, omitting undefined optionals. */
export function finding(f: {
  tool: string;
  layer: Finding["layer"];
  language?: Finding["language"];
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  ruleId?: string;
  severity: Severity;
  message: string;
  fixable: boolean;
  url?: string;
}): Finding {
  return {
    tool: f.tool,
    layer: f.layer,
    ...(f.language !== undefined ? { language: f.language } : {}),
    file: f.file,
    // Clamp to a valid 1-based position. Some tools omit line/col on file-level
    // notices (undefined -> NaN); never let that reach JSON/SARIF as null.
    line: Number.isFinite(f.line) ? Math.max(1, f.line) : 1,
    col: Number.isFinite(f.col) ? Math.max(1, f.col) : 1,
    ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
    ...(f.endCol !== undefined ? { endCol: f.endCol } : {}),
    ...(f.ruleId !== undefined ? { ruleId: f.ruleId } : {}),
    severity: f.severity,
    message: f.message,
    fixable: f.fixable,
    ...(f.url !== undefined ? { url: f.url } : {}),
  };
}

/**
 * A formatter's list of the files that differ, one path a line on stdout
 * (`files` picks the lines that are paths; `path` decodes one): a finding
 * each, at 1:1. None in a fix pass, where the list is the files it rewrote.
 */
export function listedFiles(
  tool: string,
  raw: RawOutput,
  ctx: ToolContext,
  {
    files,
    message,
    path = (line) => line,
  }: { files: RegExp; message: string; path?: (line: string) => string },
): Finding[] {
  if (ctx.fix) return [];
  return raw.stdout.split(/\r?\n/).flatMap((line) => {
    const printed = line.trim();
    if (!files.test(printed)) return [];
    const file = absPosix(ctx.cwd, path(printed));
    return [
      finding({
        tool,
        layer: "format",
        language: languageForFile(file),
        file,
        line: 1,
        col: 1,
        severity: "warning",
        message,
        fixable: true,
      }),
    ];
  });
}

/**
 * The result of a tool whose exit codes mix findings and crashes: a non-zero
 * exit with nothing read is a crash, with the tool's first stderr line.
 */
export function readResult(
  tool: string,
  raw: RawOutput,
  ctx: ToolContext,
  findings: Finding[],
): RunResult {
  if (raw.exitCode !== 0 && findings.length === 0)
    throw new Error(
      `${tool} exited ${raw.exitCode} and reported nothing the kit reads: ${raw.stderr.trim().split("\n")[0] ?? ""}`,
    );
  return {
    findings,
    filesProcessed: ctx.files?.length ?? 0,
    fixesApplied: 0,
    rawExitCode: raw.exitCode,
    stderr: raw.stderr,
  };
}

const scratches = new WeakMap<ToolContext, string>();

/**
 * The task's scratch folder, the same one for its command and for reading
 * its report: a report a tool writes to a file goes there.
 */
export function scratchOf(ctx: ToolContext): string {
  let dir = scratches.get(ctx);
  if (dir === undefined) {
    if (!ctx.tempDir) throw new Error("this tool needs a scratch folder");
    dir = ctx.tempDir();
    scratches.set(ctx, dir);
  }
  return dir;
}
