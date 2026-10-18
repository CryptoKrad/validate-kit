import { existsSync } from "node:fs";
import { posix } from "node:path";
import picomatch from "picomatch";
import type { Finding } from "../core/types.js";
import { mainBase } from "../detect/git.js";
import { toPosix } from "../detect/languages.js";
import { fileFinding, gitSync, ignoredBy, nativeCheck } from "./native.js";

/**
 * A folder of migrations: Django, golang-migrate, sqlx, Knex, Flyway, Rails,
 * Prisma, Diesel, Alembic.
 */
const FOLDER = /(?:^|\/)(?:alembic\/versions|migrations?|db\/migrate)\//;

/** The same folders, as git pathspecs. */
const MIGRATION_PATHSPECS = [
  ":(glob)**/migrations/**",
  ":(glob)**/migration/**",
  ":(glob)**/db/migrate/**",
  ":(glob)**/alembic/versions/**",
];

interface Version {
  /** What orders it: the number, with Flyway's `V` or `U` in front. */
  key: string;
  /** Its name, to the first dot: one migration's .up/.down or .conf share it. */
  name: string;
}

/**
 * An entry's version: `0002_add_field.py`, `000001_init.up.sql`,
 * `V3__orders.sql` and `U3__orders.sql` (Flyway undoes V3 with U3),
 * `20240101000000_users.rb`, `2024-01-01-000000_create/` (Diesel), Alembic's
 * `1975ea83b712_add.py`. `__init__.py`, Flyway's repeatable `R__` and a
 * README have none.
 */
function versioned(entry: string): Version | undefined {
  const match = /^([VU]?)(\d+(?:[._-]\d+)*)(?:__|[_-]|\.|$)(.*)$/.exec(entry);
  if (match?.[2])
    return {
      key: `${match[1] ?? ""}${match[2]}`,
      name: (match[3] ?? "").split(".")[0] ?? "",
    };
  const alembic = /^([0-9a-f]{12})_(.*)$/.exec(entry);
  if (alembic?.[1])
    return { key: alembic[1], name: (alembic[2] ?? "").split(".")[0] ?? "" };
  return undefined;
}

/**
 * Where a path sits as a migration: the folder that orders it, the entry in
 * that folder (a file, or Prisma's and Diesel's folder per migration), and
 * its version. A file under a subfolder of no version (`migrations/postgres/`)
 * belongs to that subfolder's own set.
 */
function placed(
  path: string,
): { folder: string; entry: string; version: Version } | undefined {
  const match = FOLDER.exec(path);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const parts = path.slice(start).split("/");
  for (let i = 0; i < parts.length; i++) {
    const version = versioned(parts[i] ?? "");
    if (version)
      return {
        folder:
          path.slice(0, start) +
          parts
            .slice(0, i)
            .map((p) => `${p}/`)
            .join(""),
        entry: parts[i] ?? "",
        version,
      };
  }
  return undefined;
}

interface MigrationsPlan {
  /** Every migration path in scope, project-relative. */
  all: string[];
  /** The config's `ignore`, for deleted migrations, which no scope lists. */
  ignore: string[];
  /** The main branch's commit, to compare committed migrations with. */
  base?: string;
}

/**
 * migrations — two migrations that take one version (two branches each added
 * `002_...`), and a migration already on the main branch that was edited or
 * deleted since: a database that ran it does not run it again. The main
 * branch is origin's default branch (`origin/HEAD`, else `origin/main` or
 * `origin/master`), or the trusted ref under --trusted-ref, at its merge base
 * with HEAD. Python migrations (Django, Alembic) are left out of the version
 * check: Django orders them by dependency and keeps merged pairs on purpose.
 * A full run reports a clash only when one side is new since the main branch;
 * a changed-file run, only what involves a changed migration.
 */
