import { Command, CommanderError } from "commander";
import { baselineCommand, type BaselineFlags } from "./commands/baseline.js";
import { checkCommand, type CheckFlags } from "./commands/check.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { mcpCommand } from "./commands/mcp.js";
import {
  RULE_LANGUAGES,
  rulesNewCommand,
  rulesTestCommand,
} from "./commands/rules.js";
import { EXIT } from "./core/exit-codes.js";
import { kitVersion } from "./core/paths.js";
import { LANGUAGES, LAYERS } from "./core/types.js";
import { ConfigError } from "./config/schema.js";

// `git bisect run` reads 125 as "this revision cannot be tested". With
// --bisect, a usage or config error, a missing tool and a crash all say that:
// none of them is a verdict on the code. Read from argv, because a usage
// error ends the parse before any action sees the flag.
const operands = process.argv.indexOf("--");
const args = process.argv.slice(2, operands === -1 ? undefined : operands);
const bisect = args.includes("--bisect");
const BISECT_SKIP = 125;

// --json and `--ai-json -` callers parse stdout: an error that ends the run
// before a report still prints one JSON object (the human message stays on
// stderr).
const json =
  args.includes("--json") ||
  args.includes("--ai-json=-") ||
  args.some((arg, i) => arg === "--ai-json" && args[i + 1] === "-");

