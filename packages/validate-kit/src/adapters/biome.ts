import type {
  BuiltCommand,
  Finding,
  Layer,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { groupBy } from "../core/group.js";
import { biomeRunDirs } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding, type SarifResult, sarifResults } from "./base.js";

const LEVELS: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  // Biome's info and hint levels.
  note: "info",
};

/** Flags both commands take: SARIF (stable since 2.4.0), never truncated. */
const REPORT = [
  "--reporter=sarif",
  "--colors=off",
  "--max-diagnostics=none",
  "--no-errors-on-unmatched",
  "--files-ignore-unknown=true",
];

/**
 * Each file to the folder Biome must run in for it (biomeRunDirs). A file
 * no Biome config in the project reaches is not Biome's, unless
 * `tools.<id>.enabled` is true or `configPath` names its config: then it runs
 * from the project root.
 */
function byRootConfig(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
  const runDir = biomeRunDirs(env.projectRoot);
  const anyway =
    env.toolConfig.enabled === true || env.toolConfig.configPath !== undefined;
  // A plan made without a file list (the four-argument buildPlan) still
  // finds Biome's files: the scope's TS and JS.
  const files =
    seed.files ??
    env.scopedFiles.filter((file) => {
      const lang = languageForFile(file);
      return lang === "ts" || lang === "js";
    });
  const kept = files.flatMap((file) => {
    const found = runDir(file);
    return found === undefined && !anyway
      ? []
      : [{ file, dir: toPosix(found ?? seed.cwd) }];
  });
  // The planner's seeds carry only a folder and files.
  return [...groupBy(kept, (k) => k.dir)].map(([cwd, own]) => ({
    cwd,
    files: own.map((k) => k.file),
  }));
}

function command(
  this: ToolAdapter,
  ctx: ToolContext,
  subcommand: string[],
): BuiltCommand {
  const args = [...subcommand, ...REPORT];
  if (ctx.fix) args.push("--write");
  if (ctx.configPath) args.push(`--config-path=${ctx.configPath}`);
  args.push(...ctx.extraArgs, ...(ctx.files ?? []));
  return { bin: this.bin, args, okExitCodes: [0, 1] };
}

function toFinding(
  tool: string,
  layer: Layer,
  r: SarifResult,
  ctx: ToolContext,
): Finding {
  const location = r.locations?.[0]?.physicalLocation;
  const uri = location?.artifactLocation?.uri;
  const severity = typeof r.level === "string" ? LEVELS[r.level] : undefined;
  if (
    typeof r.ruleId !== "string" ||
    typeof r.message?.text !== "string" ||
    typeof uri !== "string" ||
    severity === undefined
  )
    throw new Error(
      `${tool} output has a result without a rule id, message, file or known level: its output format may have changed; refusing to report it.`,
    );
  // Biome could not read a file the kit passed it: coverage lost, not a finding.
  if (r.ruleId.startsWith("internalError/"))
    throw new Error(`${tool} could not check ${uri}: ${r.message.text}`);
  const file = absPosix(ctx.cwd, uri);
  const region = location?.region;
  return finding({
    tool,
    layer,
    language: languageForFile(file),
    file,
    line: region?.startLine ?? 1,
    col: region?.startColumn ?? 1,
    ...(region ? { endLine: region.endLine, endCol: region.endColumn } : {}),
    ruleId: r.ruleId,
    severity,
    message: r.message.text,
    // SARIF carries no fix data; a format difference is what --write fixes.
    fixable:
      r.ruleId === "format" && r.message.text.startsWith("Formatter would"),
  });
}

function parse(tool: string, layer: Layer) {
  return (raw: RawOutput, ctx: ToolContext): RunResult => ({
    findings: sarifResults(tool, raw).map((r) =>
      toFinding(tool, layer, r, ctx),
    ),
    filesProcessed: ctx.files?.length ?? 0,
    fixesApplied: 0,
    rawExitCode: raw.exitCode,
    stderr: raw.stderr,
  });
}

const shared = {
  languages: ["ts", "js"],
  bin: "biome",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "2.4.0",
  installHint: "pnpm add -D --save-exact @biomejs/biome",
  parseVersion: (out: string) => /Version:\s*(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // With --no-errors-on-unmatched, exit 1 always came with a result or with
  // no report at all (a config error).
  findingExitCodes: [1],
  // One seed per chunk of the project's TS/JS files; the expansion keeps
  // Biome's and moves each to the folder Biome runs in for it.
  runsAt: "project-root",
  expand: byRootConfig,
} satisfies Partial<ToolAdapter>;

/**
 * Biome's linter, with its assist actions (organizeImports), as `biome check`
 * enforces them; formatting is the biome-format tool's.
 * docs/research/lint-toolchain/biome-cli.md
 */
export const biome: ToolAdapter = {
  id: "biome",
  layer: "lint",
  ...shared,
  buildArgs(ctx) {
    return command.call(this, ctx, ["check", "--formatter-enabled=false"]);
  },
  parseOutput: parse("biome", "lint"),
};

/** Biome's formatter: a file it would print differently is one finding. */
export const biomeFormat: ToolAdapter = {
  id: "biome-format",
  layer: "format",
  ...shared,
  buildArgs(ctx) {
    return command.call(this, ctx, ["format"]);
  },
  parseOutput: parse("biome-format", "format"),
};
