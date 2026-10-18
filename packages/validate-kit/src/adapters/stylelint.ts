import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, byConfigFolder, finding, findingsArray } from "./base.js";

interface StylelintWarning {
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  rule?: unknown;
  severity?: unknown;
  text?: unknown;
}

interface StylelintResult {
  source?: unknown;
  invalidOptionWarnings?: { text?: unknown }[];
  warnings?: StylelintWarning[];
}

/**
 * Where stylelint 17.16.0 looks for its config, from each file's folder up:
 * cosmiconfig's default places for "stylelint" (read in its source), and a
 * `stylelint` key in package.json.
 */
const CONFIGS = [
  ".stylelintrc",
  ".stylelintrc.json",
  ".stylelintrc.yaml",
  ".stylelintrc.yml",
  ".stylelintrc.js",
  ".stylelintrc.ts",
  ".stylelintrc.cjs",
  ".stylelintrc.mjs",
  ".config/stylelintrc",
  ".config/stylelintrc.json",
  ".config/stylelintrc.yaml",
  ".config/stylelintrc.yml",
  ".config/stylelintrc.js",
  ".config/stylelintrc.ts",
  ".config/stylelintrc.cjs",
  ".config/stylelintrc.mjs",
  "stylelint.config.js",
  "stylelint.config.ts",
  "stylelint.config.cjs",
  "stylelint.config.mjs",
];

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The stylelint config a task runs with, as text: `configPath`, or `dir`'s. */
function configText(configPath: string | undefined, dir: string): string {
  if (configPath) return read(configPath);
  let key = "";
  try {
    key = JSON.stringify(
      (JSON.parse(read(join(dir, "package.json"))) as { stylelint?: unknown })
        .stylelint ?? "",
    );
  } catch {
    // no package.json, or not JSON: no key
  }
  return [...CONFIGS.map((name) => read(join(dir, name))), key].join("\n");
}

/**
 * stylelint — CSS linter: unknown properties, invalid values, empty blocks,
 * selectors that cannot match, whatever rules the project's config turns on
 * (with no config it has no rules, so it is never run without one). Runs on
 * the changed `.css` files that have a stylelint config in their folder or
 * above (and `.scss`/`.less`/`.sass` ones where that config names their
 * syntax: without it stylelint parses them as CSS), or everywhere with
 * `tools.stylelint.enabled`. It runs from that config's folder, so the
 * package's own `node_modules/.bin/stylelint` comes first (a global one
 * cannot load the project's `customSyntax` or `extends` packages) and its
 * `.stylelintignore` is read. `--fix` is its own rewrites (`0px` -> `0`).
 * Recorded on
 * 17.16.0: docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, 1.
 */
export const stylelint: ToolAdapter = {
  id: "stylelint",
  layer: "lint",
  languages: ["css"],
  bin: "stylelint",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "17.16.0",
  installHint: "pnpm add -D stylelint stylelint-config-standard",
  // 2: an error finding (a warning-only run exits 0).
  findingExitCodes: [2],

  expand: (seed, env) =>
    byConfigFolder(seed, env, "css", CONFIGS, { key: "stylelint" }).flatMap(
      (task) => {
        // shortcut: a syntax set by a shared config not named for it (a local
        // `extends: "./base.js"`) leaves those files out; read
        // `stylelint --print-config` if one is ever missed.
        const text = configText(env.toolConfig.configPath, task.cwd);
        const files = (task.files ?? []).filter((file) => {
          const syntax = /\.(scss|less|sass)$/i.exec(file)?.[1];
          return syntax === undefined || text.includes(syntax.toLowerCase());
        });
        return files.length === 0 ? [] : [{ ...task, files }];
      },
    ),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--formatter|--custom-formatter|-o|--output-file)(=|$)/.test(arg),
    )
      ? "the kit reads stylelint's JSON report on stderr; --formatter and --output-file change it"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("stylelint needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "--formatter",
        "json",
        // Every file exists: no input left is the project's
        // .stylelintignore, not a missing file (exit 1 otherwise).
        "--allow-empty-input",
        ...(ctx.fix ? ["--fix"] : []),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...files,
      ],
      // 1 no files, 64 usage, 78 config: crashes, with the reason on stderr.
      okExitCodes: [0, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // The JSON goes to stderr; a crash's message too.
    const text = raw.stderr.trim();
    if (!text.startsWith("["))
      throw new Error(
        `stylelint printed no JSON report on exit ${raw.exitCode}${text ? `: ${text.split("\n")[0] ?? ""}` : ""}`,
      );
    const results = findingsArray<StylelintResult>(
      "stylelint",
      JSON.parse(text),
    );
    const findings = results.flatMap((result) => {
      // A rule given an option it does not take checks nothing.
      const invalid = result.invalidOptionWarnings?.[0]?.text;
      if (typeof invalid === "string")
        throw new Error(`stylelint's config is invalid: ${invalid}`);
      if (typeof result.source !== "string" || !Array.isArray(result.warnings))
        throw new Error(
          "stylelint output has a result without a source or warnings: its output format may have changed; refusing to report zero findings.",
        );
      const file = absPosix(ctx.cwd, result.source);
      return result.warnings.map((w) => {
        if (
          typeof w.line !== "number" ||
          typeof w.column !== "number" ||
          typeof w.rule !== "string" ||
          typeof w.text !== "string" ||
          (w.severity !== "error" && w.severity !== "warning")
        )
          throw new Error(
            `stylelint output has a warning without a position, rule, text or known severity (${JSON.stringify(w.severity)}): its output format may have changed; refusing to report it.`,
          );
        return finding({
          tool: "stylelint",
          layer: "lint",
          language: "css",
          file,
          line: w.line,
          col: w.column,
          ...(typeof w.endLine === "number" && typeof w.endColumn === "number"
            ? { endLine: w.endLine, endCol: w.endColumn }
            : {}),
          ruleId: w.rule,
          severity: w.severity,
          // The text ends with the rule id, which the finding carries.
          message: w.text.replace(` (${w.rule})`, ""),
          fixable: false,
          // A plugin's rule is `plugin/name`; stylelint's own are documented.
          ...(/^[a-z-]+$/.test(w.rule)
            ? { url: `https://stylelint.io/user-guide/rules/${w.rule}` }
            : {}),
        });
      });
    });
    return {
      findings,
      filesProcessed: results.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      // Its stderr is the report just read.
      stderr: "",
    };
  },
};