function failed(
  code: number,
  kind: string,
  message: string,
  { printed = false } = {},
): void {
  if (!printed) process.stderr.write(`${message}\n`);
  process.exitCode = verdict(code);
  if (json)
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 2, exitCode: process.exitCode, error: { kind, message } })}\n`,
    );
}

function verdict(code: number): number {
  return bisect && code !== EXIT.CLEAN && code !== EXIT.FINDINGS
    ? BISECT_SKIP
    : code;
}

const program = new Command();
// Commander exits 1 on a usage error, which reads as "findings". Route its
// errors through the catch below instead.
program.exitOverride();

program
  .name("validate-kit")
  .description(
    "Polyglot validation — format · lint · types · custom ast-grep rules · security",
  )
  .version(kitVersion());

program
  .command("check", { isDefault: true })
  .description("run validation across detected languages")
  .argument(
    "[paths...]",
    "zero or one directory to check (default: current directory)",
  )
  .option("--fix", "apply autofixes (formatters + safe linters)")
  .option("--changed", "only files changed in the working tree")
  .option("--staged", "only git-staged files (used by the pre-commit hook)")
  .option(
    "--since <ref>",
    "only files that differ from <ref>'s merge base: its commits and uncommitted edits",
  )
  .option("--layer <layers...>", `restrict to layers: ${LAYERS.join(" ")}`)
  .option("--lang <langs...>", `restrict to languages: ${LANGUAGES.join(" ")}`)
  .option("--only <tools...>", "run only these tools")
  .option("--disable <tools...>", "skip these tools")
  .option("--json", "machine-readable JSON output")
  .option("--sarif <path>", "also write a SARIF 2.1.0 report")
  .option(
    "--ai-json <path>",
    "also write the AI-assist findings report ('-' for stdout)",
  )
  .option(
    "--quiet",
    "nothing when the run passes; on failure one line per gating finding, then the exit code (for hooks)",
  )
  .option("--profile <profile>", "validation profile: default dev ci fixtures")
  .option("--concurrency <n>", "max parallel tools")
  .option("--config <path>", "path to a validate config file")
  .option(
    "--trusted-ref <ref>",
    "read the validate config from this commit, and fail on any tool settings file that differs from it",
  )
  .option(
    "--bisect",
    "for `git bisect run`: exit 125 (skip) when the revision cannot be judged (exit 2, 3 or 4)",
  )
  .action(async (paths: string[], opts: CheckFlags) => {
    process.exitCode = verdict(await checkCommand(paths, opts));
  });

program
  .command("list")
  .description(
    "show detected languages and the tasks that would run (no execution)",
  )
  .argument(
    "[paths...]",
    "zero or one directory to check (default: current directory)",
  )
  .option("--changed", "only files changed in the working tree")
  .option("--staged", "only git-staged files")
  .option(
    "--since <ref>",
    "only files that differ from <ref>'s merge base: its commits and uncommitted edits",
  )
  .option("--layer <layers...>", `restrict to layers: ${LAYERS.join(" ")}`)
  .option("--lang <langs...>", `restrict to languages: ${LANGUAGES.join(" ")}`)
  .option("--only <tools...>", "show only these tools")
  .option("--disable <tools...>", "skip these tools")
  .option("--json")
  .option("--profile <profile>", "validation profile: default dev ci fixtures")
  .option("--config <path>")
  .option("--trusted-ref <ref>", "read the validate config from this commit")
  .action(async (paths: string[], opts: CheckFlags) => {
    process.exitCode = await listCommand(paths, opts);
  });

program
  .command("baseline")
  .description(
    "record today's findings as accepted debt in validate.baseline.json (created, or only lowered)",
  )
  .argument(
    "[paths...]",
    "zero or one directory to check (default: current directory)",
  )
  .option(
    "--adopt-new-rules",
    "accept findings of rules the baseline never saw, after a kit or tool upgrade",
  )
  .option(
    "--include-security",
    "also accept security-layer findings (still printed on every run)",
  )
  .option("--profile <profile>", "validation profile (default: ci)")
  .option(
    "--only <tools...>",
    "record only these tools (the others keep their counts)",
  )
  .option("--disable <tools...>", "skip these tools (they keep their counts)")
  .option("--config <path>", "path to a validate config file")
  .action(async (paths: string[], opts: BaselineFlags) => {
    process.exitCode = await baselineCommand(paths, opts);
  });

program
  .command("mcp")
  .description(
    "serve findings to AI agents over MCP stdio (tools: run_check, list_findings, get_finding, apply_safe_fixes)",
  )
  .action(async () => {
    process.exitCode = await mcpCommand();
  });

program
  .command("doctor")
  .description(
    "verify every required tool is installed and at a supported version",
  )
  .option("--json")
  .option("--config <path>", "path to a validate config file")
  .option(
    "--profile <profile>",
    "answer for this profile (under ci every planned tool is required)",
  )
  .action(
    async (opts: { json?: boolean; config?: string; profile?: string }) => {
      process.exitCode = await doctorCommand(opts);
    },
  );

program
  .command("init")
  .description(
    "scaffold a validate config, the MCP entry and lefthook pre-commit and pre-push hooks",
  )
  .option("--force", "overwrite an existing config")
  .option("--no-hook", "skip lefthook.yml and `lefthook install`")
  .option("--no-mcp", "skip the .mcp.json entry")
  .option("--dry-run", "print what init would write, and write nothing")
  .action(
    async (opts: {
      force?: boolean;
      hook?: boolean;
      mcp?: boolean;
      dryRun?: boolean;
    }) => {
      process.exitCode = await initCommand(opts);
    },
  );

const rules = program
  .command("rules")
  .description("custom ast-grep rule library management");
rules
  .command("test")
  .description("run the ast-grep rule snapshot tests")
  .option("-u, --update", "update snapshots")
  .option("--validity-only", "skip snapshot comparison (fast validity check)")
  .action(async (opts: { update?: boolean; validityOnly?: boolean }) => {
    process.exitCode = await rulesTestCommand({
      update: opts.update === true,
      validityOnly: opts.validityOnly === true,
    });
  });
rules
  .command("new")
  .description("scaffold a new rule + test stub")
  .argument("<lang>", RULE_LANGUAGES.join(" | "))
  .argument(
    "<category>",
    "correctness | security | performance | style | maintainability",
  )
  .argument("<id>", "kebab-case rule id (without the language prefix)")
  .action((lang: string, category: string, id: string) => {
    process.exitCode = rulesNewCommand(lang, category, id);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Commander has already printed the message. --help and --version end
    // here with exit code 0; an unknown option or a missing argument is a
    // usage error, reported like a config error (JSON too, under --json).
    if (err.exitCode === 0) process.exitCode = verdict(EXIT.CLEAN);
    else
      failed(
        EXIT.CONFIG,
        "usage",
        // `help <unknown>` prints the usage and says only "(outputHelp)".
        err.code === "commander.help"
          ? "unknown command; the usage is printed on stderr"
          : err.message,
        { printed: true },
      );
    return;
  }
  if (err instanceof ConfigError) {
    failed(EXIT.CONFIG, "config", err.message);
    return;
  }
  failed(
    EXIT.INTERNAL,
    "internal",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
});
