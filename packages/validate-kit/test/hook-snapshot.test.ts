import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import "./isolated-git.js";

const cli = fileURLToPath(new URL("../bin/validate-kit.mjs", import.meta.url));
const temporary: string[] = [];
const sessions: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
  for (const session of sessions.splice(0))
    for (const who of ["main", "worker"])
      rmSync(join(tmpdir(), "validate-kit-claude-hook", `${session}-${who}`), {
        force: true,
      });
});

function repository() {
  const path = mkdtempSync(join(tmpdir(), "vk-hk-"));
  temporary.push(path);
  execFileSync("git", ["init", "--quiet"], { cwd: path });
  mkdirSync(join(path, "src"));
  writeFileSync(
    join(path, "validate.config.json"),
    '{"extends":"recommended"}\n',
  );
  writeFileSync(
    join(path, "package.json"),
    '{"name":"hook-fixture","private":true}\n',
  );
  writeFileSync(join(path, "src", "index.ts"), "console.log(1);\n");
  execFileSync("git", ["add", "src/index.ts"], { cwd: path });
  return path;
}

it("the public hook snapshots more than 1 MiB and returns the owned finding before other dirty files", () => {
  const cwd = repository();
  mkdirSync(join(cwd, "node_modules"));
  for (let index = 0; index < 6500; index++)
    writeFileSync(
      join(
        cwd,
        "node_modules",
        `${String(index).padStart(6, "0")}-${"x".repeat(145)}.dat`,
      ),
      "",
    );
  const status = execFileSync(
    "git",
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  expect(Buffer.byteLength(status)).toBeGreaterThan(1024 * 1024);
  const session = `hook-buffer-${process.pid}-${Date.now()}`;
  sessions.push(session);
  const event = (hook_event_name: string, stop_hook_active?: boolean) =>
    spawnSync(process.execPath, [cli, "hook", "claude"], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: session,
        cwd,
        hook_event_name,
        stop_hook_active,
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      timeout: 25_000,
    });
  const start = event("UserPromptSubmit");
  expect(start.status, start.stderr).toBe(0);
  const mark = JSON.parse(
    readFileSync(
      join(tmpdir(), "validate-kit-claude-hook", `${session}-main`),
      "utf8",
    ),
  ) as { files: Record<string, string> };
  expect(Object.keys(mark.files)).toHaveLength(6503);
  writeFileSync(join(cwd, "src", "turn.ts"), "console.log(2);\n");
  const stop = event("Stop");
  expect(stop.status, stop.stderr).toBe(2);
  expect(stop.stderr).toMatch(
    /your changes leave these findings[^]*src\/turn\.ts[^]*leave them[^]*src\/index\.ts/,
  );
  // The main agent has three rounds (MAX_ROUNDS in commands/hook.ts): with the
  // finding still open, the second stop is sent back too, and says which round.
  const retry = event("Stop", true);
  expect(retry.status, retry.stderr).toBe(2);
  expect(retry.stderr).toContain("round 2 of 3");
}, 30_000);

it.each(["Stop", "SubagentStop"])(
  "an unavailable native snapshot at %s is sent back like a finding, and the user is told when the rounds are used up",
  (hook_event_name) => {
    const cwd = repository();
    const preload = join(cwd, "native-status-failure.mjs");
    const observation = join(cwd, "native-status-options.json");
    writeFileSync(
      preload,
      `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){
if(command==='git'&&args.includes('status')){fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({maxBuffer:options.maxBuffer}));return {status:null,stdout:'',stderr:'',error:Object.assign(new Error('fixture output cap'),{code:'ENOBUFS'})};}return spawn(command,args,options);};syncBuiltinESMExports();`,
    );
    const session = `hook-unchecked-${process.pid}-${Date.now()}`;
    sessions.push(session);
    const event = (stop_hook_active?: boolean) =>
      spawnSync(process.execPath, [cli, "hook", "claude"], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify({
          session_id: session,
          cwd,
          hook_event_name,
          agent_type: "general-purpose",
          agent_id: "worker",
          stop_hook_active,
        }),
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: cwd,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        },
      });
    const first = event();
    expect(first.status, first.stderr).toBe(2);
    expect(first.stderr).toContain("your changes are unchecked");
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({
      maxBuffer: 20 * 1024 * 1024,
    });
    const mark = join(
      tmpdir(),
      "validate-kit-claude-hook",
      `${session}-${hook_event_name === "Stop" ? "main" : "worker"}`,
    );
    // The send-back is counted in the record, like any other: another stop
    // hook sets `stop_hook_active` too, so that flag alone lets nothing through.
    const rounds = () =>
      (JSON.parse(readFileSync(mark, "utf8")) as { rounds: number }).rounds;
    expect(rounds()).toBe(1);
    // The main agent has three rounds and a subagent one.
    const allowed = hook_event_name === "Stop" ? 3 : 1;
    for (let round = 2; round <= allowed; round++) {
      const again = event(true);
      expect(again.status, again.stderr).toBe(2);
      expect(again.stderr).toContain("your changes are unchecked");
      expect(rounds()).toBe(round);
    }
    // Then it may stop, and the user reads what was not checked.
    const last = event(true);
    expect(last.status, last.stderr).toBe(0);
    expect(last.stderr).toBe("");
    expect(last.stdout).toContain("this is still open");
    expect(last.stdout).toContain("your changes are unchecked");
  },
);

it("retains non-repository, unreadable-input and read-only hook behavior", () => {
  const cwd = mkdtempSync(join(tmpdir(), "vk-hk-nonrepo-"));
  temporary.push(cwd);
  for (const input of [
    "{invalid",
    JSON.stringify({ hook_event_name: "Stop" }),
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "Explore" }),
  ]) {
    const result = spawnSync(process.execPath, [cli, "hook", "claude"], {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  }
});
