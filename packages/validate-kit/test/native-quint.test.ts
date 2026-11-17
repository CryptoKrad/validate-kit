import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";

type Output = { status: number; stdout: string; stderr: string };
type Spawn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => Output;
type Command = { binary: string; binDirectory: string; version: string };
const { nativeQuint } = (await import(
  new URL("../../../scripts/native-quint.mjs", import.meta.url).href
)) as {
  nativeQuint: (settings?: {
    cacheRoot?: string;
    spawnSync?: Spawn;
  }) => Command;
};
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = readFileSync(
  join(repo, ".github/workflows/validate.yml"),
  "utf8",
);
const pin = /@informalsystems\/quint@(\d+\.\d+\.\d+)/.exec(workflow)?.[1];
if (!pin) throw new Error("The workflow's Quint pin is missing");
const version = pin;
const name = "@informalsystems/quint";
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vk-quint-cache-"));
  temporary.push(root);
  const cache = join(
    root,
    "validate-kit-native-tests",
    process.platform,
    process.arch,
    "quint",
    version,
  );
  const manifest = join(cache, "node_modules", name, "package.json");
  const binary = join(dirname(manifest), "cli.js");
  const binDirectory = join(cache, "node_modules", ".bin");
  const shim = join(
    binDirectory,
    process.platform === "win32" ? "quint.cmd" : "quint",
  );
  const install = (identity = name, release = version) => {
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(
      join(cache, "package.json"),
      JSON.stringify({
        name: "validate-kit-native-formal-tests",
        private: true,
      }),
    );
    writeFileSync(
      manifest,
      JSON.stringify({
        name: identity,
        version: release,
        bin: { quint: "cli.js" },
      }),
    );
    writeFileSync(
      binary,
      `process.stdout.write(${JSON.stringify(`${version}\n`)});`,
    );
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(shim, "fixture shim\n");
  };
  return {
    root,
    cache,
    binary,
    shim,
    install,
    command: { binary, binDirectory, version },
  };
}

it("runs the actual cached formal CLI at the current hosted workflow pin", () => {
  const command = nativeQuint();
  expect(
    execFileSync(process.execPath, [command.binary, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim(),
  ).toBe(version);
  expect(command.version).toBe(version);
}, 660_000);

it("loads the owned package on each new call and verifies its actual CLI version", () => {
  const f = fixture();
  f.install();
  const calls: string[][] = [];
  const spawnSync: Spawn = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: `${version}\n`, stderr: "" };
  };
  expect(nativeQuint({ cacheRoot: f.root, spawnSync })).toEqual(f.command);
  expect(nativeQuint({ cacheRoot: f.root, spawnSync })).toEqual(f.command);
  expect(calls).toEqual([
    ["node", f.binary, "--version"],
    ["node", f.binary, "--version"],
  ]);
});

it.each([
  ["unrelated-package", version, true],
  [name, "0.0.0", true],
  [name, version, false],
] as const)(
  "repairs identity %s version %s shim=%s through the pinned installer",
  (identity, release, hasShim) => {
    const f = fixture();
    f.install(identity, release);
    if (!hasShim) rmSync(f.shim);
    const calls: string[][] = [];
    const installs: { args: string[]; timeout: unknown; policy: unknown }[] =
      [];
    const spawnSync: Spawn = (command, args, options) => {
      calls.push([command, ...args]);
      if (command === "pnpm") {
        installs.push({
          args,
          timeout: options.timeout,
          policy: parse(
            readFileSync(join(f.cache, "pnpm-workspace.yaml"), "utf8"),
          ) as unknown,
        });
        f.install();
        // A second installer can have completed after this process lost a race.
        return { status: 1, stdout: "", stderr: "concurrent install" };
      }
      return { status: 0, stdout: `${version}\n`, stderr: "" };
    };
    expect(nativeQuint({ cacheRoot: f.root, spawnSync })).toEqual(f.command);
    expect(calls).toHaveLength(2);
    const policy = parse(
      readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(installs).toEqual([
      {
        args: [
          "--dir",
          f.cache,
          "add",
          "--save-exact",
          "--ignore-scripts",
          `${name}@${version}`,
        ],
        timeout: 600_000,
        policy: { ...policy, packages: [] },
      },
    ]);
  },
);

it("fails an incomplete install instead of treating a missing CLI as optional", () => {
  const f = fixture();
  const calls: string[] = [];
  const spawnSync: Spawn = (command) => {
    calls.push(command);
    return { status: 1, stdout: "", stderr: "fixture refusal" };
  };
  expect(() => nativeQuint({ cacheRoot: f.root, spawnSync })).toThrow(
    "fixture refusal",
  );
  expect(calls).toEqual(["pnpm"]);
});

it("refuses a foreign cache project before the installer can change it", () => {
  const f = fixture();
  f.install();
  const foreign = JSON.stringify({ name: "someone-else", private: true });
  writeFileSync(join(f.cache, "package.json"), foreign);
  const calls: string[] = [];
  const spawnSync: Spawn = (command) => {
    calls.push(command);
    return { status: 0, stdout: "", stderr: "" };
  };
  expect(() => nativeQuint({ cacheRoot: f.root, spawnSync })).toThrow(
    "belongs to another project",
  );
  expect(calls).toEqual([]);
  expect(readFileSync(join(f.cache, "package.json"), "utf8")).toBe(foreign);
  rmSync(join(f.cache, "package.json"));
  expect(() => nativeQuint({ cacheRoot: f.root, spawnSync })).toThrow(
    "has no ownership marker",
  );
  expect(calls).toEqual([]);
});

it.each([
  { status: 0, stdout: "0.0.0\n", stderr: "wrong version" },
  { status: 1, stdout: `${version}\n`, stderr: "failed CLI" },
])("rejects an unproved CLI response %#", (response) => {
  const f = fixture();
  f.install();
  expect(() =>
    nativeQuint({ cacheRoot: f.root, spawnSync: () => response }),
  ).toThrow(`did not report ${version}`);
});