export const migrations = nativeCheck({
  id: "migrations",
  layer: "lint",
  // A deleted migration is no file in scope; the change still names it.
  select: (files, env) => {
    const ignored = ignoredBy(env);
    return [
      ...files.filter((path) => FOLDER.test(path)),
      ...(env.changedPaths ?? [])
        .map(toPosix)
        .filter(
          (path) =>
            FOLDER.test(path) &&
            !ignored(path) &&
            !existsSync(posix.join(toPosix(env.projectRoot), path)),
        ),
    ];
  },
  plan(_files, env): MigrationsPlan {
    const top = toPosix(env.projectRoot);
    const all = env.scopedFiles
      .map((file) => posix.relative(top, file))
      .filter((path) => placed(path) !== undefined);
    const base = mainBase(env.projectRoot, env.trusted?.commit);
    return { all, ignore: env.config.ignore, ...(base ? { base } : {}) };
  },
  check(root, task) {
    const { all, base, ignore } = task.extra as MigrationsPlan;
    const ignored =
      ignore.length > 0 ? picomatch(ignore, { dot: true }) : () => false;
    const changed = new Set(task.files);
    const findings: Finding[] = [];
    const at = (
      path: string,
      ruleId: string,
      severity: "error" | "warning" | "info",
      message: string,
    ) =>
      findings.push(
        fileFinding("migrations", "lint", root, path, {
          ruleId,
          severity,
          message,
        }),
      );
    if (all.length === 0 && task.files.every((path) => !placed(path)))
      return findings;
    // What the main branch already has, under the project root.
    const prefix = (gitSync(root, ["rev-parse", "--show-prefix"]) ?? "").trim();
    const onBase = base
      ? new Set(
          (
            gitSync(root, [
              "ls-tree",
              "-r",
              "-z",
              "--name-only",
              "--full-tree",
              base,
            ]) ?? ""
          )
            .split("\0")
            .filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length)),
        )
      : undefined;
    // Each folder's entries by version key, then by name.
    const sets = new Map<string, Map<string, Map<string, string[]>>>();
    for (const path of all) {
      const where = placed(path);
      if (!where || where.entry.endsWith(".py")) continue;
      const byKey =
        sets.get(where.folder) ?? new Map<string, Map<string, string[]>>();
      sets.set(where.folder, byKey);
      const byName =
        byKey.get(where.version.key) ?? new Map<string, string[]>();
      byKey.set(where.version.key, byName);
      byName.set(where.version.name, [
        ...(byName.get(where.version.name) ?? []),
        path,
      ]);
    }
    for (const [folder, byKey] of sets)
      for (const [key, byName] of byKey) {
        if (byName.size < 2) continue;
        const files = [...byName.values()].flat();
        if (task.changed && !files.some((file) => changed.has(file))) continue;
        // On the main branch already: it ran, and renumbering would run it again.
        if (!task.changed && onBase && files.every((file) => onBase.has(file)))
          continue;
        const target =
          files.find((file) => changed.has(file)) ??
          files.find((file) => onBase && !onBase.has(file)) ??
          files.at(-1) ??
          folder;
        const entries = [...new Set(files.map((file) => placed(file)?.entry))];
        at(
          target,
          "duplicate-version",
          "error",
          `${entries.map((entry) => `\`${entry}\``).join(" and ")} in ${folder} share version ${key}: two branches each added a migration, and the order they run in is not defined. Renumber the one that has not run anywhere yet`,
        );
      }
    if (!base) {
      at(
        all[0] ?? task.files[0] ?? ".",
        "no-base",
        "info",
        "no main branch to compare migrations with (no origin/HEAD, origin/main or origin/master, as in a shallow CI checkout), so an edited migration is not checked: fetch origin's main branch, or pass --trusted-ref",
      );
      return findings;
    }
    // Committed on the main branch, and different now or deleted: one diff
    // of every migrations folder against it.
    const tokens = (
      gitSync(root, [
        "diff",
        "-z",
        "--name-status",
        "--no-renames",
        "--relative",
        ...(task.staged ? ["--cached"] : []),
        base,
        "--",
        ...MIGRATION_PATHSPECS,
      ]) ?? ""
    ).split("\0");
    const inScope = new Set(all);
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const path = tokens[i + 1] ?? "";
      if (status !== "M" && status !== "D") continue;
      if (!placed(path)) continue;
      // An edited file must be in scope; a deleted one, out of the ignore.
      if (status === "M" && !inScope.has(path)) continue;
      if (status === "D" && ignored(path)) continue;
      if (task.changed && !changed.has(path)) continue;
      at(
        path,
        "edited",
        "warning",
        `this migration is already on the main branch (${base.slice(0, 12)}) and was ${status === "D" ? "deleted" : "edited"}: a database that ran it will not run it again. Add a new migration instead`,
      );
    }
    return findings;
  },
});
