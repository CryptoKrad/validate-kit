import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The directories an ast-grep `sgconfig.yml` lists under `key` (`ruleDirs`,
 * `utilDirs`), absolute, resolved from the file's own directory.
 */
export function sgconfigDirs(
  abs: string,
  key: "ruleDirs" | "utilDirs",
): string[] {
  const parsed: unknown = parseYaml(readFileSync(abs, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const dirs = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(dirs)) return [];
  return dirs
    .filter(
      (dir): dir is string => typeof dir === "string" && dir.trim() !== "",
    )
    .map((dir) => resolve(dirname(abs), dir));
}
