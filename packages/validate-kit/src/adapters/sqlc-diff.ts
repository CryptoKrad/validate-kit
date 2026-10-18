import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { hunkStarts } from "./schemas-iac.js";
import {
  compileErrors,
  type SqlcProject,
  sqlcCommand,
  sqlcTasks,
} from "./sqlc-vet.js";

/**
 * sqlc diff — generated code that no longer matches the queries and schema
 * (a query edited, `sqlc generate` not run): one finding per generated file
 * the diff names, at its first changed line. sqlc diff exits 1 and prints
 * nothing when generated code is missing (a new query file never generated,
 * or a missing output folder): the kit reports that at the config. Queries
 * that do not compile are sqlc-vet's to report where; diff then reports
 * once, at the config, that it compared nothing (every compile error itself
 * when sqlc-vet is turned off). A config that names a database is not run
 * (as sqlc-vet). Never runs `sqlc generate` (that writes the project).
 * `--no-remote`. One task per sqlc config, in its folder. Recorded on
 * 1.31.1, where the diff is printed on stderr:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 3.
 */
export const sqlcDiff: ToolAdapter = {
  id: "sqlc-diff",
  layer: "behavior",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "sqlc",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "1.31.1",
  installHint: "brew install sqlc",
  versionArgs: ["version"],
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "compile",
  expand: sqlcTasks,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return sqlcCommand(this.bin, "diff", ctx);
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const project = ctx.options as SqlcProject;
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    const text = `${raw.stdout}\n${raw.stderr}`;
    const atConfig = (ruleId: string, message: string): Finding =>
      finding({
        tool: "sqlc-diff",
        layer: "behavior",
        file: absPosix(ctx.cwd, project.config),
        line: 1,
        col: 1,
        ruleId,
        severity: "error",
        message,
        fixable: false,
      });
    const hunks = hunkStarts(text, "b/");
    // A diff's own lines can look like `file:1:2: text`: compile errors
    // come only without one.
    const compile =
      hunks.length === 0 ? compileErrors("sqlc-diff", text, ctx) : [];
    if (compile.length > 0)
      return result(
        project.vetRuns
          ? [
              atConfig(
                "compile",
                "generated code not compared: the queries do not compile (sqlc-vet reports where)",
              ),
            ]
          : compile,
      );
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const { file, line } of hunks) {
      if (seen.has(file)) continue;
      seen.add(file);
      const path = absPosix(ctx.cwd, file);
      findings.push(
        finding({
          tool: "sqlc-diff",
          layer: "behavior",
          language: languageForFile(path),
          file: path,
          line,
          col: 1,
          ruleId: "stale",
          severity: "error",
          message:
            "generated code does not match the queries and schema: run `sqlc generate` and commit the result",
          fixable: false,
        }),
      );
    }
    // Exit 1 with nothing printed: a file sqlc generate would write is not
    // there (sqlc diff does not say which).
    if (raw.exitCode === 1 && text.trim() === "") {
      const missing = project.outs.filter(
        (out) => !existsSync(join(ctx.cwd, out)),
      );
      findings.push(
        atConfig(
          "stale",
          `generated code is missing${missing.length > 0 ? ` (no ${missing.map((out) => `\`${out}\``).join(", ")} folder)` : ", for a query file never generated"}: sqlc diff exits 1 and prints nothing then; run \`sqlc generate\` and commit the result`,
        ),
      );
    }
    if (raw.exitCode !== 0 && findings.length === 0)
      throw new Error(
        `sqlc diff exited ${raw.exitCode}: ${text.trim().split("\n")[0] ?? "no message"}`,
      );
    return result(findings);
  },
};
