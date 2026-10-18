import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { absPosix, filesIn, finding, parseJsonLine } from "./base.js";

interface MypyError {
  file: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
  message: string;
  hint?: string | null;
  code?: string | null;
  severity: string;
}

/** The project's own interpreter, so mypy sees the packages it installed. */
function venvPython(root: string): string | undefined {
  return [
    join(root, ".venv", "bin", "python"),
    join(root, ".venv", "Scripts", "python.exe"),
  ].find((path) => existsSync(path));
}

/** `file:line: error: message  [code]`: what mypy prints when it cannot parse. */
const BLOCKING = /^(.+?):(\d+): error: (.+?)(?:\s+\[([\w-]+)\])?$/;

/**
 * mypy — the Python type checker. Runs where the repository configured it
 * (a `[tool.mypy]` table or mypy in pyproject.toml, `mypy.ini`, a step that
 * runs it), so its strictness is the project's: `strict = true` there.
 */
export const mypy: ToolAdapter = {
  id: "mypy",
  layer: "type-check",
  languages: ["python"],
  bin: "mypy",
  supportsFix: false,
  fixWriteBack: false,
  minVersion: "1.11.0",
  installHint: "uv tool install mypy  (or: brew install mypy)",
  parseVersion: (out) => /mypy\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["mypy.ini", ".mypy.ini"],
      dep: "mypy",
      pyproject: true,
      step: /(?:^|[\s;&|"'(/])mypy(?:\s|$)/m,
    }),
  // A file mypy cannot parse stops the whole run (exit 2).
  masks: (f) => f.ruleId === "syntax",

  // Exit 1: type errors reported (recorded on mypy 2.0.0).
  findingExitCodes: [1],

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^(-O|--output)(=|$)/.test(arg)))
      return "--output replaces the JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    // The null cache: a check must not write .mypy_cache into the project.
    const args = ["--output", "json", "--cache-dir", devNull];
    const python = venvPython(ctx.cwd);
    if (python) args.push("--python-executable", python);
    if (ctx.configPath) args.push("--config-file", ctx.configPath);
    args.push(...ctx.extraArgs, ...filesIn(ctx, ["python"]));
    // 2: a file that does not parse, or a usage error (text, not JSON).
    return { bin: this.bin, args, okExitCodes: [0, 1, 2] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    if (raw.exitCode === 2) {
      const lines = `${raw.stdout}\n${raw.stderr}`.split(/\r?\n/);
      // A blocking error with no line (a file found under two module names,
      // a usage error) stopped mypy before it checked the code: the errors
      // it found on the way are not the run's verdict. Untrimmed: a source
      // line `pretty = true` echoes under an error is indented.
      const stopped = lines.find(
        (line) => /^\S.*?: error: /.test(line) && !BLOCKING.test(line.trim()),
      );
      if (stopped)
        throw new Error(`mypy exited 2 before checking the code: ${stopped}`);
      for (const line of lines) {
        const m = BLOCKING.exec(line.trim());
        if (!m?.[1] || !m[2] || !m[3]) continue;
        findings.push(
          finding({
            tool: "mypy",
            layer: "type-check",
            language: "python",
            file: absPosix(ctx.cwd, m[1]),
            line: Number(m[2]),
            col: 1,
            ruleId: m[4] ?? "syntax",
            severity: "error",
            message: m[3],
            fixable: false,
          }),
        );
      }
      if (findings.length === 0)
        throw new Error(
          `mypy exited 2: ${`${raw.stderr}\n${raw.stdout}`.trim().split("\n")[0] ?? ""}`,
        );
    } else {
      for (const line of raw.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        const e = parseJsonLine<MypyError>("mypy", line.trim());
        // A note explains the error before it; it is not one of its own.
        if (e.severity === "note") continue;
        findings.push(
          finding({
            tool: "mypy",
            layer: "type-check",
            language: "python",
            file: absPosix(ctx.cwd, e.file),
            // Columns are 0-based.
            line: e.line,
            col: e.column + 1,
            ...(e.end_line !== undefined ? { endLine: e.end_line } : {}),
            ...(e.end_column !== undefined ? { endCol: e.end_column + 1 } : {}),
            ...(e.code ? { ruleId: e.code } : {}),
            severity: e.severity === "error" ? "error" : "warning",
            message: e.hint ? `${e.message} (${e.hint})` : e.message,
            fixable: false,
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
