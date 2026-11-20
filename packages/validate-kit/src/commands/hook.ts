import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runCheck, type CheckResult } from "../api.js";
import { ConfigError } from "../config/schema.js";
import { EXIT } from "../core/exit-codes.js";
import { upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { gatingFindings, quietLine } from "../report/pretty.js";
import { parseProfile } from "./check.js";

/**
 * Claude Code's hook events this command answers
 * (https://code.claude.com/docs/en/hooks): a prompt or a subagent's start
 * records the work tree; a stop judges what changed since. Exit 2 hands
 * stderr to the agent that stopped. A stop that follows a stop hook carries
 * `stop_hook_active`; Claude Code itself ends the turn after eight in a row
 * (docs/research/verification-continuum/anthropic-2026-11-16/assets/
 * hooks-stop-input-excerpt.md). The kit stops sooner: see MAX_ROUNDS.
 */
interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

const EVENTS = new Set([
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
]);

/** Claude Code's agents that cannot edit a file. */
const READ_ONLY = new Set(["Explore", "Plan"]);

/**
 * A project's own subagent whose definition gives it no editing tool
 * (`.claude/agents/<type>.md`, a `tools:` line without Edit, Write or
 * NotebookEdit): a reviewer or a grader. What it may still change through a
 * shell is judged when the agent that started it stops.
 */
function cannotEdit(project: string, type: string): boolean {
  if (!/^[\w-]+$/.test(type)) return false;
  try {
    const definition = readFileSync(
      join(project, ".claude", "agents", `${type}.md`),
      "utf8",
    );
    const tools = /^tools:[ \t]*(\S.*)$/m.exec(
      definition.split(/^---[ \t]*$/m)[1] ?? "",
    )?.[1];
    return (
      tools !== undefined &&
      !/\b(Edit|MultiEdit|Write|NotebookEdit)\b/.test(tools)
    );
  } catch {
    return false;
  }
}

/**
 * How often one agent is sent back on one prompt. After that it may stop and
 * the user is told what remains: "If a check is still failing after three
 * rounds, Claude stops and brings in a human" (Anthropic, "How the Claude
 * Code team thinks about verification", 2026-11-16).
 */
const MAX_ROUNDS = 3;

/** Lines of findings handed back, of the agent's own and of the others'. */
const OWN_LINES = 50;
const OTHER_LINES = 20;

/** git's output, untrimmed (`status -z` starts with a space), or undefined. */
function git(cwd: string, args: string[]): string | undefined {
  // No optional locks: an agent's `git commit` must not meet our index.lock.
  const run = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    // A fresh consumer can have over 1 MiB of untracked dependency paths.
    // Keep the capture bounded without mistaking truncated output for no work.
    maxBuffer: 20 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : undefined;
}

const topOf = (cwd: string): string | undefined =>
  git(cwd, ["rev-parse", "--show-toplevel"])?.trim();

const commonDir = (cwd: string): string | undefined => {
  const dir = git(cwd, ["rev-parse", "--git-common-dir"])?.trim();
  return dir ? resolve(cwd, dir) : undefined;
};

// Windows paths compare without case (git may spell the drive `c:`).
const same = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  (process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b);

/** Each uncommitted path (from the top, POSIX) → its status, size and time. */
function snapshot(top: string): Record<string, string> | undefined {
  const status = git(top, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status === undefined) return undefined;
  const files: Record<string, string> = {};
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry === "") continue;
    const path = entry.slice(3);
    // A rename's or copy's source is the next field, in the index or the
    // work tree (` R new` after `git add -N` and a move).
    if (/[RC]/.test(entry.slice(0, 2))) i++;
    try {
      const file = statSync(join(top, path));
      files[path] = `${entry.slice(0, 2)} ${file.size} ${file.mtimeMs}`;
    } catch {
      files[path] = `${entry.slice(0, 2)} gone`;
    }
  }
  return files;
}

/**
 * A JS package whose dependencies are not installed from it up to the work
 * tree's top (a new worktree has no install of its own): tsc and typed lint
 * cannot run there. A package that declares none needs no install.
 */
