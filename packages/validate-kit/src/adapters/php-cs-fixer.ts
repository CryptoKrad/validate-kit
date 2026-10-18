import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  byConfigFolder,
  consoleError,
  finding,
  parseFindings,
} from "./base.js";

/** Where php-cs-fixer looks, in the folder it runs in (cs.symfony.com/doc/config.html). */
const CONFIGS = [".php-cs-fixer.php", ".php-cs-fixer.dist.php"];

interface FixerFile {
  name?: unknown;
  diff?: unknown;
}

/**
 * The first line of each run of changed lines in a unified diff, in the
 * file as it is, with the first line it would be replaced by.
 */
function changedLines(diff: string): { line: number; to?: string }[] {
  const changes: { line: number; to?: string }[] = [];
  let line = 0;
  let current: { line: number; to?: string } | undefined;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      current = undefined;
      continue;
    }
    // The --- and +++ header comes before the first hunk.
    if (line === 0) continue;
    const sign = text[0];
    if (sign !== "-" && sign !== "+") {
      current = undefined;
      line++;
      continue;
    }
    if (!current) {
      current = { line };
      changes.push(current);
    }
    if (sign === "+" && current.to === undefined)
      current.to = text.slice(1).trim();
    if (sign === "-") line++;
  }
  return changes;
}

/** `   1) /abs/src/Broken.php` under this line of its stderr (exit bit 4). */
const INVALID_HEADER =
  "Files that were not fixed due to errors reported during linting before fixing:";

/**
 * php-cs-fixer — PHP code style by the project's own rules (PSR-12,
 * `array_syntax`, …): each run of lines it would rewrite, at its first line,
 * with what it would become; a file that does not parse is an error. Runs
 * where the project chose it: a `.php-cs-fixer.php` or
 * `.php-cs-fixer.dist.php` at or above the file, from that folder (it reads
 * its config from there), on the files its finder also matches
 * (`--path-mode=intersection`), with no cache file in the project. `--fix`
 * applies the config's rules, risky ones too when the config allows them
 * (`setRiskyAllowed`). Recorded on 3.95.27:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 6a.
 */
export const phpCsFixer: ToolAdapter = {
  id: "php-cs-fixer",
  layer: "format",
  languages: ["php"],
  bin: "php-cs-fixer",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "3.95.27",
  installHint:
    "brew install php-cs-fixer  (or: composer require --dev friendsofphp/php-cs-fixer, then tools.php-cs-fixer.bin: vendor/bin/php-cs-fixer)",
  parseVersion: (out) => /PHP CS Fixer (\d+\.\d+\.\d+)/.exec(out)?.[1],
  // 8: changes needed; 4: a file that does not parse; 12: both.
  findingExitCodes: [4, 8, 12],
  masks: (f) => f.ruleId === "syntax",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    return byConfigFolder(seed, env, "php", CONFIGS).flatMap((task) =>
      env.toolConfig.configPath !== undefined ||
      CONFIGS.some((name) => existsSync(join(task.cwd, name)))
        ? [task]
        : [
            {
              ...task,
              // `tools.php-cs-fixer.enabled` with no config: given more
              // than one path it exits 16, "For multiple paths config
              // parameter is required".
              cannotRun:
                "no .php-cs-fixer.php or .php-cs-fixer.dist.php reaches these files, and php-cs-fixer needs one to check more than one: add one, or set tools.php-cs-fixer.configPath",
            },
          ],
    );
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(format|dry-run|diff|path-mode|using-cache|cache-file|show-progress)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit sets the report, the files, the cache and when to write changes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Named even where it would find it: with more than one path it exits 16,
    // "For multiple paths config parameter is required".
    const config =
      ctx.configPath ??
      CONFIGS.map((name) => join(ctx.cwd, name)).find((path) =>
        existsSync(path),
      );
    return {
      bin: this.bin,
      args: [
        "fix",
        ...(ctx.fix ? [] : ["--dry-run", "--diff"]),
        "--format=json",
        // Without a config it asks on stdin whether to create one.
        "--no-interaction",
        // Otherwise it writes .php-cs-fixer.cache into the project.
        "--using-cache=no",
        ...(config ? [`--config=${toPosix(config)}`] : []),
        ...ctx.extraArgs,
        "--path-mode=intersection",
        "--",
        ...(ctx.files ?? []).map((file) =>
          posix.relative(toPosix(ctx.cwd), toPosix(file)),
        ),
      ],
      // Its exit code is a bit set; 1, 16 and 32 are failures, read below.
      okExitCodes: "any",
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (![0, 4, 8, 12].includes(raw.exitCode))
      throw new Error(
        `php-cs-fixer failed (exit ${raw.exitCode}): ${consoleError(raw.stderr) ?? "no message"}`,
      );
    const { items } = parseFindings<FixerFile>("php-cs-fixer", raw, "files");
    const findings: Finding[] = [];
    for (const f of items) {
      if (typeof f.name !== "string")
        throw new Error(
          "php-cs-fixer reported a file without a name: its output format may have changed; refusing to report it.",
        );
      if (ctx.fix) continue;
      const file = absPosix(ctx.cwd, f.name);
      const changes =
        typeof f.diff === "string" ? changedLines(f.diff) : [{ line: 1 }];
      for (const change of changes.length > 0 ? changes : [{ line: 1 }])
        findings.push(
          finding({
            tool: "php-cs-fixer",
            layer: "format",
            language: "php",
            file,
            line: change.line,
            col: 1,
            severity: "warning",
            message: change.to
              ? `php-cs-fixer would rewrite this as \`${change.to.slice(0, 80)}\``
              : "php-cs-fixer would reformat this",
            fixable: true,
          }),
        );
    }
    if (raw.exitCode & 4) {
      const lines = raw.stderr.split("\n");
      const header = lines.findIndex((line) => line.trim() === INVALID_HEADER);
      const invalid: string[] = [];
      for (const line of header < 0 ? [] : lines.slice(header + 1)) {
        const path = /^\s+\d+\) (.+)$/.exec(line)?.[1];
        if (path === undefined) break;
        invalid.push(path);
      }
      if (invalid.length === 0)
        throw new Error(
          `php-cs-fixer exited ${raw.exitCode} (a file it cannot lint) without naming it: its output format may have changed.`,
        );
      for (const path of invalid)
        findings.push(
          finding({
            tool: "php-cs-fixer",
            layer: "format",
            language: "php",
            file: absPosix(ctx.cwd, path),
            line: 1,
            col: 1,
            ruleId: "syntax",
            severity: "error",
            message:
              "Does not parse as PHP, so php-cs-fixer left it unchecked: `php -l` names the error",
            fixable: false,
          }),
        );
    }
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: ctx.fix ? items.length : 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
