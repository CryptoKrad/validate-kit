import { relative } from "node:path";
import pc from "picocolors";
import { planCheck } from "../api.js";
import { EXIT } from "../core/exit-codes.js";
import { LANGUAGES } from "../core/types.js";
import {
  changedMode,
  parseCheckFilters,
  parseProfile,
  resolveCwd,
  type CheckFlags,
} from "./check.js";

/**
 * Dry-run plan: detected languages + the tasks that would run. It runs no
 * check, but asks the project's tsc which files each project covers.
 */
export async function listCommand(
  paths: string[],
  flags: CheckFlags,
): Promise<number> {
  const cwd = resolveCwd(paths);
  const mode = changedMode(flags);
  const profile = parseProfile(flags.profile);
  const filters = parseCheckFilters(flags);
  const planned = await planCheck({
    cwd,
    ...(mode ? { changedMode: mode } : {}),
    ...(flags.since ? { since: flags.since } : {}),
    ...filters,
    ...(flags.config ? { configPath: flags.config } : {}),
    ...(flags.trustedRef !== undefined ? { trustedRef: flags.trustedRef } : {}),
    ...(profile ? { profile } : {}),
  });

  if (flags.json) {
    const detected = LANGUAGES.filter((l) => planned.detection.has(l));
    process.stdout.write(
      `${JSON.stringify(
        {
          projectRoot: planned.projectRoot,
          configSource: planned.configSource ?? null,
          scope: planned.scope,
          languages: detected,
          // What the run will not check, and why (archive folders, files
          // outside every crate or module).
          notes: planned.notes.map((note) => ({
            ...note,
            files: note.files.map(
              (file) => relative(planned.projectRoot, file) || ".",
            ),
          })),
          tasks: planned.tasks.map((t) => ({
            tool: t.adapter.id,
            layer: t.adapter.layer,
            cwd: relative(planned.projectRoot, t.cwd) || ".",
            files: t.files?.length ?? null,
            ...(t.toolConfig.configPath
              ? { configPath: t.toolConfig.configPath }
              : {}),
            ...(t.options !== undefined ? { options: t.options } : {}),
            ...(t.cannotRun !== undefined ? { cannotRun: t.cannotRun } : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.CLEAN;
  }

  const detected = LANGUAGES.filter((l) => planned.detection.has(l));
  process.stdout.write(`\nProject: ${planned.projectRoot}\n`);
  process.stdout.write(
    `Config:  ${planned.configSource ?? pc.dim("(defaults — recommended preset)")}\n`,
  );
  process.stdout.write(
    `Scope:   ${planned.scope.profile}/${planned.scope.mode} (${planned.scope.files ?? "all"} files)\n`,
  );
  process.stdout.write(
    `Languages: ${detected.length ? pc.cyan(detected.join(", ")) : pc.dim("none")}\n\n`,
  );
  if (planned.tasks.length === 0) {
    process.stdout.write(pc.dim("No tasks would run.\n"));
    return EXIT.CLEAN;
  }
  let lastLayer = "";
  for (const t of planned.tasks) {
    if (t.adapter.layer !== lastLayer) {
      process.stdout.write(`${pc.bold(t.adapter.layer)}\n`);
      lastLayer = t.adapter.layer;
    }
    const where = relative(planned.projectRoot, t.cwd) || ".";
    const opt = t.adapter.optional ? pc.dim(" (optional)") : "";
    process.stdout.write(`  ${t.adapter.id}${opt}  ${pc.dim(where)}\n`);
    if (t.cannotRun !== undefined)
      process.stdout.write(pc.yellow(`    cannot run: ${t.cannotRun}\n`));
  }
  process.stdout.write("\n");
  return EXIT.CLEAN;
}
