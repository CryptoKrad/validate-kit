import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, escapeRegex, finding, toolOptions } from "./base.js";

/** The config files `--config` finds without a name (dependency-cruiser 16+). */
const CONFIGS = [
  ".dependency-cruiser.js",
  ".dependency-cruiser.cjs",
  ".dependency-cruiser.mjs",
  ".dependency-cruiser.json",
];

interface Violation {
  type?: string;
  from?: string;
  to?: string;
  unresolvedTo?: string;
  cycle?: { name?: string }[] | string[];
  rule?: { name?: string; severity?: string };
}

interface Report {
  modules?: { source?: string }[];
  summary?: {
    environment?: {
      transpilersFound?: {
        name?: string;
        version?: string;
        available?: boolean;
      }[];
    };
    violations?: Violation[];
    ruleSetUsed?: {
      forbidden?: { name?: string; comment?: string }[];
      required?: { name?: string; comment?: string }[];
    };
  };
}

const Options = z
  .object({
    /** What to cruise, relative to the project root (default: src/). */
    paths: z.array(z.string()).optional(),
  })
  .strict();

interface CruiseTask {
  /** What dependency-cruiser starts from, relative to the project root. */
  paths: string[];
  /** The TS/JS files in the kit's scope, relative: a finding elsewhere is not the kit's. */
  scope: string[];
}

/** A TypeScript source, not a declaration file. */
const isTs = (file: string): boolean => /(?<!\.d)\.[cm]?tsx?$/.test(file);

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warn: "warning",
  info: "info",
};

/**
 * The line of `file` that imports `specifier`: dependency-cruiser's report
 * names the module, not the line. A comment that quotes it is not the
 * import.
 */
function importLine(file: string, specifier: string | undefined): number {
  if (!specifier) return 1;
  try {
    const quoted = new RegExp(`["'\`]${escapeRegex(specifier)}["'\`]`);
    const at = readFileSync(file, "utf8")
      .split("\n")
      .findIndex(
        (line) =>
          quoted.test(line) &&
          !/^\s*(\/\/|\/?\*)/.test(line) &&
          /\b(import|from|require|export)\b/.test(line),
      );
    return at < 0 ? 1 : at + 1;
  } catch {
    return 1;
  }
}

/**
 * dependency-cruiser — the project's own rules on which module may import
 * which (the UI never the database layer, no cycles), read from its
 * `.dependency-cruiser.*` config. It resolves imports through TypeScript and
 * the installed packages, so it runs on the whole scope, in the `verify`
 * tier. Each violation is reported at the import's line in the importing
 * file, with the rule's comment as the reason. Recorded on 18.6.0:
 * docs/research/lint-toolchain/layer-rules.md.
 */
