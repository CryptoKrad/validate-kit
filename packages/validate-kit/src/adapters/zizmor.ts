import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, charColumn, finding, findingsArray } from "./base.js";

interface Point {
  row?: unknown;
  column?: unknown;
}

interface ZizmorLocation {
  symbolic?: {
    key?: { Local?: { verbatim_path?: unknown } };
    annotation?: unknown;
    kind?: unknown;
  };
  concrete?: { location?: { start_point?: Point; end_point?: Point } };
}

interface ZizmorFinding {
  ident?: unknown;
  desc?: unknown;
  url?: unknown;
  ignored?: unknown;
  determinations?: { severity?: unknown; confidence?: unknown };
  locations?: ZizmorLocation[];
}

/** zizmor's own config names and where it looks (docs.zizmor.sh/configuration). */
const CONFIGS = [
  ".github/zizmor.yml",
  ".github/zizmor.yaml",
  "zizmor.yml",
  "zizmor.yaml",
];

interface ZizmorTask {
  /** The kit's `ignore` globs: zizmor walks the whole tree from `.`. */
  ignore: string[];
}

/** What zizmor audits: workflows, action definitions, Dependabot config. */
const INPUT =
  /^\.github\/(?:workflows\/[^/]+\.ya?ml|dependabot\.ya?ml)$|(?:^|\/)(?:action|zizmor)\.ya?ml$/;

const SEVERITY: Record<string, Severity> = {
  High: "error",
  Medium: "error",
  Low: "warning",
};

/** zizmor's 0-based row and byte column as a 1-based line, and the byte. */
function point(
  p: Point | undefined,
): { line: number; byte: number } | undefined {
  return typeof p?.row === "number" && typeof p.column === "number"
    ? { line: p.row + 1, byte: p.column }
    : undefined;
}

/**
 * zizmor — static analysis of GitHub Actions: template injection, permissions
 * wider than a job needs, credentials left in the checkout, cache poisoning in
 * a publishing job, unpinned or impostor actions. actionlint checks a
 * workflow's syntax and SHA pinning fixes which code runs; neither sees
 * these. Run offline (no token, no network), where the project chose it:
 * a zizmor config, `tools.zizmor.enabled`, or a step that runs it. Recorded
 * on 1.30.1: docs/research/lint-toolchain/hygiene-adapters.md.
 */
export const zizmor: ToolAdapter = {
  id: "zizmor",
  layer: "security",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "zizmor",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.26.0",
  installHint: "brew install zizmor  (or: uv tool install zizmor)",
  parseVersion: (out) => /zizmor (\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    // A project-level tool: the planner checks no adoption for it.
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: CONFIGS,
        step: /(?:^|[\s;&|"'(/])zizmor(?:\s|$)|\bzizmor-action@/m,
      });
    if (!chosen) return [];
    const workflows = join(root, ".github", "workflows");
    const any =
      existsSync(workflows) &&
      readdirSync(workflows).some((name) => /\.ya?ml$/.test(name));
    if (
      !any &&
      !existsSync(join(root, "action.yml")) &&
      !existsSync(join(root, "action.yaml"))
    )
      return [];
    // A change that touches no workflow, action or Dependabot file gives it
    // nothing new to read.
    if (
      env.changedPaths &&
      !env.changedPaths.some((path) => INPUT.test(toPosix(path)))
    )
      return [];
    const task: ZizmorTask = { ignore: [...env.config.ignore] };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(format|no-exit-codes)(=|$)/.test(arg))
      ? "--format and --no-exit-codes replace the output and exit codes the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--offline",
        "--format",
        "json",
        "--no-progress",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ".",
      ],
      okExitCodes: [0, 11, 12, 13, 14],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const items = findingsArray<ZizmorFinding>(
      "zizmor",
      JSON.parse(raw.stdout || "null"),
    );
    // 11-14: findings, by the highest severity among them. Checked before the
    // kit's ignore list drops any (the runner's own check would see none).
    if (raw.exitCode >= 11 && !items.some((item) => item.ignored !== true))
      throw new Error(
        `zizmor exited ${raw.exitCode}, which means it reported findings, but its output holds none: its output format may have changed; refusing to report it.`,
      );
    const findings: Finding[] = [];
    // A workflow under an ignored folder (a fixture) is not the project's.
    const ignore = (ctx.options as ZizmorTask | undefined)?.ignore ?? [];
    const ignored =
      ignore.length > 0 ? picomatch(ignore, { dot: true }) : () => false;
    // zizmor counts columns in bytes; the kit in characters.
    const sources = new Map<string, string[] | undefined>();
    const linesOf = (file: string): string[] | undefined => {
      if (!sources.has(file))
        sources.set(
          file,
          existsSync(file) ? readFileSync(file, "utf8").split("\n") : undefined,
        );
      return sources.get(file);
    };
    for (const item of items) {
      if (item.ignored === true) continue;
      const located = item.locations ?? [];
      const primary =
        located.find((l) => l.symbolic?.kind === "Primary") ?? located[0];
      const path = primary?.symbolic?.key?.Local?.verbatim_path;
      const start = point(primary?.concrete?.location?.start_point);
      if (typeof item.ident !== "string" || typeof path !== "string" || !start)
        throw new Error(
          "zizmor reported a finding without an audit, file or position: its output format may have changed; refusing to report it.",
        );
      const end = point(primary?.concrete?.location?.end_point);
      const severity = item.determinations?.severity;
      const confidence = item.determinations?.confidence;
      const annotation = primary?.symbolic?.annotation;
      const file = absPosix(cwd, path);
      if (ignored(posix.relative(cwd, file))) continue;
      const lines = linesOf(file);
      findings.push(
        finding({
          tool: "zizmor",
          layer: "security",
          file,
          line: start.line,
          col: charColumn(lines, start.line, start.byte),
          ...(end
            ? {
                endLine: end.line,
                endCol: charColumn(lines, end.line, end.byte),
              }
            : {}),
          ruleId: item.ident,
          severity:
            (typeof severity === "string" ? SEVERITY[severity] : undefined) ??
            "info",
          message: [
            typeof item.desc === "string" ? item.desc : item.ident,
            typeof annotation === "string" ? `: ${annotation}` : "",
            typeof confidence === "string"
              ? ` (${confidence.toLowerCase()} confidence)`
              : "",
          ].join(""),
          fixable: false,
          ...(typeof item.url === "string" ? { url: item.url } : {}),
        }),
      );
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
