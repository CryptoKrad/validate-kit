import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./isolated-git.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const helperUrl = new URL("../../../scripts/node-command.mjs", import.meta.url)
  .href;
type Invocation = { command: string; args: string[] };
type Resolution = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  execPath?: string;
  resolvePackage?: (name: string) => string;
  spawnSync?: typeof spawnSync;
};
const launcher = (await import(helperUrl)) as {
  resolveNodeCommand(
    command: string,
    args: string[],
    settings?: Resolution,
  ): Invocation;
  spawnNodeCommandSync: (
    command: string,
    args: string[],
    options?: Parameters<typeof spawnSync>[2],
  ) => ReturnType<typeof spawnSync>;
};
const temporary: string[] = [];

it("the actual smoke run helper gives a native Node child its owned temporary store", () => {
  const source = readFileSync(
    join(root, "scripts/smoke-external-package.mjs"),
    "utf8",
  );
  const declaration = source.match(
    /function run\(command, args, options = \{\}\)[^]*?\n\}/,
  )?.[0];
  if (!declaration)
    throw new Error("The actual smoke command helper is missing");
  const temporaryRoot = folder();
  const result: unknown = runInNewContext(
    `${declaration}; run("node", ["-e", "process.stdout.write(JSON.stringify({temporary:require('node:os').tmpdir(),marker:process.env.FIXTURE_MARKER}))"], {env:{TMPDIR:temporaryRoot,FIXTURE_MARKER:"kept literal"}}).stdout`,
    {
      spawnNodeCommandSync: launcher.spawnNodeCommandSync,
      process,
      repoRoot: root,
      temporaryRoot,
    },
  );
  expect(typeof result).toBe("string");
  expect(JSON.parse(String(result))).toEqual({
    temporary: temporaryRoot,
    marker: "kept literal",
  });
});

it("the actual smoke tool probe runs native shims and preserves nonzero help exits", () => {
  const tool = join(
    folder(),
    process.platform === "win32" ? "owned-help.cmd" : "owned-help",
  );
  writeFileSync(
    tool,
    process.platform === "win32"
      ? "@echo off\r\nexit /b 7\r\n"
      : "#!/bin/sh\nexit 7\n",
    { mode: 0o755 },
  );
  const source = readFileSync(
    join(root, "scripts/smoke-external-package.mjs"),
    "utf8",
  );
  const declaration = source.match(/function hasTool\([^]*?\n\}/)?.[0];
  if (!declaration) throw new Error("The actual smoke tool probe is missing");
  const globals = {
    createRequire,
    join,
    extname,
    delimiter,
    process,
    repoRoot: root,
    tool,
  };
  const present: unknown = runInNewContext(
    `${declaration}; hasTool(tool, ["--help"])`,
    globals,
  );
  const missing: unknown = runInNewContext(
    `${declaration}; hasTool(tool + ".missing", [])`,
    globals,
  );
  const jsBin = join(folder(), "owned-entry.mjs");
  writeFileSync(jsBin, "#!/usr/bin/env node\nprocess.exit(7);\n", {
    mode: 0o755,
  });
  const explicitJs: unknown = runInNewContext(
    `${declaration}; hasTool(tool, [])`,
    { ...globals, tool: jsBin },
  );
  const parentPath = process.env.PATH;
  const scoped: unknown = runInNewContext(
    `${declaration}; hasTool("owned-help", [], { PATH: toolDirectory })`,
    { ...globals, toolDirectory: dirname(tool) },
  );
  const options: object[] = [];
  const unavailable: unknown = runInNewContext(
    `${declaration}; hasTool(tool, [])`,
    {
      ...globals,
      createRequire: () =>
        Object.assign(
          () => ({
            whichCommandSync: () => tool,
            execaSync: (_bin: string, _args: string[], selected: object) => {
              options.push(selected);
              return { exitCode: 7, timedOut: true };
            },
          }),
          { resolve: () => "owned-execa-entry" },
        ),
    },
  );
  expect(present).toBe(true);
  expect(missing).toBe(false);
  expect(explicitJs).toBe(true);
  expect(scoped).toBe(true);
  expect(process.env.PATH).toBe(parentPath);
  expect(unavailable).toBe(false);
  expect(options).toEqual([
    { stdio: "ignore", reject: false, timeout: 30_000, windowsHide: true },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function folder() {
  // The real path: on macOS the temp folder is behind a link (/var is
  // /private/var), and the launcher under test answers with real paths.
  const path = realpathSync(mkdtempSync(join(tmpdir(), "vk-node-command-")));
  temporary.push(path);
  return path;
}

function manager(name = "pnpm", version = "10.34.9") {
  const directory = folder();
  const entry = join(
    directory,
    "bin",
    name === "pnpm" ? "pnpm.cjs" : "corepack.js",
  );
  mkdirSync(dirname(entry));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name,
      version,
      bin: { [name]: `bin/${name === "pnpm" ? "pnpm.cjs" : "corepack.js"}` },
    }),
  );
  writeFileSync(
    entry,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("fixture stderr");process.exit(7);',
  );
  return { directory, entry, manifest: join(directory, "package.json") };
}

function privateKit(repository?: object) {
  const consumer = join(folder(), "consumer with space");
  const packageRoot = join(consumer, "node_modules", "validate-kit");
  const bin = join(consumer, "node_modules", ".bin", "validate-kit");
  const entry = join(packageRoot, "bin", "validate-kit.mjs");
  const own = JSON.parse(
    readFileSync(
      join(root, "packages", "validate-kit", "package.json"),
      "utf8",
    ),
  ) as { repository: object };
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(bin));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "validate-kit",
      version: "0.2.5",
      repository: repository ?? own.repository,
      bin: {
        "validate-kit": "bin/validate-kit.mjs",
        check: "bin/validate-kit.mjs",
      },
    }),
  );
  writeFileSync(bin, "#!/bin/sh\nexit 99\n");
  writeFileSync(
    entry,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("private child");process.exit(7);',
  );
  return { consumer, packageRoot, bin, entry };
}

