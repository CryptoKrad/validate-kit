import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { PlanEnv, TaskSeed } from "../core/types.js";
import { toolAdopted, upTo } from "../detect/adoption.js";
import { isUnder, toPosix } from "../detect/languages.js";

/**
 * What the package tools (size-limit, publint, attw) share: one run per npm
 * package, from its folder, where the package chose the tool.
 */

/** A package.json in the scope: its folder (absolute, POSIX) and contents. */
export interface NpmPackage {
  dir: string;
  manifest: Record<string, unknown>;
}

/** A shell that runs nothing; none on Windows. */
const NO_SHELL = ["/usr/bin/true", "/bin/true"].find((path) =>
  existsSync(path),
);

/**
 * npm and pnpm packing with no network (packing needs none; the update
 * check is the only request) and no script of the package: npm 10.9.9 runs
 * `prepare` on `pack` even with scripts ignored, so its script shell is one
 * that does nothing; pnpm 11 reads only its own `pnpm_config_` variables.
 */
export const PACK_ENV: Record<string, string> = {
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "true",
  pnpm_config_ignore_scripts: "true",
  ...(NO_SHELL ? { npm_config_script_shell: NO_SHELL } : {}),
};

/**
 * A task per package.json in the scope that `chosen` picks, run from the
 * package's folder; in a changed-file run, only a package the change touched.
 */
export function packageTasks(
  seed: TaskSeed,
  env: PlanEnv,
  chosen: (pkg: NpmPackage) => boolean,
): TaskSeed[] {
  const top = toPosix(env.projectRoot);
  const changed = env.changedPaths?.map((path) =>
    posix.join(top, toPosix(path)),
  );
  return env.scopedFiles.flatMap((file) => {
    if (posix.basename(file) !== "package.json") return [];
    const dir = posix.dirname(toPosix(file));
    if (changed && !changed.some((path) => isUnder(path, dir))) return [];
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return []; // not a package npm could read either
    }
    if (typeof manifest !== "object" || manifest === null) return [];
    const pkg = { dir, manifest: manifest as Record<string, unknown> };
    return chosen(pkg) ? [{ ...seed, cwd: dir }] : [];
  });
}

/**
 * For a tool that packs the package (publint, attw): each package it could
 * publish (a name and a version, not private; a folder's `{"type": ...}`
 * marker is none) where the tool is a dependency of it or of a package
 * above it, has one of its `configs`, or `tools.<id>.enabled` is set.
 * Where no shell can stand in for the package's `prepare` script (Windows),
 * a package with one is not packed.
 */
export function packTasks(
  seed: TaskSeed,
  env: PlanEnv,
  dep: string,
  configs: readonly string[],
): TaskSeed[] {
  const prepares = new Set<string>();
  const tasks = packageTasks(seed, env, ({ dir, manifest }) => {
    const chosen =
      typeof manifest.name === "string" &&
      typeof manifest.version === "string" &&
      manifest.private !== true &&
      (env.toolConfig.enabled === true ||
        toolAdopted(dir, env.projectRoot, { configs, dep }));
    const scripts = manifest.scripts as Record<string, unknown> | undefined;
    if (chosen && scripts?.prepare !== undefined) prepares.add(dir);
    return chosen;
  });
  return tasks.map((task) =>
    NO_SHELL === undefined && prepares.has(task.cwd)
      ? { cwd: task.cwd, cannotRun: "its prepare script would run on npm pack" }
      : task,
  );
}

/**
 * The package manager that packs the package as its repository publishes
 * it: pnpm (which applies `publishConfig`) under a pnpm lockfile or
 * workspace at or above it, else npm.
 */
export function packerOf(dir: string, top: string): "pnpm" | "npm" {
  return upTo(dir, top).some(
    (folder) =>
      existsSync(join(folder, "pnpm-lock.yaml")) ||
      existsSync(join(folder, "pnpm-workspace.yaml")),
  )
    ? "pnpm"
    : "npm";
}
