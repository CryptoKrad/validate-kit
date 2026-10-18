import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  byConfigFolder,
  finding,
  globLiteral,
  parseFindings,
} from "./base.js";

interface HtmlValidateMessage {
  ruleId?: unknown;
  severity?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  ruleUrl?: unknown;
}

interface HtmlValidateResult {
  filePath?: unknown;
  messages?: HtmlValidateMessage[];
  source?: unknown;
}

/**
 * The config files html-validate 11.16.4 read, from each file's folder up
 * (a `package.json` key and `html-validate.config.json` were not).
 */
const CONFIGS = [
  ".htmlvalidate.json",
  ".htmlvalidate.js",
  ".htmlvalidate.cjs",
  ".htmlvalidate.mjs",
];

/** A Node error line in a crash's stack (`SchemaValidationError: ...`). */
function crashLine(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^\w*Error\b/.test(line)) ?? lines[0];
}

/**
 * html-validate — offline HTML validator: elements closed in the wrong
 * place, a block inside a `<p>`, duplicate ids, attributes an element does
 * not take, images without alt text. Runs on the changed `.html`/`.htm`
 * files (it parses any file it is named as HTML, a Vue template included)
 * that have an html-validate config in their folder or above, from that
 * config's folder (where the package's own copy and its ignore file are),
 * or everywhere with `tools.html-validate.enabled`. Recorded on 11.16.4:
 * docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, 2.
 */
export const htmlValidate: ToolAdapter = {
  id: "html-validate",
  layer: "lint",
  languages: ["html"],
  bin: "html-validate",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "11.16.4",
  installHint: "pnpm add -D html-validate",
  parseVersion: (out) => /html-validate-(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // 1 is also a usage error or a bad config: those print no JSON.
  findingExitCodes: [1],

  expand: (seed, env) => byConfigFolder(seed, env, "html", CONFIGS),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-f|--formatter|--fix|--stdin)(=|$)/.test(arg))
      ? "the kit reads html-validate's JSON report on the files it names; --formatter, --fix and --stdin change that"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("html-validate needs the task's file list");
    return {
      bin: this.bin,
      args: [
        "--formatter",
        "json",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        // It globs each name: `a[1].html` would match `a1.html` instead.
        ...files.map((file) => globLiteral("html-validate", file)),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Every file it was given exists: its ignore file left out them all.
    if (
      raw.exitCode === 1 &&
      raw.stderr.startsWith("No files matching patterns")
    )
      return {
        findings: [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: 0,
        stderr: raw.stderr,
      };
    if (raw.exitCode !== 0 && !raw.stdout.trim().startsWith("["))
      throw new Error(
        `html-validate failed with exit ${raw.exitCode}: ${crashLine(raw.stderr) ?? "no output"}`,
      );
    const { items } = parseFindings<HtmlValidateResult>("html-validate", raw);
    const findings = items.flatMap((result) => {
      if (
        typeof result.filePath !== "string" ||
        !Array.isArray(result.messages)
      )
        throw new Error(
          "html-validate output has a result without a filePath or messages: its output format may have changed; refusing to report zero findings.",
        );
      // A config problem (an unknown rule) comes as a result for no file.
      if (result.filePath === "undefined" || result.source === null)
        throw new Error(
          `html-validate's config is invalid: ${result.messages.map((m) => String(m.message)).join("; ")}`,
        );
      const file = absPosix(ctx.cwd, result.filePath);
      return result.messages.map((m) => {
        if (
          typeof m.ruleId !== "string" ||
          typeof m.message !== "string" ||
          typeof m.line !== "number" ||
          typeof m.column !== "number" ||
          (m.severity !== 1 && m.severity !== 2)
        )
          throw new Error(
            `html-validate output has a message without a rule, text, position or known severity (${JSON.stringify(m.severity)}): its output format may have changed; refusing to report it.`,
          );
        return finding({
          tool: "html-validate",
          layer: "lint",
          language: "html",
          file,
          line: m.line,
          col: m.column,
          ruleId: m.ruleId,
          severity: m.severity === 2 ? "error" : "warning",
          message: m.message,
          fixable: false,
          ...(typeof m.ruleUrl === "string" ? { url: m.ruleUrl } : {}),
        });
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
