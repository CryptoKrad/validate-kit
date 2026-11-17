#!/usr/bin/env node
// End to end for `validate-kit hook claude` (src/commands/hook.ts): the
// built CLI as Claude Code runs it, hook JSON on stdin, in a real git
// repository and one of its worktrees. Each case is one Claude Code event
// sequence; a failure prints the hook's stderr. Usage:
//   node scripts/smoke-claude-hook.mjs [path/to/cli.js]
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(
  process.argv[2] ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../packages/validate-kit/dist/cli.js",
    ),
);
// Real, as git prints it (/var is /private/var on macOS).
const root = realpathSync(mkdtempSync(join(tmpdir(), "vk-claude-hook-")));
const dir = join(root, "repo");
mkdirSync(join(dir, "src"), { recursive: true });
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.email=e@x.invalid", "-c", "user.name=e", ...args],
    { cwd: dir, encoding: "utf8" },
  );
git("init", "-q");
writeFileSync(
  join(dir, "validate.config.json"),
  '{ "extends": "recommended" }\n',
);
writeFileSync(join(dir, "src/clean.ts"), "export const a = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "base");

const session = `smoke-${process.pid}-${Date.now()}`;
const hook = (input, extra = {}) => {
  const r = spawnSync(process.execPath, [cli, "hook", "claude"], {
    cwd: dir,
    input:
      typeof input === "string"
        ? input
        : JSON.stringify({ session_id: session, cwd: dir, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extra },
  });
  return { status: r.status, err: r.stderr.trim(), out: r.stdout.trim() };
};
const bad = (name) => `export const ${name} = 1;\nconsole.log(${name});\n`;
const results = [];
const expect = (name, got, want, test = () => true) => {
  const ok = got.status === want && test(got.err);
  results.push(
    `${ok ? "ok  " : "FAIL"} ${name}: exit ${got.status}${ok ? "" : `\n${got.err}`}`,
  );
};

// A: a prompt, nothing changed, stop: silent.
hook({ hook_event_name: "UserPromptSubmit" });
expect("A no change", hook({ hook_event_name: "Stop" }), 0, (e) => e === "");
// B: the main agent writes a finding: sent back with it.
writeFileSync(join(dir, "src/mine.ts"), bad("mine"));
expect(
  "B own finding",
  hook({ hook_event_name: "Stop" }),
  2,
  (e) => e.includes("src/mine.ts") && !e.includes("Also found"),
);
// C: the finding is still there on the retries: sent back twice more, three
// times in all. Then it may stop, and the user is told what is left.
const retry = () => hook({ hook_event_name: "Stop", stop_hook_active: true });
expect("C round 2", retry(), 2, (e) => e.includes("round 2 of 3"));
expect("C round 3", retry(), 2, (e) => e.includes("round 3 of 3"));
const fourth = retry();
expect(
  "C fourth stop passes, the user is told",
  fourth,
  0,
  (e) =>
    e === "" &&
    /^validate-kit sent the agent back 3 times and this is still open:\n.*src\/mine\.ts/.test(
      JSON.parse(fourth.out).systemMessage,
    ) &&
    !/round|fix them/.test(fourth.out),
);
// C2: another stop hook continued the turn and the kit never sent this agent
// back: it is judged, as on a first stop.
hook({ hook_event_name: "UserPromptSubmit" });
writeFileSync(join(dir, "src/late.ts"), bad("late"));
expect("C2 continued by another hook", retry(), 2, (e) =>
  e.includes("src/late.ts"),
);
// C3: fixed on the retry: silent.
writeFileSync(join(dir, "src/late.ts"), "export const late = 1;\n");
expect("C3 fixed on the retry", retry(), 0, (e) => e === "");
// D: another agent's dirty file (there before this prompt) has a finding,
// this turn changed a clean file: not sent back.
writeFileSync(join(dir, "src/mine.ts"), "export const mine = 1;\n");
writeFileSync(join(dir, "src/theirs.ts"), bad("theirs"));
hook({ hook_event_name: "UserPromptSubmit" });
writeFileSync(join(dir, "src/clean.ts"), "export const a = 2;\n");
expect("D others only", hook({ hook_event_name: "Stop" }), 0, (e) => e === "");
// E: this turn writes a finding too: sent back with its own first, the
// other agent's under "leave them".
hook({ hook_event_name: "UserPromptSubmit" });
writeFileSync(join(dir, "src/clean.ts"), bad("a"));
expect(
  "E own and others",
  hook({ hook_event_name: "Stop" }),
  2,
  (e) =>
    e.indexOf("src/clean.ts") < e.indexOf("Also found") &&
    e.indexOf("src/theirs.ts") > e.indexOf("Also found"),
);
writeFileSync(join(dir, "src/clean.ts"), "export const a = 2;\n");
// F: a read-only subagent: never sent back, though the tree has findings.
hook({
  hook_event_name: "SubagentStart",
  agent_id: "r1",
  agent_type: "Explore",
});
expect(
  "F read-only subagent",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "r1",
    agent_type: "Explore",
  }),
  0,
);
// G: Claude Code's own helper (no agent type): not judged.
expect(
  "G helper",
  hook({ hook_event_name: "SubagentStop", agent_id: "h1", agent_type: "" }),
  0,
);
// H: a subagent that writes a finding: sent back.
hook({
  hook_event_name: "SubagentStart",
  agent_id: "w1",
  agent_type: "general-purpose",
});
writeFileSync(join(dir, "src/sub.ts"), bad("sub"));
expect(
  "H subagent finding",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w1",
    agent_type: "general-purpose",
  }),
  2,
  (e) => e.includes("src/sub.ts"),
);
// H1: a subagent is sent back once: with the finding still there, its next
// stop passes and the user is told.
const again = hook({
  hook_event_name: "SubagentStop",
  agent_id: "w1",
  agent_type: "general-purpose",
  stop_hook_active: true,
});
expect(
  "H1 a subagent is sent back once",
  again,
  0,
  (e) =>
    e === "" &&
    /sent the agent back once.*src\/sub\.ts/s.test(
      JSON.parse(again.out).systemMessage,
    ),
);
// R: a project subagent defined with no editing tool (a reviewer) is not
// judged, though a file changed while it ran; one defined with Edit is.
mkdirSync(join(dir, ".claude/agents"), { recursive: true });
writeFileSync(
  join(dir, ".claude/agents/reviewer.md"),
  "---\nname: reviewer\ndescription: reviews\ntools: Read, Grep, Bash\n---\nReview.\n",
);
writeFileSync(
  join(dir, ".claude/agents/fixer.md"),
  "---\nname: fixer\ndescription: fixes\ntools: Read, Edit, Bash\n---\nFix.\n",
);
for (const [type, want] of [
  ["reviewer", 0],
  ["fixer", 2],
]) {
  hook({ hook_event_name: "SubagentStart", agent_id: type, agent_type: type });
  writeFileSync(join(dir, "src/sub.ts"), bad(`sub${type}`));
  expect(
    `R ${type}: a subagent ${want === 0 ? "with no editing tool is not judged" : "that can edit is judged"}`,
    hook({ hook_event_name: "SubagentStop", agent_id: type, agent_type: type }),
    want,
  );
}
rmSync(join(dir, ".claude"), { recursive: true });
// H2: stopped again after fixing, with no change since its last stop: silent.
writeFileSync(join(dir, "src/sub.ts"), "export const sub = 1;\n");
hook({
  hook_event_name: "SubagentStop",
  agent_id: "w1",
  agent_type: "general-purpose",
  stop_hook_active: true,
});
expect(
  "H2 resumed, nothing new",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w1",
    agent_type: "general-purpose",
  }),
  0,
);
// I: no record of a start (a session started before the hook): every
// uncommitted file counts as its own.
expect(
  "I no record",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "new",
    agent_type: "general-purpose",
  }),
  2,
  (e) => e.includes("src/theirs.ts"),
);
// J: a subagent in its own worktree is judged there.
rmSync(join(dir, "src/theirs.ts"));
const wt = join(root, "wt");
git("worktree", "add", "-q", wt);
hook({
  hook_event_name: "SubagentStart",
  agent_id: "w2",
  agent_type: "general-purpose",
  cwd: wt,
});
writeFileSync(join(wt, "src/wt.ts"), bad("wt"));
expect(
  "J worktree",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w2",
    agent_type: "general-purpose",
    cwd: wt,
  }),
  2,
  (e) => e.includes("src/wt.ts"),
);
// K: a JS package with no install: says so.
// A package that declares nothing needs no install: judged as usual.
writeFileSync(join(wt, "package.json"), "{}\n");
hook({
  hook_event_name: "SubagentStart",
  agent_id: "w2b",
  agent_type: "general-purpose",
  cwd: wt,
});
writeFileSync(join(wt, "src/wt3.ts"), bad("wt3"));
expect(
  "K0 no deps, no install line",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w2b",
    agent_type: "general-purpose",
    cwd: wt,
  }),
  2,
  (e) => e.includes("src/wt3.ts") && !e.includes("no node_modules"),
);
rmSync(join(wt, "src/wt3.ts"));
writeFileSync(
  join(wt, "package.json"),
  '{ "devDependencies": { "typescript": "5.9.3" } }\n',
);
hook({
  hook_event_name: "SubagentStart",
  agent_id: "w3",
  agent_type: "general-purpose",
  cwd: wt,
});
writeFileSync(join(wt, "src/wt2.ts"), bad("wt2"));
expect(
  "K no node_modules",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w3",
    agent_type: "general-purpose",
    cwd: wt,
  }),
  2,
  (e) => e.includes("no node_modules"),
);
// M: an agent that only deleted a file is judged too (here the install
// line shows it was).
git("-C", wt, "add", "-A");
git("-C", wt, "commit", "-q", "-m", "wt");
hook({
  hook_event_name: "SubagentStart",
  agent_id: "w4",
  agent_type: "general-purpose",
  cwd: wt,
});
rmSync(join(wt, "src/wt.ts"));
expect(
  "M deletion only",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "w4",
    agent_type: "general-purpose",
    cwd: wt,
  }),
  2,
  (e) => e.includes("no node_modules"),
);
// N: an event this hook does not answer (PreToolUse) never blocks.
expect("N other event", hook({ hook_event_name: "PreToolUse" }), 0);
// O: Explore cannot edit: not judged, though another agent wrote meanwhile.
hook({
  hook_event_name: "SubagentStart",
  agent_id: "x1",
  agent_type: "Explore",
});
writeFileSync(join(dir, "src/parallel.ts"), bad("parallel"));
expect(
  "O Explore while another writes",
  hook({
    hook_event_name: "SubagentStop",
    agent_id: "x1",
    agent_type: "Explore",
  }),
  0,
);
rmSync(join(dir, "src/parallel.ts"));
// P: no session id: no shared record; every uncommitted file is its own.
writeFileSync(join(dir, "src/nosession.ts"), bad("nosession"));
expect(
  "P no session id",
  hook({ hook_event_name: "Stop", session_id: "" }),
  2,
  (e) => e.includes("src/nosession.ts"),
);
// P2: with no record to count rounds in, the retry is the last round: it may
// stop, and the user is told.
const unrecorded = hook({
  hook_event_name: "Stop",
  session_id: "",
  stop_hook_active: true,
});
expect(
  "P2 no session id, the retry passes and the user is told",
  unrecorded,
  0,
  (e) =>
    e === "" &&
    /sent the agent back once.*src\/nosession\.ts/s.test(
      JSON.parse(unrecorded.out).systemMessage,
    ),
);
rmSync(join(dir, "src/nosession.ts"));
// Q: another agent's file with 60 findings does not hide this agent's one.
writeFileSync(
  join(dir, "src/noisy.ts"),
  Array.from({ length: 60 }, (_, i) => `console.log(${i});\n`).join(""),
);
hook({ hook_event_name: "UserPromptSubmit" });
writeFileSync(join(dir, "src/zz-late.ts"), bad("late"));
expect(
  "Q own finding behind 60 others",
  hook({ hook_event_name: "Stop" }),
  2,
  (e) =>
    e.indexOf("src/zz-late.ts") < e.indexOf("Also found") &&
    e.includes("... 40 more"),
);
rmSync(join(dir, "src/noisy.ts"));
rmSync(join(dir, "src/zz-late.ts"));
// L: unreadable input: let it stop.
expect("L bad input", hook("{not json"), 0);
git("worktree", "remove", "--force", wt);
// The hook's records for this run, and the repository.
const marks = join(tmpdir(), "validate-kit-claude-hook");
for (const name of readdirSync(marks))
  if (name.startsWith(session)) rmSync(join(marks, name));
rmSync(root, { recursive: true, force: true });
console.log(results.join("\n"));
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
