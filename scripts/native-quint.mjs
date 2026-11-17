import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { spawnNodeCommandSync } from "./node-command.mjs";

/** The real formal-test CLI, using the existing hosted validation pin. */
export function nativeQuint(settings = {}) {
  const name = "@informalsystems/quint";
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workflow = readFileSync(
    join(root, ".github/workflows/validate.yml"),
    "utf8",
  );
  const version =
    /npm install --global @informalsystems\/quint@(\d+\.\d+\.\d+)\b/.exec(
      workflow,
    )?.[1];
  if (!version) throw new Error("The formal-test workflow must pin Quint");
  const cache = resolve(
    settings.cacheRoot ?? tmpdir(),
    "validate-kit-native-tests",
    process.platform,
    process.arch,
    "quint",
    version,
  );
  const manifest = join(cache, "node_modules", name, "package.json");
  const binDirectory = join(cache, "node_modules", ".bin");
  const shim = join(
    binDirectory,
    process.platform === "win32" ? "quint.cmd" : "quint",
  );
  const entry = () => {
    try {
      const data = JSON.parse(readFileSync(manifest, "utf8"));
      if (data.name !== name || data.version !== version) return;
      const bin = typeof data.bin === "string" ? data.bin : data.bin?.quint;
      if (typeof bin !== "string") return;
      const path = resolve(dirname(manifest), bin);
      if (!/\.(?:cjs|mjs|js)$/.test(path) || !statSync(path).isFile()) return;
      return path;
    } catch {
      return;
    }
  };
  const run = (command, args, options = {}) =>
    (settings.spawnSync ?? spawnNodeCommandSync)(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      ...options,
    });
  const ready = () => {
    const binary = entry();
    try {
      return binary && statSync(shim).isFile() ? binary : undefined;
    } catch {
      return;
    }
  };
  const project = join(cache, "package.json");
  let projectMissing = false;
  try {
    const data = JSON.parse(readFileSync(project, "utf8"));
    if (
      data.name !== "validate-kit-native-formal-tests" ||
      data.private !== true
    )
      throw new Error("The formal-test cache belongs to another project");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (existsSync(cache) && readdirSync(cache).length !== 0)
      throw new Error("The formal-test cache has no ownership marker", {
        cause: error,
      });
    projectMissing = true;
  }
  if (!ready()) {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (projectMissing) {
      writeFileSync(
        project,
        JSON.stringify({
          name: "validate-kit-native-formal-tests",
          private: true,
        }),
      );
    }
    // Keep the cache independent of a surrounding workspace and use this
    // repository's existing package-admission policy, including its cooldown.
    const policy = parse(
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    );
    writeFileSync(
      join(cache, "pnpm-workspace.yaml"),
      stringify({ ...policy, packages: [] }),
    );
    const installed = run(
      "pnpm",
      [
        "--dir",
        cache,
        "add",
        "--save-exact",
        "--ignore-scripts",
        `${name}@${version}`,
      ],
      { timeout: 600_000 },
    );
    if (!ready())
      throw new Error(
        `Pinned Quint could not be installed: ${installed.error?.message ?? installed.stderr?.slice(-4000)}`,
      );
  }
  const binary = ready();
  if (!binary) throw new Error("Pinned Quint has no JavaScript CLI entry");
  const probe = run("node", [binary, "--version"]);
  if (probe.error || probe.status !== 0 || probe.stdout?.trim() !== version)
    throw new Error(
      `Pinned Quint did not report ${version}: ${probe.error?.message ?? probe.stderr}`,
    );
  return { binary, binDirectory, version };
}
