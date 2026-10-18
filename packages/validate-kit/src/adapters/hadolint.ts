import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { groupBy } from "../core/group.js";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { configFolderOf } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, parseFindings } from "./base.js";

/** One hadolint JSON finding (sota-2026-10-18/infra-files.md, 1). */
interface HadolintFinding {
  code?: unknown;
  column?: unknown;
  file?: unknown;
  level?: unknown;
  line?: unknown;
  message?: unknown;
}

/**
 * hadolint's levels, most severe first; a finding fails hadolint's run when
 * its level ranks at or above the threshold (`info` by default; `none` and
 * `ignore` fail on every level, as run on 2.15.1).
 */
const RANK: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
  style: 3,
  ignore: 4,
  none: 4,
};

/** The keys hadolint reads from its config; it skips any other in silence. */
const KEYS = new Set([
  "disable-ignore-pragma",
  "failure-threshold",
  "format",
  "ignored",
  "label-schema",
  "no-color",
  "no-fail",
  "override",
  "strict-labels",
  "trustedRegistries",
]);

/** hadolint reads its config from the folder it runs in only, not upward. */
const CONFIGS = [".hadolint.yaml", ".hadolint.yml"];

/** The config this task's run reads: the one named, else its folder's. */
function configOf(ctx: ToolContext): string | undefined {
  return (
    ctx.configPath ??
    CONFIGS.map((name) => join(ctx.cwd, name)).find((path) => existsSync(path))
  );
}

/**
 * The rank at which a finding gates: the config's `failure-threshold`. A
 * key or a level hadolint does not know is refused, since hadolint would
 * skip it and run as if the config said nothing.
 */
function thresholdOf(file: string | undefined): number {
  if (file === undefined) return 2;
  const config: unknown = parse(readFileSync(file, "utf8"));
  if (config === null || config === undefined) return 2;
  if (typeof config !== "object" || Array.isArray(config))
    throw new Error(`hadolint config ${file} is not a mapping`);
  const unknown = Object.keys(config).find((key) => !KEYS.has(key));
  if (unknown !== undefined)
    throw new Error(
      `hadolint config ${file} has the key "${unknown}", which hadolint skips without a word`,
    );
  const threshold = (config as Record<string, unknown>)["failure-threshold"];
  if (threshold === undefined) return 2;
  const rank = typeof threshold === "string" ? RANK[threshold] : undefined;
  if (rank === undefined)
    throw new Error(
      `hadolint config ${file}: failure-threshold ${JSON.stringify(threshold)} is not a level`,
    );
  return rank;
}

/**
 * hadolint — Dockerfile linter: unpinned base images and packages, `apt-get`
 * without cleanup, `ADD` for local files, and ShellCheck (built in) on each
 * RUN line. On by default wherever a Dockerfile or Containerfile is in scope,
 * as shellcheck is for shell. Each file is checked from the nearest folder at
 * or above it with a `.hadolint.yaml`, which is named with `--config`, else
 * from its root; findings below the config's `failure-threshold` are info.
 * Recorded on 2.15.1:
 * docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 1.
 */
export const hadolint: ToolAdapter = {
  id: "hadolint",
  layer: "lint",
  languages: ["dockerfile"],
  bin: "hadolint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "2.15.1",
  installHint: "brew install hadolint",
  findingExitCodes: [1],

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|--no-fail|-t|--failure-threshold|-o|--output|--file-path-in-report)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads hadolint's JSON on stdout and its exit code; --format, --output, --no-fail and --failure-threshold change them"
      : undefined,

  expand(seed, env) {
    if (env.toolConfig.configPath !== undefined || !seed.files) return [seed];
    const folderOf = configFolderOf(env.projectRoot, CONFIGS);
    return [...groupBy(seed.files, (file) => folderOf(file) ?? seed.cwd)].map(
      ([cwd, files]) => ({ cwd: toPosix(cwd), files }),
    );
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    // hadolint does not walk folders, and with no file it reads stdin.
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("hadolint needs the task's file list");
    const config = configOf(ctx);
    return {
      bin: this.bin,
      args: [
        "--format",
        "json",
        ...(config ? ["--config", config] : []),
        ...ctx.extraArgs,
        ...files,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A config it cannot read is a line on stderr, then a clean run.
    const broken = /Error parsing your config file[^\n]*/.exec(raw.stderr);
    if (broken)
      throw new Error(`hadolint could not read its config: ${broken[0]}`);
    const threshold = thresholdOf(configOf(ctx));
    // A missing file or config and a bad flag exit 1 too, with nothing on
    // stdout: `hadolint: Uncaught exception ...`, then what went wrong.
    if (raw.exitCode !== 0 && raw.stdout.trim() === "") {
      const lines = raw.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const why = /Uncaught exception/.test(lines[0] ?? "")
        ? lines[1]
        : lines[0];
      throw new Error(`hadolint could not run${why ? `: ${why}` : ""}`);
    }
    const { items } = parseFindings<HadolintFinding>("hadolint", raw);
    const findings = items.map((f) => {
      const rank = typeof f.level === "string" ? RANK[f.level] : undefined;
      if (
        rank === undefined ||
        typeof f.file !== "string" ||
        typeof f.line !== "number" ||
        typeof f.code !== "string" ||
        typeof f.message !== "string"
      )
        throw new Error(
          `hadolint output has a finding without a file, line, code, message or known level (${JSON.stringify(f.level)}): its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "hadolint",
        layer: "lint",
        language: "dockerfile",
        file: absPosix(ctx.cwd, f.file),
        line: f.line,
        col: typeof f.column === "number" ? f.column : 1,
        ruleId: f.code,
        severity: rank === 0 ? "error" : rank <= threshold ? "warning" : "info",
        message: f.message,
        fixable: false,
        url: f.code.startsWith("SC")
          ? `https://www.shellcheck.net/wiki/${f.code}`
          : `https://github.com/hadolint/hadolint/wiki/${f.code}`,
      });
    });
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
