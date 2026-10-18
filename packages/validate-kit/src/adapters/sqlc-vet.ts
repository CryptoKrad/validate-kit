import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { changedAny } from "./schemas-iac.js";

/** sqlc's config names, in the folder it runs in (schemas-iac.md, 3). */
const CONFIGS = new Set(["sqlc.yaml", "sqlc.yml", "sqlc.json"]);

/** What the kit reads of an sqlc config: its inputs and output folders. */
export interface SqlcProject {
  /** The config's name in its folder. */
  config: string;
  /** Query files and folders, relative to the config's folder. */
  queries: string[];
  /** Schema files and folders, relative to the config's folder (`../` too). */
  schema: string[];
  /** Folders generated code is written to, relative to the config's folder. */
  outs: string[];
  /** The config names a database (`database:`, its analyzer not off). */
  database: boolean;
  /** sqlc-vet runs too, and reports the compile errors both would. */
  vetRuns: boolean;
}

/**
 * Why sqlc cannot run offline on a config that names a database
 * (`database:`, its analyzer not turned off): it connects to it, with
 * `--no-remote` too, and an unreachable one read as a compile error.
 */
const NEEDS_DATABASE =
  "the config names a database, which sqlc connects to even with --no-remote: run sqlc where the database is, or set `analyzer: {database: false}`";

const paths = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === "string")
    .map((path) => posix.normalize(toPosix(path)));

interface SqlEntry {
  queries?: unknown;
  schema?: unknown;
  gen?: unknown;
  codegen?: unknown;
  database?: unknown;
  analyzer?: { database?: unknown };
}

/**
 * The sqlc config in `dir`: v2's `sql[].queries`, `schema`, `database` and
 * `gen.<lang>.out` / `codegen[].out`, or v1's `packages[].queries`,
 * `schema` and `path`. A config that does not parse names none of them;
 * sqlc itself reports why.
 */
export function sqlcProject(
  dir: string,
  config: string,
  vetRuns = true,
): SqlcProject {
  let parsed: unknown;
  try {
    // JSON is YAML.
    parsed = parseYaml(readFileSync(join(dir, config), "utf8"));
  } catch {
    parsed = undefined;
  }
  const c = parsed as {
    sql?: SqlEntry[];
    packages?: { queries?: unknown; schema?: unknown; path?: unknown }[];
  } | null;
  const sql = Array.isArray(c?.sql) ? c.sql : [];
  const packages = Array.isArray(c?.packages) ? c.packages : [];
  return {
    config,
    queries: [...sql, ...packages].flatMap((entry) => paths(entry.queries)),
    schema: [...sql, ...packages].flatMap((entry) => paths(entry.schema)),
    outs: [
      ...sql.flatMap((entry) =>
        Object.values(
          (entry.gen ?? {}) as Record<string, { out?: unknown }>,
        ).flatMap((gen) => paths(gen.out)),
      ),
      ...sql.flatMap((entry) =>
        Array.isArray(entry.codegen)
          ? (entry.codegen as { out?: unknown }[]).flatMap((gen) =>
              paths(gen.out),
            )
          : [],
      ),
      ...packages.flatMap((entry) => paths(entry.path)),
    ],
    database: sql.some(
      (entry) =>
        entry.database !== undefined &&
        entry.database !== null &&
        entry.analyzer?.database !== false,
    ),
    vetRuns,
  };
}

/**
 * One task per sqlc config in scope, run in its folder. In a changed-file
 * run, only a config whose project changed: the config, a `.sql` file in
 * its folder, a schema or query file wherever the config names it (`../`
 * too), or a file in an output folder.
 */
export function sqlcTasks(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
  const top = toPosix(env.projectRoot);
  const vetRuns = env.config.tools["sqlc-vet"]?.enabled !== false;
  return env.scopedFiles.flatMap((file) => {
    const name = basename(file);
    if (!CONFIGS.has(name)) return [];
    const dir = posix.dirname(toPosix(file));
    const project = sqlcProject(dir, name, vetRuns);
    const read = [...project.schema, ...project.queries, ...project.outs].map(
      (path) => posix.join(dir, path),
    );
    const changed = changedAny(env, (path) => {
      const abs = posix.join(top, path);
      return (
        abs === posix.join(dir, name) ||
        (isUnder(abs, dir) && abs.endsWith(".sql")) ||
        read.some((input) => isUnder(abs, input))
      );
    });
    if (!changed) return [];
    return [
      {
        ...seed,
        cwd: dir,
        options: project,
        ...(project.database ? { cannotRun: NEEDS_DATABASE } : {}),
      },
    ];
  });
}

/** sqlc's command for a task. */
export function sqlcCommand(
  bin: string,
  command: "vet" | "diff",
  ctx: ToolContext,
): BuiltCommand {
  return {
    bin,
    args: [
      command,
      "--no-remote",
      "-f",
      (ctx.options as SqlcProject).config,
      ...ctx.extraArgs,
    ],
    okExitCodes: [0, 1],
  };
}

