#!/usr/bin/env node
// End to end for scripts/commit-gate.mjs: the script as Claude Code runs it,
// hook JSON on stdin, in a real git repository. The last case runs the
// stamped command through git and reads the trailer back. Usage:
//   node scripts/smoke-commit-gate.mjs
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gate = join(dirname(fileURLToPath(import.meta.url)), "commit-gate.mjs");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "vk-commit-gate-")));
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.email=e@x.invalid", "-c", "user.name=e", ...args],
    { cwd: dir, encoding: "utf8" },
  );
git("init", "-q");
mkdirSync(join(dir, ".claude"));
mkdirSync(join(dir, "pkg"));
// Another repository: a commit there is not this gate's.
const other = realpathSync(
  mkdtempSync(join(tmpdir(), "vk-commit-gate-other-")),
);
execFileSync("git", ["init", "-q"], { cwd: other });
const mode = (name) =>
  writeFileSync(
    join(dir, ".claude", "commit-gate.json"),
    JSON.stringify({ mode: name }),
  );
const hook = (session, input) => {
  const run = spawnSync(process.execPath, [gate], {
    cwd: dir,
    input: JSON.stringify({ session_id: session, cwd: dir, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  let command;
  try {
    command = JSON.parse(run.stdout).hookSpecificOutput.updatedInput.command;
  } catch {
    // The hook printed nothing: the command is left as it was.
  }
  return { status: run.status, err: run.stderr.trim(), command };
};
const commit = (session, command = 'git commit -q -m "change"') =>
  hook(session, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
const log = join(dir, ".git", "validate-kit", "commit-gate.log");
const results = [];
const expect = (name, ok, detail = "") =>
  results.push(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);

// A: observe mode, a session that ran nothing: let through, stamped none, logged.
let got = commit("a");
expect(
  "A observe: stamped none and logged",
  got.status === 0 &&
    got.command === 'git commit --trailer "Verified: none" -q -m "change"' &&
    readFileSync(log, "utf8").includes("would block session a"),
  JSON.stringify(got),
);
// B: the model ran the verify skill, the user typed /code-review: both stamped.
hook("b", {
  hook_event_name: "PostToolUse",
  tool_name: "Skill",
  tool_input: { skill: "verify" },
});
got = commit("b");
expect(
  "B a verify skill is recorded",
  got.command?.includes('--trailer "Verified: verify"'),
  JSON.stringify(got),
);
hook("b", {
  hook_event_name: "UserPromptExpansion",
  command_name: "code-review",
});
got = commit("b", "cd pkg && git -C . commit -F - <<'EOF'\nmsg\nEOF");
expect(
  "B2 a typed /code-review too, in a compound command",
  got.command ===
    "cd pkg && git -C . commit --trailer \"Verified: review, verify\" -F - <<'EOF'\nmsg\nEOF",
  JSON.stringify(got),
);
// C: a reviewer counts by what it reported: a clean report is a review, a
// report with findings is stamped with their count, no report is nothing.
const reviewer = (session, said) =>
  hook(session, {
    hook_event_name: "SubagentStop",
    agent_type: "reviewer",
    last_assistant_message: said,
  });
reviewer("c", "Important findings: 0\n\nNothing to fix.");
expect(
  "C a reviewer's clean report is a review",
  commit("c").command?.includes('"Verified: review"'),
);
reviewer("c2", "**Important findings: 2**\n\n1. ...");
expect(
  "C2 a report with findings is stamped with their count",
  commit("c2").command?.includes(
    '"Verified: review (2 Important in its last report)"',
  ),
  commit("c2").command,
);
reviewer("c3", "I could not review anything.");
expect(
  "C3 a reviewer that reported nothing is not a review",
  commit("c3").command?.includes("Verified: none"),
);
// C4: a grader counts when its last line is "satisfied".
const grader = (session, said) =>
  hook(session, {
    hook_event_name: "SubagentStop",
    agent_type: "grader",
    last_assistant_message: said,
  });
grader("c4", "1 met: ...\nneeds revision: 3");
grader("c5", "1 met: ...\n\nsatisfied\n");
expect(
  "C4 a grader counts only when satisfied",
  commit("c4").command?.includes("Verified: none") &&
    commit("c5").command?.includes('"Verified: graded"'),
  `${commit("c4").command} / ${commit("c5").command}`,
);
// C4n: the last line is the verdict. A grading with a line after its
// `satisfied` is not recorded: a rule that lets a note follow also lets a
// fail follow (tasks/review-rounds.md, 2026-11-19).
grader("c4n", "1 met: ...\nsatisfied\nLogs: logs/grader.txt");
grader("c4o", "1 met: ...\nsatisfied\nCorrection: criterion 3 is not yet met.");
expect(
  "C4n a grading with a line after its verdict is not recorded",
  commit("c4n").command?.includes("Verified: none") &&
    commit("c4o").command?.includes("Verified: none"),
  `${commit("c4n").command} / ${commit("c4o").command}`,
);
// C6: a chain is not a step: /ship and /go record nothing by being typed.
for (const name of ["ship", "go"])
  hook("c6", { hook_event_name: "UserPromptExpansion", command_name: name });
expect(
  "C6 typing /ship or /go verifies nothing",
  commit("c6").command?.includes("Verified: none"),
);
// C7: the security review is a step of its own in the stamp, not a review.
hook("c7", {
  hook_event_name: "UserPromptExpansion",
  command_name: "security-review",
});
expect(
  "C7 /security-review is stamped as security",
  commit("c7").command?.includes('"Verified: security"'),
  commit("c7").command,
);
// D: enforce: sent back twice, the third goes through.
mode("enforce");
const first = commit("d");
const second = commit("d");
const third = commit("d");
expect(
  "D enforce: sent back twice, then through",
  first.status === 2 &&
    first.err.includes("1 of 2") &&
    second.status === 2 &&
    third.status === 0 &&
    third.command?.includes("Verified: none"),
  JSON.stringify([first, second, third]),
);
// E: enforce: a reason in the message goes through.
got = commit(
  "e",
  'git commit -m "docs" -m "Not-Verified: a typo in a comment"',
);
expect(
  "E enforce: a stated reason goes through",
  got.status === 0 && got.command?.includes("Verified: none"),
  JSON.stringify(got),
);
// F: enforce: a session that verified is not sent back.
hook("f", { hook_event_name: "UserPromptExpansion", command_name: "/verify" });
expect("F enforce: a verified session commits", commit("f").status === 0);
// G: what is not a commit in this repository is left alone: other git
// commands, the words in quoted text, a comment or a here-document, and a
// commit in another repository or in a folder the text does not name.
for (const command of [
  "git commit-tree HEAD^{tree}",
  "git status",
  'echo "git commit"',
  'gh pr create --body "then git commit it"',
  "node -e 'run(\"x; git commit -m y\")'",
  "cat > notes.md <<'EOF'\ngit commit -m x\nEOF",
  "ls # git commit",
  "git commit --dry-run",
  `cd ${other} && git commit -m x`,
  `git -C "${other}" commit -m x`,
  'cd "$SOMEWHERE" && git commit -m x',
  "cd - && git commit -m x",
  "cd -P .. && git commit -m x",
  // Where the folder or the repository is not certain, the commit is not ours.
  `pushd ${other} && git commit -m x`,
  "popd && git commit -m x",
  `GIT_DIR=${other}/.git git commit -m x`,
  `export GIT_DIR=${other}/.git; git commit -m x`,
  "git commit -m x --dry-run",
  "git commit -m x 2>&1 --dry-run",
  // A here-document inside "$( )": a quote in its text does not end the string.
  'gh pr create --body "$(cat <<\'EOF\'\nThe 5" screen.\n\ngit commit is stamped once.\ncd /tmp\nEOF\n)"',
  "echo $'it\\'s' 'x\ngit commit -m y'",
]) {
  got = commit("g", command);
  expect(
    `G left alone: ${command.split("\n")[0]}`,
    got.status === 0 && got.command === undefined,
    JSON.stringify(got),
  );
}
// G2: a commit after other commands, after a here-document, with a variable
// set before it, and two commits in one command, are each stamped once.
for (const [command, want] of [
  [
    `cd ${other} && ls; cd ${dir} && git commit -m x`,
    `cd ${other} && ls; cd ${dir} && git commit --trailer "Verified: verify" -m x`,
  ],
  [
    "cat > m <<EOF\ngit commit\nEOF\ngit commit -F m",
    'cat > m <<EOF\ngit commit\nEOF\ngit commit --trailer "Verified: verify" -F m',
  ],
  [
    "GIT_AUTHOR_DATE=now git commit -m x",
    'GIT_AUTHOR_DATE=now git commit --trailer "Verified: verify" -m x',
  ],
  [
    "git commit -m a && git commit -m b",
    'git commit --trailer "Verified: verify" -m a && git commit --trailer "Verified: verify" -m b',
  ],
  [
    "git commit --trailer=Verified:mine -m x",
    "git commit --trailer=Verified:mine -m x",
  ],
  // The message is not a command line: a quote, the words and a flag in it.
  [
    'git commit -m "$(cat <<\'EOF\'\nfix: the 5" screen\n\ngit commit --dry-run runs here\nEOF\n)"',
    'git commit --trailer "Verified: verify" -m "$(cat <<\'EOF\'\nfix: the 5" screen\n\ngit commit --dry-run runs here\nEOF\n)"',
  ],
  // --dry-run counts on the commit it is given to, and nowhere else.
  [
    "pnpm run build --dry-run && git commit -m x",
    'pnpm run build --dry-run && git commit --trailer "Verified: verify" -m x',
  ],
  [
    "git commit --dry-run; git commit -m x",
    'git commit --dry-run; git commit --trailer "Verified: verify" -m x',
  ],
  // A cd inside ( ) ends with it; $(( )) is arithmetic, not a here-document.
  [
    `(cd ${other} && git status) && git commit -m x`,
    `(cd ${other} && git status) && git commit --trailer "Verified: verify" -m x`,
  ],
  [
    "echo $((1<<2))\ngit commit -m x",
    'echo $((1<<2))\ngit commit --trailer "Verified: verify" -m x',
  ],
  // A redirection, a here-string and (( )) end nothing; a keyword leads to a command.
  [
    "git commit -m x 2>&1 | tail -1",
    'git commit --trailer "Verified: verify" -m x 2>&1 | tail -1',
  ],
  [
    "cat <<< x\ngit commit -m y",
    'cat <<< x\ngit commit --trailer "Verified: verify" -m y',
  ],
  [
    "(( n = 1 << 2 ))\ngit commit -m y",
    '(( n = 1 << 2 ))\ngit commit --trailer "Verified: verify" -m y',
  ],
  [
    "if git diff --cached --quiet; then :; else git commit -m x; fi",
    'if git diff --cached --quiet; then :; else git commit --trailer "Verified: verify" -m x; fi',
  ],
  // A commit inside "$( )" is a command.
  [
    'echo "$(git commit -m x)"',
    'echo "$(git commit --trailer "Verified: verify" -m x)"',
  ],
]) {
  got = commit("f", command);
  expect(
    `G2 stamped: ${command.split("\n")[0]}`,
    got.command === want,
    got.command,
  );
}
// G3: enforce without a session id: nothing to count under, so no gate.
got = commit("", "git commit -m x");
expect(
  "G3 no session: untouched",
  got.status === 0 && got.command === undefined,
  JSON.stringify(got),
);
// G4: a mode that is not one of the three is said, and runs as observe.
mode("enforced");
const typo = spawnSync(process.execPath, [gate], {
  cwd: dir,
  input: JSON.stringify({
    session_id: "g4",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit -m x" },
  }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
expect(
  "G4 an unknown mode is said",
  typo.status === 0 && /enforced.*runs as observe/.test(typo.stdout),
  typo.stdout,
);
// H: off: nothing is stamped, gated or recorded.
mode("off");
got = commit("h");
expect(
  "H off: untouched",
  got.status === 0 &&
    got.command === undefined &&
    !existsSync(join(dir, ".git", "validate-kit", "sessions", "h.json")),
);
// I: the stamped command is one git accepts, and the trailer is in the commit.
mode("observe");
writeFileSync(join(dir, "file"), "x\n");
git("add", "file");
hook("i", { hook_event_name: "UserPromptExpansion", command_name: "verify" });
got = commit(
  "i",
  'git -c user.email=e@x.invalid -c user.name=e commit -q -m "add a file"',
);
execFileSync("sh", ["-c", got.command ?? "false"], { cwd: dir });
expect(
  "I git takes the stamped command",
  git("log", "-1", "--format=%(trailers:key=Verified,valueonly)").trim() ===
    "verify",
  got.command,
);
// T: a step counts for the tree it ran on. A file that changes after the
// verify is said in the stamp and the step no longer counts; the same tree
// again, or a commit in between, changes nothing.
hook("t", { hook_event_name: "UserPromptExpansion", command_name: "verify" });
expect(
  "T1 the tree a verify ran on is verified",
  commit("t").command?.includes('"Verified: verify"'),
  commit("t").command,
);
writeFileSync(join(dir, "file"), "changed\n");
writeFileSync(join(dir, "new-file"), "new\n");
got = commit("t");
expect(
  "T2 files changed after the verify are counted in the stamp",
  got.command?.includes('"Verified: verify (2 files changed since)"') &&
    readFileSync(log, "utf8").includes(
      "session t: the tree changed after every review and verify step",
    ),
  got.command,
);
mode("enforce");
hook("t2", { hook_event_name: "UserPromptExpansion", command_name: "verify" });
writeFileSync(join(dir, "new-file"), "newer\n");
got = commit("t2");
expect(
  "T3 enforce: a verify of an older tree does not let a commit through",
  got.status === 2 && got.err.includes("the tree changed after every"),
  JSON.stringify(got),
);
writeFileSync(join(dir, "new-file"), "new\n");
got = commit("t2");
expect(
  "T4 the same tree again is verified again",
  got.status === 0 && got.command?.includes('"Verified: verify"'),
  JSON.stringify(got),
);
git("add", "-A");
git("commit", "-q", "-m", "between");
got = commit("t2");
expect(
  "T5 a commit in between changes nothing: the files are the same",
  got.status === 0 && got.command?.includes('"Verified: verify"'),
  JSON.stringify(got),
);
// A tree that is not known is not "the same": the step's tree pruned away,
// and a step recorded with no tree (git could not read the work tree then).
writeFileSync(join(dir, "file"), "in no commit\n");
hook("t3", { hook_event_name: "UserPromptExpansion", command_name: "verify" });
writeFileSync(join(dir, "new-file"), "after the verify\n");
git("prune", "--expire=now");
got = commit("t3");
expect(
  "T6 enforce: a step whose tree git no longer has does not count",
  got.status === 2 && got.err.includes("could not be compared"),
  JSON.stringify(got),
);
mode("observe");
got = commit("t3");
expect(
  "T7 the stamp says the tree could not be compared",
  got.command?.includes(
    '"Verified: verify (its tree could not be compared with this one)"',
  ),
  got.command,
);
mode("enforce");
writeFileSync(
  join(dir, ".git", "validate-kit", "sessions", "t4.json"),
  JSON.stringify({ ran: { verify: "2026-11-16T00:00:00.000Z" }, tree: {} }),
);
got = commit("t4");
expect(
  "T8 enforce: a step recorded with no tree does not count",
  got.status === 2 && got.err.includes("could not be compared"),
  JSON.stringify(got),
);

process.stdout.write(`${results.join("\n")}\n`);
process.exitCode = results.some((line) => line.startsWith("FAIL")) ? 1 : 0;