function uninstalled(dir: string, top: string): boolean {
  let manifest: { dependencies?: object; devDependencies?: object };
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: object;
      devDependencies?: object;
    };
  } catch {
    return false;
  }
  const declared =
    Object.keys(manifest.dependencies ?? {}).length > 0 ||
    Object.keys(manifest.devDependencies ?? {}).length > 0;
  return (
    declared &&
    !upTo(dir, top).some((folder) => existsSync(join(folder, "node_modules")))
  );
}

/** Up to `limit` lines, then how many more. */
function capped(lines: string[], limit: number): string {
  return [
    ...lines.slice(0, limit),
    ...(lines.length > limit ? [`... ${lines.length - limit} more`] : []),
  ].join("\n");
}

/**
 * `validate-kit hook claude`: Claude Code's UserPromptSubmit, Stop,
 * SubagentStart and SubagentStop hook. An agent that stops is judged on the
 * files it changed since its start (the user's prompt for the main agent),
 * with the fast tier in the work tree it is in (a subagent's own worktree).
 * Silent when its changes leave no finding of its own. When they do, it is
 * sent back with every finding: its own first, then those in files that
 * were changed before it started, which it is told to leave. The main agent
 * is sent back up to three times on one prompt and a subagent once; the stop
 * after that passes, and the user reads what remains (`systemMessage`). A
 * project subagent defined without an editing tool is not judged. Explore and
 * Plan cannot edit and are never judged; Claude Code's own helpers (no agent
 * type) are not either. Two agents writing one file at once cannot be told
 * apart: each sees the other's edits there as its own.
 */