/** `db/query.sql:2:12: column "nope" does not exist`: a query that does not compile. */
const COMPILE = /^(.+?):(\d+):(\d+): (.+)$/;

/** `query.sql: DeleteAll: no-delete-without-where: DELETE needs a WHERE` */
const VET = /^([^:\s]+): (\w+): ([\w/.-]+): (.+)$/;

/**
 * sqlc's compile errors in `text` (vet and diff print the same lines). A
 * database it could not reach is no compile error: it throws.
 */
export function compileErrors(
  tool: string,
  text: string,
  ctx: ToolContext,
): Finding[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = COMPILE.exec(line.trim());
    if (!m?.[1] || !m[4]) return [];
    if (m[4].startsWith("failed to connect to"))
      throw new Error(
        `sqlc could not reach the database its config names: ${m[4]}`,
      );
    return [
      finding({
        tool,
        layer: "behavior",
        language: "sql",
        file: absPosix(ctx.cwd, m[1]),
        line: Number(m[2]),
        col: Number(m[3]),
        ruleId: "compile",
        severity: "error",
        message: `${m[4]} (sqlc cannot compile the queries)`,
        fixable: false,
      }),
    ];
  });
}

/** The query files a config names: each file, and the `.sql` files of each folder. */
function queryFiles(ctx: ToolContext, project: SqlcProject): string[] {
  return project.queries.flatMap((query) => {
    const path = join(ctx.cwd, query);
    try {
      return statSync(path).isDirectory()
        ? readdirSync(path)
            .filter((name) => name.endsWith(".sql"))
            .map((name) => join(path, name))
        : [path];
    } catch {
      return [];
    }
  });
}

/** Where `-- name: <query>` is, in the query file named `file`. */
function queryAt(
  files: readonly string[],
  file: string,
  query: string,
): { file: string; line: number } | undefined {
  const named = new RegExp(`^\\s*--\\s*name:\\s*${query}\\b`);
  for (const path of files) {
    if (basename(path) !== file) continue;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch {
      continue;
    }
    const index = lines.findIndex((line) => named.test(line));
    if (index >= 0) return { file: path, line: index + 1 };
  }
  return undefined;
}

/**
 * sqlc vet — the query rules the project's sqlc config declares (CEL rules
 * such as a DELETE without WHERE), each hit at its query's `-- name:` line,
 * and queries that do not compile against the schema. Rules that need a
 * live database (`sqlc/db-prepare`, the `*-query-explain` rules) are left
 * to the project's own run with one: the kit reports once, as info, that
 * they did not run; a config that names a database (`database:`) is not
 * run at all (skipped, incomplete under `--profile ci`), since sqlc
 * connects to it.
 * `--no-remote`, never sqlc's cloud. One task per
 * `sqlc.yaml`/`sqlc.yml`/`sqlc.json`, in its folder. Recorded on 1.31.1:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 3.
 */
export const sqlcVet: ToolAdapter = {
  id: "sqlc-vet",
  layer: "behavior",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "sqlc",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "1.31.1",
  installHint: "brew install sqlc",
  versionArgs: ["version"],
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "compile",
  expand: sqlcTasks,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return sqlcCommand(this.bin, "vet", ctx);
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const project = ctx.options as SqlcProject;
    const text = `${raw.stdout}\n${raw.stderr}`;
    const files = queryFiles(ctx, project);
    const offline = new Set<string>();
    const findings = compileErrors("sqlc-vet", text, ctx);
    for (const line of text.split(/\r?\n/)) {
      const m = VET.exec(line.trim());
      if (!m?.[1] || !m[2] || !m[3] || !m[4]) continue;
      // A rule that prepares or explains the query on a database.
      if (/database connection required/.test(m[4])) {
        offline.add(m[3]);
        continue;
      }
      const at = queryAt(files, m[1], m[2]);
      findings.push(
        finding({
          tool: "sqlc-vet",
          layer: "behavior",
          language: "sql",
          file: at?.file ?? absPosix(ctx.cwd, project.config),
          line: at?.line ?? 1,
          col: 1,
          ruleId: m[3],
          severity: "error",
          message: `${m[2]}: ${m[4]}${at ? "" : ` (in ${m[1]})`}`,
          fixable: false,
        }),
      );
    }
    for (const rule of offline)
      findings.push(
        finding({
          tool: "sqlc-vet",
          layer: "behavior",
          file: absPosix(ctx.cwd, project.config),
          line: 1,
          col: 1,
          ruleId: rule,
          severity: "info",
          message: `${rule} needs a database, which the kit's offline run has none of: it was not checked here; run sqlc vet with the database the config names`,
          fixable: false,
        }),
      );
    if (raw.exitCode !== 0 && findings.length === 0)
      throw new Error(
        `sqlc vet exited ${raw.exitCode}: ${text.trim().split("\n")[0] ?? "no message"}`,
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
