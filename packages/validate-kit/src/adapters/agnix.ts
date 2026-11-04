import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray, parseJsonOutput } from "./base.js";
import { formatChanged } from "./mutation.js";

/** agnix's own config (docs/CONFIGURATION.md). */
const CONFIGS = [".agnix.toml"];

/** The files agnix judges: an agent's instructions, hooks and MCP config. */
const INPUT =
  /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|AGENTS\.local\.md|GEMINI\.md|SKILL\.md|\.mcp\.json|copilot-instructions\.md)$|(?:^|\/)\.(?:claude|cursor|codex|kiro)\//;

/**
 * What the kit hands agnix at the project root, when it exists: the root
 * instruction files, the agent folders (`.claude/` by its own subfolders,
 * so another agent's worktree under `.claude/worktrees/` is left out) and
 * the MCP config. A fixture's or a dependency's copy is not the project's.
 */
const ROOT_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "GEMINI.md",
  ".mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
  ".claude/commands",
  ".cursor",
  ".codex",
  ".kiro",
  ".github/copilot-instructions.md",
];

interface Item {
  level?: unknown;
  rule?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  message?: unknown;
  suggestion?: unknown;
}

interface Report {
  diagnostics?: Item[];
}

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  info: "info",
};

/**
 * agnix — an agent's own instructions and wiring, as the agent will read
 * them: a hook with a type Claude Code does not know, an MCP server with
 * an empty configuration, a SKILL.md without its frontmatter, a rule file
 * in the wrong place. Nothing else looks at these files, and they are the
 * ones an agent edits most. Each diagnostic is a finding at its line, with
 * agnix's level; one with no file is the project's (its version note).
 * Where the project chose it: `.agnix.toml`, `tools.agnix.enabled`, or a
 * step that runs it, on the project's own agent files (not a fixture's or
 * a worktree's). A changed run starts it only when one of them changed.
 * It runs without the network (recorded with it denied). Pre-1.0: built
 * from source with cargo (`cargo install --locked agnix-cli`), since its
 * Homebrew tap is untrusted and its npm package downloads a binary in a
 * postinstall. Recorded on 0.60.3:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const agnix: ToolAdapter = {
  id: "agnix",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "agnix",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.60.0",
  installHint: "cargo install --locked agnix-cli",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  configFiles: CONFIGS,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: CONFIGS,
        step: /(?:^|[\s;&|"'(/])agnix(?:\s|$)/m,
      });
    if (!chosen) return [];
    if (
      env.changedPaths &&
      !env.changedPaths.some((path) => INPUT.test(toPosix(path)))
    )
      return [];
    const files = ROOT_PATHS.filter((path) => existsSync(join(root, path)));
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:--format|--fix|--fix-safe|--fix-unsafe|-w|--watch)(=|$)/.test(arg),
    )
      ? "--format is the kit's; --fix rewrites the files; --watch never returns"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--format",
        "json",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(ctx.files ?? ["."]),
      ],
      // 1: an error-level diagnostic; 2: a usage error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const report = parseJsonOutput<Report>("agnix", raw, { diagnostics: [] });
    const items = findingsArray<Item>("agnix", report.diagnostics ?? []);
    if (raw.exitCode === 1 && items.length === 0)
      throw formatChanged("agnix", "exited 1 with no diagnostic in its JSON");
    const findings: Finding[] = [];
    for (const item of items) {
      if (
        typeof item.rule !== "string" ||
        typeof item.message !== "string" ||
        typeof item.level !== "string"
      )
        throw formatChanged(
          "agnix",
          "reported a diagnostic without a rule, level or message",
        );
      // No file, or the project folder itself: the project's own note.
      const named = typeof item.file === "string" ? item.file : "";
      const file =
        named === "" || (isAbsolute(named) && !existsSync(named))
          ? cwd
          : absPosix(cwd, named);
      const rel = toPosix(relative(cwd, file));
      findings.push(
        finding({
          tool: "agnix",
          layer: "lint",
          file: rel === "" ? posix.join(cwd, "AGENTS.md") : file,
          line: typeof item.line === "number" && item.line > 0 ? item.line : 1,
          col:
            typeof item.column === "number" && item.column > 0
              ? item.column
              : 1,
          ruleId: item.rule,
          severity: SEVERITY[item.level] ?? "info",
          message:
            typeof item.suggestion === "string" && item.suggestion !== ""
              ? `${item.message} (${item.suggestion})`
              : item.message,
          fixable: false,
        }),
      );
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
