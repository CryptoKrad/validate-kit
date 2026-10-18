import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted, upTo } from "../detect/adoption.js";
import { absPosix, filesIn, finding, parseFindings } from "./base.js";

interface Position {
  line?: unknown;
  character?: unknown;
}

/** One diagnostic of `--outputjson`: positions 0-based, `file` absolute. */
interface Diagnostic {
  file?: unknown;
  severity?: unknown;
  message?: unknown;
  range?: { start?: Position; end?: Position };
  rule?: unknown;
}

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  information: "info",
};

/**
 * Node's own warnings and their hint: the only stderr a check that works
 * may carry. basedpyright prints a config it cannot parse, or a value it
 * rejects, there and then checks on its defaults (every recorded run that
 * worked has an empty stderr).
 */
const NODE_WARNING = /^\(node:\d+\)|^\(Use `node --trace-/;

/** A 0-based position as the kit's 1-based line and column. */
function point(p: Position | undefined): { line: number; col: number } {
  if (typeof p?.line !== "number" || typeof p.character !== "number")
    throw new Error(
      "basedpyright reported a diagnostic without a position: its output format may have changed; refusing to report it.",
    );
  return { line: p.line + 1, col: p.character + 1 };
}

/**
 * basedpyright — the Python type checker (pyright with stricter checks), on
 * the project's settings. Errors are errors, warnings warnings. Where the
 * project configured it: a `pyrightconfig.json`, a `[tool.basedpyright]` or
 * `[tool.pyright]` table in pyproject.toml, basedpyright in pyproject.toml,
 * or a step that runs it; without one it would check on its own
 * "recommended" level, stricter than anyone chose. Found in the project's
 * `.venv` first, and finds that environment itself. A config it cannot
 * read, or a value in it that it rejects, is a crash: basedpyright says so
 * on stderr, then checks without it.
 * Recorded on 1.40.2: docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 4.
 */
export const basedpyright: ToolAdapter = {
  id: "basedpyright",
  layer: "type-check",
  languages: ["python"],
  bin: "basedpyright",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "1.40.2",
  installHint: "brew install basedpyright  (or: uv add --dev basedpyright)",
  parseVersion: (out) => /basedpyright (\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["pyrightconfig.json"],
      // Also its [tool.basedpyright] table.
      dep: "basedpyright",
      pyproject: true,
      step: /(?:^|[\s;&|"'(/])basedpyright(?:\s|$)/m,
    }) ||
    upTo(root, projectRoot).some((dir) => {
      try {
        const text = readFileSync(join(dir, "pyproject.toml"), "utf8");
        return /^\s*\[tool\.pyright[.\]]/m.test(text);
      } catch {
        return false;
      }
    }),

  // 1: errors (warnings alone exit 0).
  findingExitCodes: [1],

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--outputjson|--writebaseline|--gitlabcodequality|--createstub|--verifytypes|--watch|-w|--verbose|--stats|--dependencies|-)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads basedpyright's JSON from a check that writes nothing; these flags change the output or write files"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--outputjson",
        ...(ctx.configPath ? ["--project", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...filesIn(ctx, ["python"]),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const said = raw.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !NODE_WARNING.test(line));
    if (said.length > 0)
      throw new Error(
        `basedpyright did not check on the project's settings: ${said.findLast((line) => /config/i.test(line)) ?? said[0] ?? ""}`,
      );
    const { items } = parseFindings<Diagnostic>(
      "basedpyright",
      raw,
      "generalDiagnostics",
    );
    const findings = items.map((d) => {
      const severity =
        typeof d.severity === "string" ? SEVERITY[d.severity] : undefined;
      if (
        severity === undefined ||
        typeof d.file !== "string" ||
        typeof d.message !== "string"
      )
        throw new Error(
          `basedpyright reported a diagnostic without a file, message or known severity (${JSON.stringify(d.severity)}): its output format may have changed; refusing to report it.`,
        );
      const start = point(d.range?.start);
      const end = point(d.range?.end);
      return finding({
        tool: "basedpyright",
        layer: "type-check",
        language: "python",
        file: absPosix(ctx.cwd, d.file),
        line: start.line,
        col: start.col,
        endLine: end.line,
        endCol: end.col,
        ...(typeof d.rule === "string" ? { ruleId: d.rule } : {}),
        severity,
        // The first line says what is wrong; the rest is the type detail.
        message: d.message.split("\n")[0] ?? d.message,
        fixable: false,
      });
    });
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
