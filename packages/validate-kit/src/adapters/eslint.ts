import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import {
  absPosix,
  filesIn,
  finding,
  findingsArray,
  parseFindings,
  quietWithWarningLimit,
} from "./base.js";

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fix?: unknown;
}
interface EslintFile {
  filePath: string;
  messages: EslintMessage[];
}

// ESLint's names, in its order of precedence within one folder.
const CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

/**
 * The config a project's own extra arguments choose, as ESLint reads them
 * (lib/shared/translate-cli-options.js, `overrideConfigFile`): the last
 * `--config <path>` (`-c`, `--config=<path>`) from the run's folder, whatever
 * the lookup flags say; without one, the last of `--config-lookup` and
 * `--no-config-lookup` decides, and no lookup means no config (null).
 * Undefined when they choose nothing.
 */
function argsConfig(
  extraArgs: readonly string[],
  cwd: string,
): string | null | undefined {
  let config: string | undefined;
  // Set inside the callback, which TypeScript's narrowing does not follow.
  let lookup = true as boolean;
  extraArgs.forEach((arg, i) => {
    if (arg === "--no-config-lookup") lookup = false;
    if (arg === "--config-lookup") lookup = true;
    const value =
      /^(?:--config|-c)=(.+)$/.exec(arg)?.[1] ??
      (arg === "--config" || arg === "-c" ? extraArgs[i + 1] : undefined);
    if (value !== undefined) config = resolve(cwd, value);
  });
  if (config !== undefined) return config;
  return lookup ? undefined : null;
}

/** The nearest flat config at or above `dir`, as ESLint 10 finds one. */
function configAtOrAbove(dir: string): string | undefined {
  let current = dir;
  for (let i = 0; i < 12; i++) {
    const found = CONFIGS.map((c) => join(current, c)).find((path) =>
      existsSync(path),
    );
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function hasConfigAtOrAbove(root: string): boolean {
  return configAtOrAbove(root) !== undefined;
}

/** eslint (flat config) — the deep, plugin-rich JS/TS lint layer. Optional: only
 * runs when an eslint flat config is present in the language root. */
export const eslint: ToolAdapter = {
  id: "eslint",
  layer: "lint",
  languages: ["ts", "js"],
  bin: "eslint",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "9.0.0",
  installHint: "pnpm add -D eslint typescript-eslint",
  parseVersion: (out) => /v?(\d+\.\d+\.\d+)/.exec(out)?.[1],

  detect: (detection) => {
    const roots = [
      ...(detection.get("ts")?.roots ?? []),
      ...(detection.get("js")?.roots ?? []),
    ];
    return roots.some(hasConfigAtOrAbove);
  },

  // Each root needs its own flat config (at or above it): one package's
  // config does not make ESLint runnable in its siblings.
  expand: (seed) => (hasConfigAtOrAbove(seed.cwd) ? [seed] : []),

  // Exit 1: findings reported (recorded on the installed version).
  findingExitCodes: [1],

  // ESLint 10 looks up the flat config from each file's folder
  // (docs/research/lint-toolchain/eslint-config-lookup.md).
  configFor: (found, ctx) => {
    const chosen = argsConfig(ctx.extraArgs, ctx.cwd);
    if (chosen !== undefined) return chosen ?? undefined;
    return ctx.configPath ?? configAtOrAbove(dirname(found.file));
  },

  refuseArgs: (extraArgs) =>
    quietWithWarningLimit(extraArgs, ["--max-warnings"]),

  buildArgs(ctx: ToolContext): BuiltCommand {
    // --no-warn-ignored: don't emit "File ignored because of a matching ignore
    // pattern" pseudo-findings (no rule, no line) for explicitly-passed files
    // that the flat config ignores — they are noise and have no SARIF location.
    const args = ["--format", "json", "--no-warn-ignored"];
    if (ctx.fix) args.push("--fix");
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(...ctx.extraArgs, ...filesIn(ctx, ["ts", "js"]));
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items: files } = parseFindings<EslintFile>("eslint", raw);
    const findings = [];
    for (const f of files) {
      const file = absPosix(ctx.cwd, f.filePath);
      const lang = languageForFile(file);
      for (const m of findingsArray<EslintMessage>("eslint", f, "messages")) {
        findings.push(
          finding({
            tool: "eslint",
            layer: "lint",
            language: lang,
            file,
            line: m.line,
            col: m.column,
            ...(m.endLine !== undefined ? { endLine: m.endLine } : {}),
            ...(m.endColumn !== undefined ? { endCol: m.endColumn } : {}),
            ...(m.ruleId ? { ruleId: m.ruleId } : {}),
            severity: m.severity === 2 ? "error" : "warning",
            message: m.message,
            fixable: m.fix !== undefined,
          }),
        );
      }
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