describe("script Node and pinned pnpm launch", () => {
  it("runs only the owned private kit's declared JS entry with literal argv", () => {
    const kit = privateKit();
    const args = ["init", "space name", "a&echo marker", "line\nbreak"];
    const result = launcher.spawnNodeCommandSync(kit.bin, args, {
      cwd: kit.consumer,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(JSON.parse(String(result.stdout))).toEqual(args);
    expect(String(result.stderr)).toBe("private child");
    expect(launcher.resolveNodeCommand(kit.bin, ["mcp"])).toEqual({
      command: process.execPath,
      args: [kit.entry, "mcp"],
    });
  });

  it("refuses the unrelated public package and a foreign repository without parsing their shell shim", () => {
    for (const repository of [
      {},
      {
        type: "git",
        url: "https://example.invalid/unrelated.git",
        directory: "packages/validate-kit",
      },
    ]) {
      const kit = privateKit(repository);
      expect(() => launcher.resolveNodeCommand(kit.bin, ["init"])).toThrow(
        "not the private toolkit",
      );
    }
  });

  it("the actual asynchronous MCP caller uses the same owned entry resolution", async () => {
    const kit = privateKit();
    const source = readFileSync(
      join(root, "scripts", "smoke-external-package.mjs"),
      "utf8",
    );
    const declaration = source.match(
      /async function mcpSession\([^]*?\n\}/,
    )?.[0];
    expect(declaration).toBeDefined();
    const calls: Invocation[] = [];
    const result: unknown = runInNewContext(
      `${declaration};mcpSession(cwd,bin)`,
      {
        cwd: kit.consumer,
        bin: kit.bin,
        process,
        resolveNodeCommand: (command: string, args: string[]) =>
          launcher.resolveNodeCommand(command, args),
        spawn(command: string, args: string[]) {
          calls.push({ command, args });
          throw new Error("MCP process boundary observed");
        },
      },
    );
    await expect(result).rejects.toThrow("MCP process boundary observed");
    expect(calls).toEqual([
      { command: process.execPath, args: [kit.entry, "mcp"] },
    ]);
  });

  it("uses the active Node executable and leaves other native tools unchanged", () => {
    expect(launcher.resolveNodeCommand("node", ["space name", "a&b"])).toEqual({
      command: process.execPath,
      args: ["space name", "a&b"],
    });
    expect(
      launcher.resolveNodeCommand("git", ["status", "--porcelain"]),
    ).toEqual({
      command: "git",
      args: ["status", "--porcelain"],
    });
  });

  it("runs the active pinned pnpm JS entry with literal argv and preserves stdout, stderr and exit", () => {
    const active = manager();
    const args = [
      "space name",
      'quote"value',
      "a&echo marker",
      "$(whoami)",
      "line\nbreak",
    ];
    const result = launcher.spawnNodeCommandSync("pnpm", args, {
      env: { ...process.env, npm_execpath: active.entry },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(JSON.parse(String(result.stdout))).toEqual(args);
    expect(String(result.stderr)).toBe("fixture stderr");
  });

  it("pins the official Corepack JS fallback even when cwd is a consumer with another manager", () => {
    const corepack = manager("corepack", "0.35.0");
    const consumer = folder();
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    );
    const invocation = launcher.resolveNodeCommand(
      "pnpm",
      ["exec", "tool with space"],
      {
        env: {},
        cwd: consumer,
        resolvePackage(name) {
          if (name === "corepack/package.json") return corepack.manifest;
          throw new Error("No active pnpm package");
        },
      },
    );
    expect(invocation).toEqual({
      command: process.execPath,
      args: [corepack.entry, "pnpm@10.34.9", "exec", "tool with space"],
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: consumer,
      encoding: "utf8",
      shell: false,
    });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual([
      "pnpm@10.34.9",
      "exec",
      "tool with space",
    ]);
  });

  it("supports a pinned native pnpm when Corepack and a JS entry are absent", () => {
    const probe = vi.fn<
      () => { status: number; stdout: string; stderr: string }
    >(() => ({ status: 0, stdout: "10.34.9\n", stderr: "" }));
    const invocation = launcher.resolveNodeCommand("pnpm", ["run", "check"], {
      env: {},
      resolvePackage() {
        throw new Error("No Corepack");
      },
      spawnSync: probe as unknown as typeof spawnSync,
    });
    expect(invocation).toEqual({ command: "pnpm", args: ["run", "check"] });
    expect(probe).toHaveBeenCalledWith(
      "pnpm",
      ["--version"],
      expect.objectContaining({ shell: false, timeout: 30_000 }),
    );
  });

  it("refuses a wrong-version JS entry and a mismatched or unavailable native pnpm", () => {
    const active = manager("pnpm", "9.0.0");
    for (const result of [
      { status: 0, stdout: "9.0.0\n" },
      { status: null, error: new Error("ENOENT") },
    ]) {
      expect(() =>
        launcher.resolveNodeCommand("pnpm", ["exec", "check"], {
          env: { npm_execpath: active.entry },
          resolvePackage() {
            throw new Error("No Corepack");
          },
          spawnSync: (() => result) as unknown as typeof spawnSync,
        }),
      ).toThrow("pnpm 10.34.9");
    }
  });

  it("preserves native start failures instead of converting them into success", () => {
    const result = launcher.spawnNodeCommandSync(
      join(folder(), "missing-native-tool"),
      [],
      { encoding: "utf8" },
    );
    expect(result.status).toBeNull();
    expect(result.error).toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "check-openapi.mjs",
    "check-pact.mjs",
    "smoke-external-package.mjs",
    "smoke-external-package-cleanup-probe.mjs",
  ])(
    "the actual %s caller preserves Node argv through its process boundary",
    (script) => {
      const fixture = folder();
      const active = manager();
      mkdirSync(join(fixture, "scripts"));
      mkdirSync(join(fixture, "apps", "api"), { recursive: true });
      writeFileSync(join(fixture, "apps", "api", "openapi.json"), "{}\n");
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ packageManager: "pnpm@10.34.9" }),
      );
      for (const file of [
        script,
        "node-command.mjs",
        ...(script === "check-openapi.mjs" ? ["native-oasdiff.mjs"] : []),
      ])
        writeFileSync(
          join(fixture, "scripts", file),
          readFileSync(join(root, "scripts", file)),
        );
      const entry = pathToFileURL(join(fixture, "scripts", script)).href;
      const code = `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const captured=[];const native={spawnSync:cp.spawnSync,execFileSync:cp.execFileSync,mkdtempSync:fs.mkdtempSync};
const intercept=(original)=>(command,args,options)=>{if(command===process.execPath && args[0]===${JSON.stringify(active.entry)}) {captured.push({command,args,shell:options?.shell??false});throw new Error('captured launch');}if(command==='git')return {status:0,stdout:'{}',stderr:''};return original(command,args,options);};
cp.spawnSync=intercept(native.spawnSync);cp.execFileSync=intercept(native.execFileSync);
fs.mkdtempSync=()=>native.mkdtempSync(${JSON.stringify(join(fixture, "owned-smoke-"))});syncBuiltinESMExports();
try{await import(${JSON.stringify(entry)});}catch(error){if(!captured.length)throw error;}
console.log(JSON.stringify(captured));`;
      // Windows passes one spelling of an environment key. Remove inherited
      // variants before supplying this fixture's package manager entry.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toLowerCase() !== "npm_execpath",
        ),
      );
      env.npm_execpath = active.entry;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", code],
        {
          cwd: fixture,
          env,
          encoding: "utf8",
          shell: false,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const captured = JSON.parse(
        result.stdout.trim().split("\n").at(-1) ?? "null",
      ) as Array<Invocation & { shell: boolean }>;
      expect(captured).toHaveLength(1);
      expect(captured[0]?.command).toBe(process.execPath);
      expect(captured[0]?.args[0]).toBe(active.entry);
      expect(captured[0]?.shell).toBe(false);
      const expected: Record<string, unknown[]> = {
        "check-openapi.mjs": ["exec", "tsx", "scripts/emit-openapi.ts"],
        "check-pact.mjs": [
          "--filter",
          "web",
          "exec",
          "vitest",
          "run",
          "contract/users.consumer.pact.test.ts",
        ],
        "smoke-external-package.mjs": [
          "--filter",
          "validate-kit",
          "pack",
          "--pack-destination",
          expect.any(String),
        ],
        "smoke-external-package-cleanup-probe.mjs": [
          "run",
          "smoke:external-package",
        ],
      };
      expect(captured[0]?.args.slice(1)).toEqual(expected[script]);
    },
  );
});
