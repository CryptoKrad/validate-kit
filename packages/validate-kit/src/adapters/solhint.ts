import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted, upTo } from "../detect/adoption.js";
import { absPosix, finding, globLiteral, parseFindings } from "./base.js";

interface SolhintReport {
  line?: unknown;
  column?: unknown;
  severity?: unknown;
  message?: unknown;
  ruleId?: unknown;
  filePath?: unknown;
  conclusion?: unknown;
}

/**
 * solhint 6.2.3's cosmiconfig places, searched from where it runs up (its
 * `lib/config/config-file.js`), and a `solhint` key in package.json.
 */
const CONFIGS = [
  ".solhint.json",
  ".solhintrc",
  ".solhintrc.json",
  ".solhintrc.yaml",
  ".solhintrc.yml",
  ".solhintrc.js",
  "solhint.config.js",
];

interface SolhintTask {
  /**
   * The config to name: these files have no `.solhint.json` between them
   * and where it runs, the only place solhint takes rules from by itself.
   */
  config?: string;
  /** A `.solhintignore` or `excludedFiles` may leave every file out. */
  ignorable: boolean;
}

/** The first config solhint's own search finds, from `cwd` up to `top`. */
function baseConfig(cwd: string, top: string): string | undefined {
  for (const dir of upTo(cwd, top)) {
    const name = CONFIGS.find((n) => existsSync(join(dir, n)));
    if (name) return join(dir, name);
    if (toolAdopted(dir, dir, { configs: [], key: "solhint" }))
      return join(dir, "package.json");
  }
  return undefined;
}

/**
 * solhint — Solidity linter: security rules (`tx.origin`, low-level calls,
 * reentrancy patterns), naming, visibility, compiler-version pins, whatever
 * the project's config turns on. Runs on the changed `.sol` files where a
 * solhint config is at or above the Foundry/Hardhat root, or with
 * `tools.solhint.enabled`. solhint reads rules only from the `.solhint.json`
 * files between a file and where it runs (`loadConfigForFile`): for a file
 * with none there, the config its search finds (`.solhintrc*`, a
 * package.json key, a `.solhint.json` above the root) is named with
 * `--config`. A config warning (a misspelt rule or level) is a crash, never
 * a rule silently off. `--disc` stops its update check (a registry call
 * that prints on stdout). Never `--fix`: it waits on stdin for a yes.
 * Recorded on 6.2.3: docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, 4.
 */
export const solhint: ToolAdapter = {
  id: "solhint",
  layer: "lint",
  languages: ["solidity"],
  bin: "solhint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "6.2.3",
  installHint: "pnpm add -D solhint  (or: npm i -g solhint)",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, { configs: CONFIGS, key: "solhint" }),
  // 1 is also an unknown flag, which prints no JSON.
  findingExitCodes: [1],
  // A file that does not parse gets no rule findings.
  masks: (f) => f.ruleId === "parse-error",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const named = env.toolConfig.configPath;
    const base = named ?? baseConfig(seed.cwd, env.projectRoot);
    const ignorable =
      existsSync(join(seed.cwd, ".solhintignore")) ||
      (base !== undefined &&
        existsSync(base) &&
        readFileSync(base, "utf8").includes("excludedFiles"));
    if (named !== undefined) return [{ ...seed, options: { ignorable } }];
    const files = seed.files ?? [];
    const chained = files.filter((file) =>
      upTo(dirname(file), seed.cwd).some((dir) =>
        existsSync(join(dir, ".solhint.json")),
      ),
    );
    const rest = files.filter((file) => !chained.includes(file));
    const tasks: [string[], SolhintTask][] = [
      [chained, { ignorable }],
      [rest, { ignorable, ...(base ? { config: base } : {}) }],
    ];
    return tasks.flatMap(([own, options]) =>
      own.length === 0 ? [] : [{ ...seed, files: own, options }],
    );
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--formatter|--fix|--noPrompt|--save)(=|$)/.test(arg),
    )
      ? "the kit reads solhint's JSON on stdout and never fixes with it (--fix waits on stdin)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("solhint needs the task's file list");
    const config =
      ctx.configPath ?? (ctx.options as SolhintTask | undefined)?.config;
    return {
      bin: this.bin,
      args: [
        "--disc",
        "--formatter",
        "json",
        ...(config ? ["--config", config] : []),
        ...ctx.extraArgs,
        // It globs each name: `Bad[1].sol` would match `Bad1.sol` instead.
        ...files.map((file) => globLiteral("solhint", file)),
      ],
      // 255: no files left to lint, or no or a broken config (parseOutput).
      okExitCodes: [0, 1, 255],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A misspelt rule or level: that rule is off, on any exit.
    const warning = /^\[solhint\] Warning: (.+)$/m.exec(raw.stderr)?.[1];
    if (warning) throw new Error(`solhint's config is invalid: ${warning}`);
    if (raw.exitCode === 255) {
      const text = `${raw.stderr}\n${raw.stdout}`.trim();
      // Every file it was given exists and is named literally: its ignore
      // list left out them all.
      if (
        text.startsWith("No files to lint!") &&
        (ctx.options as SolhintTask | undefined)?.ignorable === true
      )
        return {
          findings: [],
          filesProcessed: 0,
          fixesApplied: 0,
          rawExitCode: 0,
          stderr: raw.stderr,
        };
      throw new Error(
        `solhint failed with exit 255: ${text.split("\n")[0] || "no output"}`,
      );
    }
    const { items } = parseFindings<SolhintReport>("solhint", raw);
    const findings = items.flatMap((r) => {
      // Its last element is a summary, not a finding.
      if ("conclusion" in r && !("line" in r)) return [];
      if (
        typeof r.filePath !== "string" ||
        typeof r.line !== "number" ||
        typeof r.column !== "number" ||
        typeof r.message !== "string" ||
        (r.severity !== "Error" && r.severity !== "Warning")
      )
        throw new Error(
          `solhint output has a report without a file, position, message or known severity (${JSON.stringify(r.severity)}): its output format may have changed; refusing to report it.`,
        );
      // A parse error has no rule, and its column is 0-based (the parser's).
      const rule = typeof r.ruleId === "string" ? r.ruleId : undefined;
      return [
        finding({
          tool: "solhint",
          layer: "lint",
          language: "solidity",
          file: absPosix(ctx.cwd, r.filePath),
          line: r.line,
          col: rule === undefined ? r.column + 1 : r.column,
          ruleId: rule ?? "parse-error",
          severity: r.severity === "Error" ? "error" : "warning",
          message: r.message,
          fixable: false,
        }),
      ];
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
