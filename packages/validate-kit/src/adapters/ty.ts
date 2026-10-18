import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { upTo } from "../detect/adoption.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, filesIn, finding, parseFindings } from "./base.js";

interface Point {
  line?: unknown;
  column?: unknown;
}

/** One issue of `--output-format gitlab` (GitLab Code Quality): 1-based, paths relative to the cwd. */
interface Issue {
  check_name?: unknown;
  description?: unknown;
  severity?: unknown;
  location?: { path?: unknown; positions?: { begin?: Point; end?: Point } };
}

/** ty's levels as GitLab names them: error, warning, info. */
const SEVERITY: Record<string, Severity> = {
  major: "error",
  minor: "warning",
  info: "info",
};

/** A `[tool.ty]` table in the folder's pyproject.toml. */
function tyTable(dir: string): boolean {
  try {
    return /^\s*\[tool\.ty[.\]]/m.test(
      readFileSync(join(dir, "pyproject.toml"), "utf8"),
    );
  } catch {
    return false;
  }
}

/**
 * ty — Astral's Python type checker, pre-1.0: flags, rules and output can
 * change between 0.0.x releases, so the kit pins the version it read. Its
 * errors are errors and its warnings warnings (both exit 1). Where the
 * project configured it: a `ty.toml` or a `[tool.ty]` table, which ty looks
 * for from the folder it runs in upward. It finds the project's `.venv`
 * itself. The project's excludes hold for the files the kit names. Recorded
 * on 0.0.86: docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 5.
 */
export const ty: ToolAdapter = {
  id: "ty",
  layer: "type-check",
  languages: ["python"],
  bin: "ty",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.0.86",
  installHint: "brew install ty  (or: uv tool install ty)",
  parseVersion: (out) => /ty (\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    upTo(root, projectRoot).some(
      (dir) => existsSync(join(dir, "ty.toml")) || tyTable(dir),
    ),

  findingExitCodes: [1],

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(--output-format|--fix|--add-ignore|--watch|-W)(=|$)/.test(arg),
    )
      ? "the kit reads ty's GitLab JSON from a check that writes nothing; --output-format changes it, --fix and --add-ignore write into the code"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "check",
        "--output-format",
        "gitlab",
        "--color",
        "never",
        "--no-progress",
        "--force-exclude",
        ...(ctx.configPath ? ["--config-file", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...filesIn(ctx, ["python"]),
      ],
      // 2: a usage or config error, or a path that does not exist.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { items } = parseFindings<Issue>("ty", raw);
    const findings = items.map((issue) => {
      const { check_name: rule, description, location } = issue;
      const severity =
        typeof issue.severity === "string"
          ? SEVERITY[issue.severity]
          : undefined;
      const begin = location?.positions?.begin;
      const end = location?.positions?.end;
      if (
        severity === undefined ||
        typeof rule !== "string" ||
        typeof description !== "string" ||
        typeof location?.path !== "string" ||
        typeof begin?.line !== "number" ||
        typeof begin.column !== "number"
      )
        throw new Error(
          `ty reported an issue without a rule, description, path, position or known severity (${JSON.stringify(issue.severity)}): its output format may have changed; refusing to report it.`,
        );
      const file = absPosix(ctx.cwd, location.path);
      return finding({
        tool: "ty",
        layer: "type-check",
        language: languageForFile(file),
        file,
        line: begin.line,
        col: begin.column,
        ...(typeof end?.line === "number" && typeof end.column === "number"
          ? { endLine: end.line, endCol: end.column }
          : {}),
        ruleId: rule,
        severity,
        // `invalid-argument-type: Argument to function ...`
        message: description.startsWith(`${rule}: `)
          ? description.slice(rule.length + 2)
          : description,
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
