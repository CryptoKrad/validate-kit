import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { ConfigError } from "../config/schema.js";
import type { PlanEnv, ToolContext } from "../core/types.js";
import { isUnder, languageForFile, toPosix } from "../detect/languages.js";
import { scratchOf } from "./base.js";

/**
 * Helpers the schema and infrastructure adapters share (buf, sqlc, tofu,
 * graphql-inspector, trivy, the Kubernetes linters): recorded in
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md.
 */

/** Why a check against the main branch did not run, when there is none. */
export const NO_BASE =
  "no main branch to compare with (no origin/HEAD, origin/main or origin/master, as in a shallow CI checkout), so nothing was compared: fetch origin's main branch, or pass --trusted-ref";

/**
 * The first changed line of each hunk of a unified diff, by the file its
 * `+++` header names less `prefix` (`b/`, `new/`), counted on the `-` side:
 * the file on disk, which the diff rewrites. Header-looking lines inside a
 * hunk (a removed `-- comment`) are content: the hunk's counts say where it
 * ends.
 */
export function hunkStarts(
  text: string,
  prefix: string,
): { file: string; line: number }[] {
  const starts: { file: string; line: number }[] = [];
  let file: string | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  let pending = false;
  for (const row of text.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = row[0];
      if (mark === "\\") continue; // "\ No newline at end of file"
      if ((mark === "-" || mark === "+") && pending && file !== undefined) {
        starts.push({ file, line: Math.max(1, line) });
        pending = false;
      }
      if (mark !== "+") {
        oldLeft--;
        line++;
      }
      if (mark !== "-") newLeft--;
      continue;
    }
    if (row.startsWith("+++ ")) {
      const path = row.slice(4).split("\t")[0] ?? "";
      file = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      continue;
    }
    const at = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(row);
    if (at) {
      line = Number(at[1]);
      oldLeft = at[2] === undefined ? 1 : Number(at[2]);
      newLeft = at[3] === undefined ? 1 : Number(at[3]);
      pending = true;
    }
  }
  return starts;
}

/** The task's files, relative to where the tool runs. */
export function relativeFiles(ctx: ToolContext): string[] {
  const cwd = toPosix(ctx.cwd);
  return (ctx.files ?? []).map((file) => posix.relative(cwd, toPosix(file)));
}

/** The scope's files `wanted` takes, relative to the project root. */
export function scopeOf(
  env: PlanEnv,
  wanted: (path: string) => boolean,
): string[] {
  const top = toPosix(env.projectRoot);
  return env.scopedFiles
    .map((file) => posix.relative(top, toPosix(file)))
    .filter(wanted);
}

/**
 * Paths an option names, each one that exists, normalised: a path the
 * project mistyped is a config error, never a check of nothing.
 */
export function existingPaths(
  env: PlanEnv,
  option: string,
  paths: readonly string[],
): string[] {
  return paths.map((path) => {
    if (!existsSync(join(env.projectRoot, path)))
      throw new ConfigError(
        `${option}: ${path} does not exist under the project root`,
      );
    return posix.normalize(toPosix(path));
  });
}

/** In a changed-file run, whether a changed path passes `test`. */
export function changedAny(
  env: PlanEnv,
  test: (path: string) => boolean,
): boolean {
  return !env.changedPaths || env.changedPaths.some((p) => test(toPosix(p)));
}

/** `path` is `dir`, or in it; "." is the whole project. */
export const within = (path: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => dir === "." || isUnder(path, dir));

/** A YAML file that holds a Kubernetes object: `apiVersion:` and `kind:` at the top level. */
function holdsKubernetes(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return /^apiVersion:\s*\S/m.test(text) && /^kind:\s*\S/m.test(text);
}

/** What the Kubernetes linters read under `paths`, all relative to the project root. */
export interface KubernetesInputs {
  /** Manifests: YAML holding a Kubernetes object, outside any Helm chart. */
  files: string[];
  /** Helm charts: the folders of each `Chart.yaml`. */
  charts: string[];
  /** Every YAML file of the scope under `paths`, the charts' too. */
  scope: string[];
}

/**
 * The scope's Kubernetes manifests and Helm charts under `paths`, never the
 * rest of the tree: a tool walking "." reads node_modules and other
 * checkouts (a 67 s pluto run on this repository) and every config YAML.
 * A chart's templates are not YAML until rendered, so a chart goes whole.
 */
export function kubernetesInputs(
  env: PlanEnv,
  paths: readonly string[],
): KubernetesInputs {
  const scope = scopeOf(
    env,
    (path) =>
      (languageForFile(path) === "yaml" || path.endsWith(".tpl")) &&
      within(path, paths),
  );
  const charts = scope
    .filter((path) => posix.basename(path) === "Chart.yaml")
    .map((path) => posix.dirname(path));
  const files = scope.filter(
    (path) =>
      !charts.some((chart) => chart === "." || isUnder(path, chart)) &&
      holdsKubernetes(join(env.projectRoot, path)),
  );
  return { files, charts, scope };
}

/** Where `stage` copies a task's files. */
export const stagedDir = (ctx: ToolContext): string =>
  toPosix(join(scratchOf(ctx), "staged"));

/**
 * The project's `files` (relative to `ctx.cwd`) copied into the task's
 * scratch folder at the same paths, for a tool that takes only a folder and
 * walks all of it (pluto, trivy): it reads exactly the kit's scope there.
 */
export function stage(ctx: ToolContext, files: readonly string[]): string {
  const dir = stagedDir(ctx);
  for (const file of files) {
    const to = join(dir, file);
    mkdirSync(posix.dirname(toPosix(to)), { recursive: true });
    copyFileSync(join(ctx.cwd, file), to);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