export const dependencyCruiser: ToolAdapter = {
  id: "dependency-cruiser",
  layer: "lint",
  languages: ["ts", "js"],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "depcruise",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "18.0.0",
  installHint: "pnpm add -D dependency-cruiser",
  // A config file adopts it: the package alone, hoisted to a monorepo's
  // root, leaves `--config` nothing to read.
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, { configs: CONFIGS }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = toPosix(env.projectRoot);
    const scope = env.scopedFiles
      .map(toPosix)
      .filter((file) => {
        const language = languageForFile(file);
        return language === "ts" || language === "js";
      })
      .map((file) =>
        file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file,
      );
    if (scope.length === 0) return [];
    const config = env.config.tools["dependency-cruiser"]?.configPath;
    if (!config && !CONFIGS.some((name) => existsSync(join(seed.cwd, name))))
      return [
        {
          ...seed,
          cannotRun: `no ${CONFIGS.join(", ")} here and no tools.dependency-cruiser.configPath: it has no rules to check`,
        },
      ];
    // A .ts file is parsed by the project's own TypeScript; without the
    // installed packages it is skipped and the run is clean for nothing.
    if (!existsSync(join(seed.cwd, "node_modules")))
      return [
        {
          ...seed,
          cannotRun:
            "the dependencies are not installed (no node_modules): dependency-cruiser parses TypeScript and resolves imports through them",
        },
      ];
    // Where to start: what the project names, else src/, else each
    // top-level folder that holds code. Never every file: a root config
    // file passed by name is an orphan, and a large project's list does not
    // fit on a command line.
    const isDir = (path: string) => {
      try {
        return statSync(join(seed.cwd, path)).isDirectory();
      } catch {
        return false;
      }
    };
    const named = toolOptions(env, "dependency-cruiser", Options).paths;
    const tops = [
      ...new Set(
        scope
          .filter((file) => file.includes("/"))
          .map((file) => file.split("/")[0] ?? ""),
      ),
    ].toSorted();
    const paths = named ?? (isDir("src") ? ["src"] : tops);
    if (paths.length === 0) return [];
    const task: CruiseTask = { paths, scope };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-T|--output-type|-f|--output-to|-i|--info|--init)(=|$)/.test(arg),
    )
      ? "--output-type, --output-to, --info and --init change the JSON report the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as CruiseTask;
    const args = ["--output-type", "json", "--config"];
    if (ctx.configPath) args.push(ctx.configPath);
    args.push(...ctx.extraArgs, "--", ...task.paths);
    // The json reporter exits 0 with violations; they are in the summary.
    return { bin: this.bin, args, okExitCodes: [0] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as CruiseTask;
    let report: Report;
    try {
      report = JSON.parse(raw.stdout) as Report;
    } catch {
      throw new Error(
        `dependency-cruiser printed no JSON report${raw.stderr.trim() ? `: ${raw.stderr.trim().split("\n").at(-1) ?? ""}` : ""}`,
      );
    }
    const summary = report.summary;
    if (!summary || !Array.isArray(summary.violations))
      throw new Error(
        "dependency-cruiser's report has no summary.violations: its output format may have changed; refusing to report it.",
      );
    // It parses TypeScript with the project's `typescript`, below 7 only.
    // Without one it skips every .ts file and reports no violations: a pass
    // that checked nothing (TypeScript 7 is npm's latest). Its report says
    // whether it found one; a report without that says it by cruising none.
    const under = (file: string) =>
      task.paths.some((path) => {
        const top = posix.normalize(path).replace(/(.)\/+$/, "$1");
        return top === "." || file === top || file.startsWith(`${top}/`);
      });
    const compiler = summary.environment?.transpilersFound?.find(
      (t) => t.name === "typescript",
    );
    const unread = compiler
      ? compiler.available === false
      : !(report.modules ?? []).some((m) => isTs(m.source ?? ""));
    if (unread && task.scope.some((file) => isTs(file) && under(file)))
      throw new Error(
        `dependency-cruiser read none of the TypeScript files under ${task.paths.join(", ")}: it needs the project's \`typescript\` ${compiler?.version ?? "below 7"}, and found none it can use`,
      );
    const reasons = new Map(
      [
        ...(summary.ruleSetUsed?.forbidden ?? []),
        ...(summary.ruleSetUsed?.required ?? []),
      ].flatMap((rule) =>
        rule.name && rule.comment ? [[rule.name, rule.comment] as const] : [],
      ),
    );
    const scope = new Set(task.scope);
    const findings: Finding[] = summary.violations.flatMap((v) => {
      const severity = SEVERITY[v.rule?.severity ?? ""];
      if (!severity || !v.from) return [];
      // The kit's `ignore` (fixtures, generated code) holds here too; a
      // folder rule names a folder with code in scope.
      if (
        !scope.has(v.from) &&
        !task.scope.some((file) =>
          file.startsWith(`${posix.normalize(v.from ?? "")}/`),
        )
      )
        return [];
      const file = absPosix(ctx.cwd, v.from);
      const name = v.rule?.name ?? "violation";
      const edge =
        v.type === "cycle" && Array.isArray(v.cycle)
          ? [
              v.from,
              ...v.cycle.map((c) => (typeof c === "string" ? c : c.name)),
            ]
              .filter(Boolean)
              .join(" → ")
          : v.to && v.to !== v.from
            ? `${v.from} → ${v.to}`
            : v.from;
      const reason = reasons.get(name);
      return [
        finding({
          tool: "dependency-cruiser",
          layer: "lint",
          language: languageForFile(file),
          file,
          line: importLine(file, v.unresolvedTo),
          col: 1,
          ruleId: name,
          severity,
          message: reason ? `${edge}: ${reason}` : edge,
          fixable: false,
        }),
      ];
    });
    return {
      findings,
      filesProcessed: task.scope.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
