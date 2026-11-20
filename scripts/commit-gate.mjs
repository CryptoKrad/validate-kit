#!/usr/bin/env node
// The commit gate of this repository's Claude Code sessions (.claude/settings.json).
//
// From Anthropic's "How the Claude Code team thinks about verification"
// (docs/research/verification-continuum/anthropic-2026-11-16): each commit is
// stamped with how it was verified, "none" included; a commit from a session
// that ran neither a review nor a verify step is logged (observe) or sent
// back (enforce); a commit that was sent back twice goes through the third
// time; a commit whose message says why it was not verified goes through.
//
// One script answers four hook events, reading the event as JSON on stdin:
//   PostToolUse (Skill), UserPromptExpansion  record that a review or a
//       verify skill was started in this session. A hook cannot see what a
//       skill found; a chain (/ship, /go) records nothing, its steps do.
//   SubagentStop  record what this repository's own agents reported: the
//       `reviewer`'s count of Important findings, the `grader`'s "satisfied"
//   PreToolUse (Bash)  on a `git commit` in this repository: stamp the
//       commit, and gate it. A commit in another repository, and the words
//       "git commit" in quoted text or a here-document, are left alone.
//
// A step is recorded with the tree it ran on. "A passing review on an
// out-of-date commit means nothing" (the same write-up): at the commit, a
// step whose tree has changed since is stamped with the number of files that
// changed, and does not count for the gate.
//
// The mode is the `mode` of .claude/commit-gate.json: "off", "observe" (the
// default: a new gate starts there) or "enforce". Usage:
//   node scripts/commit-gate.mjs            answer one hook event
//   node scripts/commit-gate.mjs --log      print what observe mode recorded
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The skills and commands that count, by what they do. */
const STEPS = {
  review: ["code-review", "review"],
  // "Security gets its own automated review too" (Anthropic, "How the Claude
  // Code team does code review"): its own step, so a stamp shows whether it ran.
  security: ["security-review"],
  verify: ["verify"],
};
const MODES = ["off", "observe", "enforce"];
/** How often one session is sent back before a commit goes through. */
const MAX_BLOCKS = 2;
/** A line of the commit message that says why the commit was not verified. */
const REASON = /(^|["'\s])Not-Verified:\s*\S/m;
/** The first line of a reviewer's report: its count of Important findings. */
const COUNT = /^\W*(?:Important findings:\W*(\d+)|(\d+) Important\b)/i;
/** One shell word: quoted, or up to the next space or operator. */
const WORD = String.raw`"[^"]*"|'[^']*'|[^\s;&|)]+`;
/** `git commit` at the start of a command, with git's own options before it. */
const GIT = new RegExp(
  String.raw`^git((?:\s+(?:-C\s+(?:${WORD})|-c\s+\S+|--no-pager|--no-optional-locks))*)\s+commit(?=\s|$)`,
);
const CD = new RegExp(String.raw`^cd\s+(${WORD})`);
/** `NAME=value` words before a command. */
const ASSIGN = new RegExp(String.raw`^(?:\w+=(?:${WORD})?\s+)+`);

function git(cwd, args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

/** A repository's git folder, the same for each of its worktrees. */
function repository(dir) {
  const common =
    dir === undefined ? undefined : git(dir, ["rev-parse", "--git-common-dir"]);
  try {
    return common === undefined
      ? undefined
      : realpathSync(resolve(dir, common));
  } catch {
    return undefined;
  }
}

/**
 * The work tree as one git tree id: what is committed, changed and new,
 * without what git ignores. Two states with the same id hold the same files,
 * whatever was committed between them. It is written through a copy of the
 * index, so the real index is not touched.
 * shortcut: each call stores the changed files as loose objects until git
 * prunes them; cheap for a repository's own sources (0.12 s here, measured
 * 2026-11-16, against the hook's 10 s), costly beside large untracked files
 * that are not ignored: ignore them, or the hook times out and the commit
 * goes through with no stamp.
 */
function workTree(project, state) {
  const index = join(state, `index.${process.pid}`);
  const run = (args) =>
    spawnSync("git", args, {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: index },
    });
  try {
    mkdirSync(state, { recursive: true });
    const real = git(project, ["rev-parse", "--git-path", "index"]);
    if (real && existsSync(resolve(project, real)))
      copyFileSync(resolve(project, real), index);
    if (run(["add", "-A"]).status !== 0) return undefined;
    const tree = run(["write-tree"]);
    return tree.status === 0 ? tree.stdout.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** The folder a `cd` or `-C` word names; undefined when the text does not say. */
function folder(from, word) {
  const text = word
    .replace(/^(["'])(.*)\1$/, "$2")
    .replace(/^~(?=\/|$)/, homedir())
    .replace(/\$\{?HOME\}?/g, homedir());
  return from === undefined || text.startsWith("-") || /[$`*?]/.test(text)
    ? undefined
    : resolve(from, text);
}

/**
 * Each `git commit` that is a command of its own in a shell command line:
 * where its word `commit` ends, the folder it runs in (from a `cd` before it
 * and git's `-C`), and whether it carries `--dry-run`. The line is read as a
 * shell reads it: text in quotes, in a comment or in a here-document is not a
 * command, a `$( )` inside double quotes is one again, and a `cd` inside
 * `( )` ends with it.
 * Where the folder is not certain the commit is left alone: after `pushd`,
 * `popd`, a `cd` with an option or a variable, and with GIT_DIR or
 * GIT_WORK_TREE set on the line.
 * shortcut: a commit behind `sudo`, `env`, `xargs`, after `)` or in
 * backticks is not seen and so not stamped; read those when a session really
 * commits that way.
 */
export function commits(command, start) {
  const found = [];
  let dir = start;
  let heredoc;
  let fresh = true;
  // The commit whose words are being read, until its command ends.
  let current;
  // What is open, innermost last: a double-quoted string, or a ( ) group
  // with the folder to go back to when it closes.
  const open = [];
  const lineEnd = (from) => {
    const end = command.indexOf("\n", from);
    return end === -1 ? command.length : end;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const inside = open.at(-1);
    if (inside?.quote) {
      if (char === "\\") i++;
      else if (char === '"') open.pop();
      else if (command.startsWith("$((", i))
        i = command.indexOf("))", i) === -1 ? command.length : i + 2;
      else if (command.startsWith("$(", i)) {
        open.push({ dir });
        current = undefined;
        fresh = true;
        i++;
      }
    } else if (char === "\n" && heredoc !== undefined) {
      // The here-document's lines, up to the one that is its end word.
      let line = i + 1;
      while (line <= command.length) {
        const end = lineEnd(line);
        const last = command.slice(line, end).replace(/^\t+/, "") === heredoc;
        line = end + 1;
        if (last) break;
      }
      i = line - 1;
      heredoc = undefined;
      current = undefined;
      fresh = true;
    } else if (char === "\\") {
      i++;
      fresh = false;
    } else if (char === "'") {
      // `$'...'` takes a backslash; plain single quotes take nothing.
      const ansi = command[i - 1] === "$";
      for (i++; i < command.length && command[i] !== "'"; i++)
        if (ansi && command[i] === "\\") i++;
      fresh = false;
    } else if (char === '"') {
      open.push({ quote: true });
      fresh = false;
    } else if (char === "#" && (fresh || /\s/.test(command[i - 1]))) {
      i = lineEnd(i) - 1;
    } else if (
      command.startsWith("$((", i) ||
      (fresh && command.startsWith("((", i))
    ) {
      const end = command.indexOf("))", i);
      i = end === -1 ? command.length : end + 1;
      fresh = false;
    } else if (command.startsWith("<<<", i)) {
      i += 2;
    } else if (
      char === "&" &&
      (command[i - 1] === ">" ||
        command[i - 1] === "<" ||
        command[i + 1] === ">")
    ) {
      // `2>&1`, `<&3`, `&>file`: a redirection, not the end of the command.
    } else if (command.startsWith("<<", i)) {
      const word = /^<<-?\s*(?:"([^"]+)"|'([^']+)'|\\?([\w.-]+))/.exec(
        command.slice(i),
      );
      if (word) {
        heredoc = word[1] ?? word[2] ?? word[3];
        i += word[0].length - 1;
      } else i++;
    } else if (char === "(") {
      open.push({ dir });
      current = undefined;
      fresh = true;
    } else if (char === ")") {
      if (inside) dir = open.pop().dir;
      current = undefined;
      fresh = false;
    } else if (";&|\n".includes(char)) {
      current = undefined;
      fresh = true;
    } else if (/\s/.test(char)) {
      // Between words.
    } else if (fresh) {
      // A word that only leads to a command: the command starts after it.
      const before =
        /^(?:then|else|elif|do|if|while|until|time|builtin|command|!|\{)(?=\s)/.exec(
          command.slice(i),
        );
      if (before) {
        i += before[0].length - 1;
        continue;
      }
      fresh = false;
      const set = ASSIGN.exec(command.slice(i))?.[0] ?? "";
      const lead = set.length;
      const rest = command.slice(i + lead);
      const cd = lead === 0 ? CD.exec(rest) : null;
      const commit = GIT.exec(rest);
      if (cd) dir = folder(dir, cd[1]);
      else if (
        /^(?:pushd|popd)(?=\s|$)/.test(rest) ||
        /^(?:export\s+)?GIT_(?:DIR|WORK_TREE)=/.test(rest) ||
        /(?:^|\s)GIT_(?:DIR|WORK_TREE)=/.test(set)
      ) {
        // From here the folder, or the repository, is not what the text says.
        dir = undefined;
      } else if (commit) {
        let where = dir;
        for (const [, to] of commit[1].matchAll(
          new RegExp(String.raw`-C\s+(${WORD})`, "g"),
        ))
          where = folder(where, to);
        current = { at: i + lead + commit[0].length, dir: where };
        found.push(current);
        i = current.at - 1;
      }
    } else if (
      current &&
      /\s/.test(command[i - 1]) &&
      /^--dry-run(?![\w-])/.test(command.slice(i, i + 10))
    )
      current.dryRun = true;
  }
  return found.filter((commit) => !commit.dryRun);
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return 0;
  }
  const project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const here = repository(project);
  if (here === undefined) return 0;
  const state = join(here, "validate-kit");
  let mode = "observe";
  try {
    mode =
      JSON.parse(
        readFileSync(join(project, ".claude", "commit-gate.json"), "utf8"),
      ).mode ?? mode;
  } catch {
    // No file, or one that does not parse: the default.
  }
  // Without a session there is nothing to record a step under, or to count.
  const session = String(input.session_id ?? "").replace(/[^\w.-]/g, "_");
  if (mode === "off" || session === "") return 0;
  const file = join(state, "sessions", `${session}.json`);
  let record = { ran: {}, tree: {}, blocked: 0 };
  try {
    record = { ...record, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    // The session's first event.
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  };
  /** A step ran now, on the tree as it is now. */
  const mark = (step) => {
    record.ran[step] = new Date().toISOString();
    record.tree[step] = workTree(project, state);
  };
  const ran = (name) => {
    // `plugin:skill` and a leading slash name the same skill.
    const skill = String(name ?? "")
      .replace(/^\//, "")
      .split(":")
      .at(-1);
    for (const [step, names] of Object.entries(STEPS))
      if (names.includes(skill)) mark(step);
    save();
  };

  switch (input.hook_event_name) {
    case "PostToolUse":
      if (input.tool_name === "Skill") ran(input.tool_input?.skill);
      return 0;
    case "UserPromptExpansion":
      ran(input.command_name);
      return 0;
    case "SubagentStop": {
      // An agent counts by what it reported, not by having stopped.
      const lines = String(input.last_assistant_message ?? "")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const count = COUNT.exec(lines[0] ?? "");
      if (input.agent_type === "reviewer" && count) {
        mark("review");
        record.important = Number(count[1] ?? count[2]);
        save();
      } else if (
        input.agent_type === "grader" &&
        /^\W*satisfied\W*$/i.test(lines.at(-1) ?? "")
      ) {
        mark("grade");
        save();
      }
      return 0;
    }
    case "PreToolUse":
      break;
    default:
      return 0;
  }

  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string") return 0;
  const from = typeof input.cwd === "string" ? input.cwd : project;
  const found = commits(command, from).filter(
    (commit) => repository(commit.dir) === here,
  );
  if (found.length === 0) return 0;

  // How many files changed since a step ran: a step on another tree says
  // nothing about this commit. Undefined when a tree could not be read, or
  // the two could not be compared: what is not known is not "the same".
  const now = workTree(project, state);
  const since = (step) => {
    const then = record.tree?.[step];
    if (!then || !now) return undefined;
    if (then === now) return 0;
    return git(project, ["diff", "--name-only", then, now])
      ?.split("\n")
      .filter(Boolean).length;
  };
  const steps = [
    ["review", "review"],
    ["security", "security"],
    ["verify", "verify"],
    ["grade", "graded"],
  ]
    .filter(([step]) => record.ran[step])
    .map(([step, name]) => {
      const changed = since(step);
      const notes = [
        step === "review" &&
          record.important > 0 &&
          `${record.important} Important in its last report`,
        changed === undefined
          ? "its tree could not be compared with this one"
          : changed > 0 &&
            `${changed} file${changed === 1 ? "" : "s"} changed since`,
      ].filter(Boolean);
      return {
        changed,
        fresh: changed === 0,
        text: notes.length > 0 ? `${name} (${notes.join("; ")})` : name,
      };
    });
  const stamp =
    steps.length > 0 ? steps.map((step) => step.text).join(", ") : "none";
  const verified = steps.some((step) => step.fresh);
  // The same command with the stamp as a trailer, unless it carries one.
  let stamped = command;
  if (!/--trailer[=\s]+["']?Verified:/.test(command))
    for (const { at } of found.toReversed())
      stamped = `${stamped.slice(0, at)} --trailer "Verified: ${stamp}"${stamped.slice(at)}`;
  const allow = () => {
    process.stdout.write(
      `${JSON.stringify({
        ...(MODES.includes(mode)
          ? {}
          : {
              systemMessage: `commit gate: .claude/commit-gate.json has the mode ${JSON.stringify(mode)}, which is none of ${MODES.join(", ")}; it runs as observe`,
            }),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...input.tool_input, command: stamped },
        },
      })}\n`,
    );
    return 0;
  };
  if (verified || REASON.test(command)) return allow();

  const why =
    steps.length === 0
      ? "this session ran no review (/code-review, /review) and no /verify before this commit"
      : steps.some((step) => step.changed === undefined)
        ? "the tree of a review or verify step could not be compared with this commit's, so it is not known to be the same (`git add -A --dry-run` shows what git cannot read)"
        : "the tree changed after every review and verify step of this session";
  if (mode !== "enforce") {
    mkdirSync(state, { recursive: true });
    appendFileSync(
      join(state, "commit-gate.log"),
      `${new Date().toISOString()} would block session ${session}: ${why}\n`,
    );
    return allow();
  }
  if (record.blocked >= MAX_BLOCKS) {
    // Twice sent back: the third goes through, so a session cannot get stuck.
    record.blocked = 0;
    save();
    return allow();
  }
  record.blocked += 1;
  save();
  process.stderr.write(
    `commit gate: ${why}. Run /verify (and /review for code), then commit again; or say why in the message with a line \`Not-Verified: <reason>\`. Sent back ${record.blocked} of ${MAX_BLOCKS} times; the commit after that goes through.\n`,
  );
  return 2;
}

// Run as a script, not imported by a test. Real paths: a project folder
// reached through a link must not turn the gate into a script that does nothing.
const asScript = (() => {
  try {
    return (
      realpathSync(process.argv[1] ?? "") ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (!asScript) {
  // Imported: nothing runs.
} else if (process.argv[2] === "--log") {
  try {
    process.stdout.write(
      readFileSync(
        join(
          repository(process.cwd()) ?? ".git",
          "validate-kit",
          "commit-gate.log",
        ),
        "utf8",
      ),
    );
  } catch {
    // Nothing recorded: nothing to print.
  }
} else process.exitCode = main();
