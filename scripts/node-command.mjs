import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manager = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).packageManager;
const version = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manager)?.[1];
if (!version)
  throw new Error("package.json packageManager must pin pnpm to x.y.z");

function packageEntry(
  manifest,
  name,
  bin,
  expectedVersion,
  expectedRepository,
) {
  try {
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    if (
      data.name !== name ||
      (expectedVersion && data.version !== expectedVersion)
    )
      return;
    if (
      expectedRepository &&
      ["type", "url", "directory"].some(
        (key) => data.repository?.[key] !== expectedRepository[key],
      )
    )
      return;
    const relative = typeof data.bin === "string" ? data.bin : data.bin?.[bin];
    if (typeof relative !== "string") return;
    const entry = resolve(dirname(manifest), relative);
    if (!/\.(?:cjs|mjs|js)$/.test(entry) || !statSync(entry).isFile()) return;
    return realpathSync(entry);
  } catch {
    return;
  }
}

/** Keep argv separate from the executable, including on Windows. */
export function resolveNodeCommand(command, args, settings = {}) {
  const execPath = settings.execPath ?? process.execPath;
  if (command === "node") return { command: execPath, args: [...args] };
  if (
    isAbsolute(command) &&
    basename(dirname(command)) === ".bin" &&
    basename(dirname(dirname(command))) === "node_modules" &&
    ["validate-kit", "check"].includes(basename(command))
  ) {
    const own = JSON.parse(
      readFileSync(
        resolve(repoRoot, "packages/validate-kit/package.json"),
        "utf8",
      ),
    );
    const entry = packageEntry(
      resolve(dirname(command), "../validate-kit/package.json"),
      own.name,
      basename(command),
      undefined,
      own.repository,
    );
    if (!entry || !statSync(command).isFile())
      throw new Error("Requested validate-kit bin is not the private toolkit");
    return { command: execPath, args: [entry, ...args] };
  }
  if (command !== "pnpm") return { command, args: [...args] };
  const env = settings.env ?? process.env;
  const resolvePackage =
    settings.resolvePackage ?? createRequire(execPath).resolve;
  let active;
  try {
    if (env.npm_execpath && isAbsolute(env.npm_execpath)) {
      active = realpathSync(env.npm_execpath);
      const entry = packageEntry(
        resolve(dirname(active), "../package.json"),
        "pnpm",
        "pnpm",
        version,
      );
      if (entry === active)
        return { command: execPath, args: [entry, ...args] };
    }
  } catch {
    // A stale environment entry cannot authorize a different package manager.
  }
  for (const name of ["pnpm", "corepack"]) {
    try {
      const entry = packageEntry(
        resolvePackage(`${name}/package.json`),
        name,
        name === "pnpm" ? "pnpm" : "corepack",
        name === "pnpm" ? version : undefined,
      );
      if (entry)
        return {
          command: execPath,
          args: [entry, ...(name === "corepack" ? [manager] : []), ...args],
        };
    } catch {
      // Corepack is optional; standalone pnpm remains supported.
    }
  }
  const probe = (settings.spawnSync ?? spawnSync)("pnpm", ["--version"], {
    cwd: settings.cwd ?? process.cwd(),
    env,
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== version) {
    throw new Error(
      `A pnpm ${version} JavaScript entry, Corepack, or native executable is required`,
      { cause: probe.error },
    );
  }
  return { command: "pnpm", args: [...args] };
}

export function spawnNodeCommandSync(command, args, options = {}) {
  const invocation = resolveNodeCommand(command, args, {
    env: options.env,
    cwd: options.cwd,
  });
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}
