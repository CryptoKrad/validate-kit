import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PlanEnv } from "../core/types.js";
import { upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, toolOptions } from "./base.js";

/** `tools.clang-tidy.options` and `tools.cppcheck.options`. */
const DbOptions = z
  .object({
    /**
     * The folder holding compile_commands.json, relative to the project
     * root (`cmake-build-debug`, `out/build/<preset>`, a meson builddir).
     */
    compileCommands: z.string().min(1).optional(),
  })
  .strict();

/**
 * The folder of the compilation database for a C/C++ root: the one
 * `tools.<id>.options.compileCommands` names, else the first folder from the
 * root up to the project root, or its `build/` (where CMake writes it), that
 * holds a compile_commands.json.
 */
export function compileDb(
  root: string,
  env: PlanEnv,
  id: string,
): string | undefined {
  const named = toolOptions(env, id, DbOptions).compileCommands;
  const dirs =
    named === undefined
      ? upTo(root, env.projectRoot).flatMap((dir) => [dir, join(dir, "build")])
      : [absPosix(env.projectRoot, named)];
  const found = dirs.find((dir) =>
    existsSync(join(dir, "compile_commands.json")),
  );
  return found === undefined ? undefined : toPosix(found);
}

/** One database entry: its source and the folder it compiles from. */
export interface DbEntry {
  /** Absolute. */
  file: string;
  directory: string;
}

/** The database's entries; an unreadable database has none. */
export function dbEntries(db: string): DbEntry[] {
  let entries: unknown;
  try {
    entries = JSON.parse(
      readFileSync(join(db, "compile_commands.json"), "utf8"),
    );
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return (entries as { directory?: unknown; file?: unknown }[]).flatMap(
    (entry) =>
      typeof entry.directory === "string" && typeof entry.file === "string"
        ? [
            {
              file: absPosix(entry.directory, entry.file),
              directory: toPosix(entry.directory),
            },
          ]
        : [],
  );
}