export async function hookClaudeCommand(opts: {
  profile?: string;
}): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
  } catch {
    // Unreadable input cannot say whether this is the retry: let it stop.
    return EXIT.CLEAN;
  }
  const event = input.hook_event_name ?? "Stop";
  if (!EVENTS.has(event)) return EXIT.CLEAN;
  const subagent = event.startsWith("Subagent");
  if (subagent && (!input.agent_type || READ_ONLY.has(input.agent_type)))
    return EXIT.CLEAN;

  let project: string;
  try {
    // Real, as git prints the top: /var is /private/var on macOS.
    project = realpathSync(process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd());
  } catch {
    return EXIT.CLEAN;
  }
  if (subagent && cannotEdit(project, input.agent_type ?? ""))
    return EXIT.CLEAN;
  // The project is where Claude Code was started; the agent's work tree is
  // where it is now, when that is the same repository (a worktree of it).
  const main = topOf(project);
  if (main === undefined) return EXIT.CLEAN;
  const here =
    typeof input.cwd === "string" && existsSync(input.cwd)
      ? topOf(input.cwd)
      : undefined;
  const top =
    here !== undefined && same(commonDir(here), commonDir(main)) ? here : main;
  const checkIn = join(top, relative(main, project));

  const files = snapshot(top);
  // Without a session or an agent id there is no record to keep apart from
  // another's: every uncommitted file counts as this agent's.
  const who = subagent ? input.agent_id : "main";
  const mark =
    input.session_id && who
      ? join(
          tmpdir(),
          "validate-kit-claude-hook",
          `${input.session_id}-${who}`.replace(/[^\w.-]/g, "_"),
        )
      : undefined;
  let before: Record<string, unknown> | undefined;
  if (mark) {
    try {
      before = JSON.parse(readFileSync(mark, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // No record of its start: every uncommitted file counts as its own.
    }
  }
  // The files as they were at its start, when that record is of this work tree.
  const known =
    typeof before?.["top"] === "string" && same(before["top"], top)
      ? (before["files"] as Record<string, string> | undefined)
      : undefined;
  /** Keep `kept` as the files the agent started from, and how often it was sent back. */
  const record = (kept: Record<string, string>, rounds: number): void => {
    if (!mark) return;
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, JSON.stringify({ top, files: kept, rounds }));
  };
  /** Let it stop: what it changes after this is new. No snapshot, no new record. */
  const pass = (): number => {
    if (files !== undefined) record(files, 0);
    return EXIT.CLEAN;
  };
  if (event === "UserPromptSubmit" || event === "SubagentStart") return pass();
  // Rounds count the kit's own send-backs on this prompt: another stop hook
  // (a /goal) sets `stop_hook_active` too. With no record to count in (no
  // session or agent id), a stop that follows a stop hook is the last round.
  const counted = typeof before?.["rounds"] === "number" ? before["rounds"] : 0;
  // A subagent is sent back once. Its files cannot be told from those another
  // agent edits while it runs, and a wrong send-back costs its whole report.
  const allowed = subagent ? 1 : MAX_ROUNDS;
  const rounds = input.stop_hook_active !== true ? 0 : mark ? counted : allowed;
  /**
   * Send the agent back with what is open, between `lead` and `tail`, keeping
   * the record of its start so the next stop judges everything it changed on
   * this prompt. After MAX_ROUNDS it may stop, and the user is told what is
   * open.
   */
  const sendBack = (open: string, lead = "", tail = ""): number => {
    if (rounds >= allowed) {
      process.stdout.write(
        `${JSON.stringify({
          systemMessage: `validate-kit sent the agent back ${rounds === counted && counted > 1 ? `${counted} times` : "once"} and this is still open:\n${open}`,
        })}\n`,
      );
      return pass();
    }
    record(known ?? {}, rounds + 1);
    const reason = `${lead}${open}${tail}`;
    // Claude Code drops a stop hook's exit 2 when stdout is empty and stderr
    // reads like a missing file ("No such file or directory"), words a
    // finding can quote. The decision on stdout keeps the block.
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    process.stderr.write(reason);
    return 2;
  };

  // A missing snapshot is not a clean work tree. It is sent back and counted
  // like a finding: `stop_hook_active` alone does not say the kit sent this
  // agent back, and the last round tells the user what was not checked.
  if (files === undefined)
    return sendBack(
      "validate-kit: git work tree snapshot is unavailable, so your changes are unchecked. Check git and retry.\n",
    );

  // A deletion is a change too: what imported the file may no longer build.
  const mine = Object.keys(files).filter(
    (path) => known === undefined || known[path] !== files[path],
  );
  if (mine.length === 0) return pass();

  if (uninstalled(checkIn, top))
    return sendBack(
      `validate-kit: ${checkIn} has no node_modules, so your changes are unchecked: run your package manager's install there\n`,
    );
  let result: CheckResult;
  try {
    result = await runCheck({
      cwd: checkIn,
      changedMode: "changed",
      profile: parseProfile(opts.profile) ?? "dev",
    });
  } catch (err) {
    // A config error stops every check: anyone's to fix.
    if (err instanceof ConfigError)
      return sendBack(
        `validate-kit could not judge your changes: ${err.message}\n`,
      );
    throw err;
  }
  // Files changed before this agent started, and not since, are another
  // agent's or the user's. A finding anywhere else is this agent's, in a
  // file nobody changed too: a changed signature breaks its callers.
  const changed = new Set(mine);
  const theirs = new Set(
    Object.keys(files)
      .filter((path) => !changed.has(path))
      .map((path) => toPosix(relative(checkIn, join(top, path)))),
  );
  const own: string[] = [];
  const others: string[] = [];
  for (const finding of gatingFindings(result.summary)) {
    const path = toPosix(relative(result.projectRoot, finding.file));
    (theirs.has(path) ? others : own).push(
      quietLine(finding, result.projectRoot),
    );
  }
  if (own.length === 0) return pass();
  return sendBack(
    `${capped(own, OWN_LINES)}\n`,
    `validate-kit: your changes leave these findings; fix them before you finish${
      rounds > 0
        ? ` (round ${rounds + 1} of ${allowed}: if the same fix keeps failing, step back and change the approach)`
        : ""
    }:\n`,
    others.length > 0
      ? `Also found in files changed before you started (another agent's or the user's work: leave them):\n${capped(others, OTHER_LINES)}\n`
      : "",
  );
}
