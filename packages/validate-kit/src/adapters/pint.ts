import { posix } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  consoleError,
  finding,
  findingsArray,
  parseJsonOutput,
} from "./base.js";

interface PintReport {
  result?: unknown;
  files?: unknown;
}

interface PintFile {
  path?: unknown;
  fixers?: unknown;
}

/**
 * Laravel Pint — php-cs-fixer with Laravel's presets: each file it would
 * change, once per rule (`array_syntax`, …), at its first line (Pint reports
 * neither lines nor a diff). Runs where the project chose it, from its PHP
 * root: a `pint.json` there, or `laravel/pint` in its composer.json; it runs
 * the project's own `vendor/bin/pint`. `--fix` runs `pint`, which rewrites
 * the files. Recorded on 1.32.1:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 6b.
 */
export const pint: ToolAdapter = {
  id: "pint",
  layer: "format",
  languages: ["php"],
  bin: "vendor/bin/pint",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.32.1",
  installHint:
    "composer require --dev laravel/pint  (the kit runs vendor/bin/pint)",
  findingExitCodes: [1],
  // Pint reads pint.json from the folder it runs in, which holds vendor/:
  // that folder only, not the ones above it.
  adoptedAt: (root) =>
    toolAdopted(root, root, {
      configs: ["pint.json"],
      composer: "laravel/pint",
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(format|test|repair|dirty)(=|$)/.test(arg))
      ? "the kit sets the report, the files and when to write changes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? [] : ["--test"]),
        "--format=json",
        ...ctx.extraArgs,
        ...(ctx.files ?? []).map((file) =>
          posix.relative(toPosix(ctx.cwd), toPosix(file)),
        ),
      ],
      // 1: files to change, and also a missing path or a usage error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Its errors are on stdout, in a console box.
    if (!raw.stdout.trimStart().startsWith("{"))
      throw new Error(
        `pint failed: ${consoleError(`${raw.stdout}\n${raw.stderr}`) ?? `exit ${raw.exitCode} with no message`}`,
      );
    const report = parseJsonOutput<PintReport>("pint", raw, {});
    if (report.result === "passed")
      return {
        findings: [],
        filesProcessed: ctx.files?.length ?? 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    if (report.result !== "fail" && report.result !== "fixed")
      throw new Error(
        `pint reported result ${JSON.stringify(report.result)}: its output format may have changed; refusing to report zero findings.`,
      );
    const files = findingsArray<PintFile>("pint", report, "files");
    const findings = files.flatMap((f) => {
      if (typeof f.path !== "string" || !Array.isArray(f.fixers))
        throw new Error(
          "pint reported a file without a path or fixers: its output format may have changed; refusing to report it.",
        );
      const file = absPosix(ctx.cwd, f.path);
      return f.fixers.map((fixer) =>
        finding({
          tool: "pint",
          layer: "format",
          language: "php",
          file,
          line: 1,
          col: 1,
          ruleId: String(fixer),
          severity: "warning",
          message: `Pint's ${String(fixer)} rule would change this file`,
          fixable: true,
        }),
      );
    });
    return {
      findings: report.result === "fixed" ? [] : findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: report.result === "fixed" ? files.length : 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
