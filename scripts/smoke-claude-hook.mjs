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
  return { status: r.status, err: r.stderr.trim() };
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
// C: the retry may stop.
expect("C retry", hook({ hook_event_name: "Stop", stop_hook_active: true }), 0);
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
