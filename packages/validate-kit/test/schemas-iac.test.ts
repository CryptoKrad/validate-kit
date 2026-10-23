import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buf } from "../src/adapters/buf.js";
import { bufBreaking } from "../src/adapters/buf-breaking.js";
import { bufFormat } from "../src/adapters/buf-format.js";
import { graphqlInspector } from "../src/adapters/graphql-inspector.js";
import { kubeLinter } from "../src/adapters/kube-linter.js";
import { kubeconform } from "../src/adapters/kubeconform.js";
import { oasdiff } from "../src/adapters/oasdiff.js";
import { pluto } from "../src/adapters/pluto.js";
import { hunkStarts } from "../src/adapters/schemas-iac.js";
import { sqlcDiff } from "../src/adapters/sqlc-diff.js";
import { sqlcVet } from "../src/adapters/sqlc-vet.js";
import { sqruff } from "../src/adapters/sqruff.js";
import { tofu } from "../src/adapters/tofu.js";
import { trivy } from "../src/adapters/trivy.js";
import { resolveConfig } from "../src/config/resolve.js";
import { inTree } from "../src/detect/git.js";
import { toPosix } from "../src/detect/languages.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolContext,
} from "../src/core/types.js";

// Every output below was captured from a real run on 2026-10-18 (buf
// 1.73.0, sqruff 0.41.0, sqlc 1.31.1, graphql-inspector 7.0.1, OpenTofu
// 1.13.1, trivy 0.69.3, kubeconform 0.8.0, kube-linter 0.8.3, pluto 5.24.4)
// on the fixtures in docs/research/lint-toolchain/assets/sota-2026-10-18/,
// then trimmed (docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function put(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-iac-scratch-");
  return { cwd, fix: false, extraArgs: [], tempDir: () => scratch, ...extra };
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

function env(root: string, more: Partial<PlanEnv> = {}): PlanEnv {
  return {
    projectRoot: root,
    scopedFiles: [],
    toolConfig: {},
    config: { ignore: [], tools: {} },
    ...more,
  } as unknown as PlanEnv;
}

const withOptions = (tool: string, options: unknown): Partial<PlanEnv> =>
  ({
    config: { ignore: [], tools: { [tool]: { options } } },
  }) as unknown as Partial<PlanEnv>;

/** A repository with one commit, and `origin/main` at it when `origin`. */
function repo(files: Record<string, string>, origin: boolean): string {
  const root = tmp("vk-iac-repo-");
  put(root, files);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  if (origin) git("update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

const expand = (
  adapter: { expand?: (s: TaskSeed, e: PlanEnv) => unknown },
  seed: TaskSeed,
  e: PlanEnv,
) => adapter.expand?.(seed, e) as TaskSeed[];

describe("buf", () => {
  const LINT =
    '{"path":"proto/acme/v1/user.proto","start_line":5,"start_column":9,"end_line":5,"end_column":13,"type":"MESSAGE_PASCAL_CASE","message":"Message name \\"user\\" should be PascalCase, such as \\"User\\"."}\n';

  it("lint: one error per JSON line, 1-based, at the path from where it ran", () => {
    const root = tmp("vk-buf-");
    const { findings } = buf.parseOutput(ran(100, LINT), ctx(root));
    expect(findings).toEqual([
      expect.objectContaining({
        file: `${root}/proto/acme/v1/user.proto`,
        line: 5,
        col: 9,
        endLine: 5,
        endCol: 13,
        ruleId: "MESSAGE_PASCAL_CASE",
        severity: "error",
        language: "proto",
      }),
    ]);
    expect(() =>
      buf.parseOutput(ran(100, '{"path":"a.proto"}\n'), ctx(root)),
    ).toThrow(/output format may have changed/);
  });

  it("lint: exit 1 is a failure, unless every file given is outside buf's modules", () => {
    const root = tmp("vk-buf-");
    expect(() =>
      buf.parseOutput(ran(1, "", "unknown flag: --bogus\n"), ctx(root)),
    ).toThrow("buf lint failed: unknown flag: --bogus");
    const none = buf.parseOutput(
      ran(
        1,
        "",
        "Failure: no .proto files were targeted. This can occur if no .proto files are found in your input, --path points to files that do not exist, or --exclude-path excludes all files.\n",
      ),
      ctx(root),
    );
    expect(none.findings).toEqual([]);
    expect(
      buf.buildArgs(ctx(root, { files: [`${root}/proto/a.proto`] })).args,
    ).toEqual(["lint", "--error-format=json", "--path", "proto/a.proto"]);
  });

  it("runs where a buf.yaml or buf.work.yaml is, at or above the root", () => {
    const root = tmp("vk-buf-");
    expect(buf.adoptedAt?.(`${root}/proto`, root)).toBe(false);
    put(root, { "buf.work.yaml": "version: v1\ndirectories: [proto]\n" });
    expect(buf.adoptedAt?.(`${root}/proto`, root)).toBe(true);
  });

  it("format: one finding per hunk, at the first line it changes", () => {
    const root = tmp("vk-buf-");
    const diff = [
      "diff -u proto/acme/v1/user.proto.orig proto/acme/v1/user.proto",
      "--- proto/acme/v1/user.proto.orig\t2026-10-18 03:05:14",
      "+++ proto/acme/v1/user.proto\t2026-10-18 03:05:14",
      "@@ -3,6 +3,6 @@",
      " package acme.v1;",
      " ",
      " message user {",
      "-  string id=1;",
      "+  string id = 1;",
      "   string name = 2;",
      " }",
      "",
    ].join("\n");
    const { findings } = bufFormat.parseOutput(ran(100, diff), ctx(root));
    expect(findings.map((f) => [f.file, f.line, f.fixable])).toEqual([
      [`${root}/proto/acme/v1/user.proto`, 6, true],
    ]);
    expect(bufFormat.buildArgs(ctx(root, { fix: true })).args).toEqual([
      "format",
      "-w",
    ]);
  });

  it("breaking: against the main branch's merge base, from the module's folder", () => {
    const root = repo({ "sub/buf.yaml": "version: v2\n" }, true);
    const [task] = expand(bufBreaking, { cwd: `${root}/sub` }, env(root));
    const against =
      (task?.options as { against?: string } | undefined)?.against ?? "";
    expect(against).toMatch(/\/\.git#ref=[0-9a-f]{40},subdir=sub$/);
    const built = bufBreaking.buildArgs(
      ctx(`${root}/sub`, { options: task?.options }),
    );
    expect(built.args.slice(0, 4)).toEqual([
      "breaking",
      "--against",
      against,
      "--error-format=json",
    ]);
    const { findings } = bufBreaking.parseOutput(
      ran(
        100,
        '{"path":"user.proto","start_line":5,"start_column":1,"end_line":7,"end_column":2,"type":"FIELD_NO_DELETE","message":"Previously present field \\"2\\" with name \\"name\\" on message \\"User\\" was deleted."}\n',
      ),
      ctx(`${root}/sub`, { options: task?.options }),
    );
    expect(findings.map((f) => [f.file, f.line, f.ruleId, f.severity])).toEqual(
      [[`${root}/sub/user.proto`, 5, "FIELD_NO_DELETE", "error"]],
    );
  });

  it("breaking: with no main branch it cannot run (incomplete under ci), never an info pass", () => {
    const root = repo({ "buf.yaml": "version: v2\n" }, false);
    const tasks = expand(bufBreaking, { cwd: root }, env(root));
    expect(tasks.map((t) => t.cannotRun)).toEqual([
      expect.stringMatching(/no merge base of HEAD/),
    ]);
  });

  it("breaking: a deleted file, which buf reports with no path, is at the buf config", () => {
    const root = tmp("vk-buf-");
    put(root, { "buf.yaml": "version: v2\n" });
    // buf 1.73.0, a.proto deleted since the base (review-iac/buf7).
    const deleted =
      '{"start_line":1,"start_column":1,"end_line":1,"end_column":1,"type":"FILE_NO_DELETE","message":"Previously present file \\"acme/a/v1/a.proto\\" was deleted."}\n';
    const { findings } = bufBreaking.parseOutput(
      ran(100, deleted),
      ctx(root, { options: { module: "." } }),
    );
    expect(findings.map((f) => [f.file, f.line, f.ruleId])).toEqual([
      [`${root}/buf.yaml`, 1, "FILE_NO_DELETE"],
    ]);
  });

  it("breaking: each module of a workspace on its own; one new since the base is not compared", () => {
    const yaml = "version: v2\nmodules:\n  - path: a\n";
    const root = repo({ "buf.yaml": yaml, "a/x.proto": "" }, true);
    put(root, {
      "buf.yaml": `${yaml}  - path: b\n`,
      "b/y.proto": "",
    });
    const tasks = expand(bufBreaking, { cwd: root }, env(root));
    const [a, b] = tasks.map((t) => t.options as Record<string, string>);
    expect(a?.["against"]).toMatch(/#ref=[0-9a-f]{40},subdir=a$/);
    expect(
      bufBreaking.buildArgs(ctx(root, { options: a })).args.slice(0, 2),
    ).toEqual(["breaking", "a"]);
    expect(b).toMatchObject({ module: "b" });
    expect(b?.["skip"]).toMatch(/module b is not on the main branch/);
  });

  it("does not let buf fetch a module's deps: not run until they are in buf's cache", () => {
    const root = tmp("vk-buf-");
    const cache = tmp("vk-buf-cache-");
    put(root, {
      "buf.yaml": "version: v2\ndeps:\n  - buf.build/googleapis/googleapis\n",
    });
    const before = process.env["BUF_CACHE_DIR"];
    process.env["BUF_CACHE_DIR"] = cache;
    try {
      expect(expand(buf, { cwd: root }, env(root))[0]?.cannotRun).toMatch(
        /no buf\.lock/,
      );
      put(root, {
        "buf.lock":
          "version: v2\ndeps:\n  - name: buf.build/googleapis/googleapis\n    commit: 8ac61b9e502343289c8c42b17aa5b245\n",
      });
      expect(expand(buf, { cwd: root }, env(root))[0]?.cannotRun).toMatch(
        /not in buf's cache/,
      );
      mkdirSync(
        join(
          cache,
          "v3/modules/b5/buf.build/googleapis/googleapis/8ac61b9e502343289c8c42b17aa5b245/files",
        ),
        { recursive: true },
      );
      expect(expand(buf, { cwd: root }, env(root))[0]?.cannotRun).toBe(
        undefined,
      );
    } finally {
      if (before === undefined) delete process.env["BUF_CACHE_DIR"];
      else process.env["BUF_CACHE_DIR"] = before;
    }
  });
});

describe("sqruff", () => {
  it("reports each diagnostic at its 1-based position; a parse error is an error", () => {
    const root = tmp("vk-sqruff-");
    const stdout =
      '{"q.sql":[{"range":{"start":{"line":1,"character":10},"end":{"line":1,"character":10}},"message":"Expected single whitespace between \\",\\" and \\"b\\".","severity":"Warning","source":"sqruff","code":"LT01"}],"bad.sql":[{"range":{"start":{"line":1,"character":8},"end":{"line":1,"character":8}},"message":"Couldn\'t find closing bracket for opening bracket.","severity":"Warning","source":"sqruff","code":null}]}';
    const { findings } = sqruff.parseOutput(ran(1, stdout), ctx(root));
    expect(
      findings.map((f) => [f.file, f.line, f.col, f.ruleId, f.severity]),
    ).toEqual([
      [`${root}/q.sql`, 1, 10, "LT01", "warning"],
      [`${root}/bad.sql`, 1, 8, "parse", "error"],
    ]);
    expect(
      sqruff.parseOutput(ran(0, '{"q.sql":[]}'), ctx(root)).findings,
    ).toEqual([]);
    // An unknown dialect: exit 1 with text, not JSON.
    expect(() =>
      sqruff.parseOutput(ran(1, "Matching variant not found\n"), ctx(root)),
    ).toThrow(/invalid JSON/);
  });

  it("runs from the folder of each file's nearest .sqruff, the only place it reads one", () => {
    const root = tmp("vk-sqruff-");
    put(root, {
      "db/.sqruff": "[sqruff]\ndialect = ansi\n",
      "db/q/a.sql": "select 1\n",
      "c.sql": "select 1\n",
    });
    const seed = { cwd: root, files: [`${root}/db/q/a.sql`, `${root}/c.sql`] };
    expect(expand(sqruff, seed, env(root))).toEqual([
      { cwd: `${root}/db`, files: [`${root}/db/q/a.sql`] },
    ]);
    expect(
      sqruff.buildArgs(ctx(`${root}/db`, { files: [`${root}/db/q/a.sql`] }))
        .args,
    ).toEqual(["lint", "-f", "json", "--", "q/a.sql"]);
  });
});

describe("sqlc", () => {
  const CONFIG = `version: "2"
sql:
  - engine: sqlite
    schema: db/schema.sql
    queries: db/query.sql
    gen:
      go:
        package: db
        out: gen
`;
  const QUERIES =
    "-- name: GetUser :one\nSELECT id, name FROM users WHERE id = ?;\n\n-- name: DeleteAll :exec\nDELETE FROM users;\n";

  function project(changedPaths?: string[]) {
    const root = tmp("vk-sqlc-");
    put(root, {
      "api/sqlc.yaml": CONFIG,
      "api/db/query.sql": QUERIES,
      "README.md": "",
    });
    const e = env(root, {
      scopedFiles: [`${root}/README.md`, `${root}/api/sqlc.yaml`],
      ...(changedPaths ? { changedPaths } : {}),
    });
    return { root, tasks: expand(sqlcVet, { cwd: root }, e) };
  }

  it("plans one task per config, in its folder; a changed-file run only when its project changed", () => {
    const { root, tasks } = project();
    expect(tasks.map((t) => [t.cwd, t.options])).toEqual([
      [
        `${root}/api`,
        {
          config: "sqlc.yaml",
          queries: ["db/query.sql"],
          schema: ["db/schema.sql"],
          outs: ["gen"],
          database: false,
          vetRuns: true,
        },
      ],
    ]);
    expect(project(["README.md"]).tasks).toEqual([]);
    expect(project(["api/gen/db.go"]).tasks).toHaveLength(1);
    expect(project(["api/db/query.sql"]).tasks).toHaveLength(1);
  });

  it("a changed-file run sees a schema the config names outside its folder", () => {
    const root = tmp("vk-sqlc-");
    put(root, {
      "app/sqlc.yaml": CONFIG.replace(
        "schema: db/schema.sql",
        "schema: ../schema/schema.sql",
      ),
      "schema/schema.sql": "CREATE TABLE users (id INTEGER);\n",
    });
    const planned = (changedPaths: string[]) =>
      expand(
        sqlcDiff,
        { cwd: root },
        env(root, { scopedFiles: [`${root}/app/sqlc.yaml`], changedPaths }),
      );
    expect(planned(["schema/schema.sql"])).toHaveLength(1);
    expect(planned(["other/x.sql"])).toEqual([]);
  });

  it("a config that names a database is not run: sqlc connects to it", () => {
    const root = tmp("vk-sqlc-");
    put(root, {
      "sqlc.yaml": CONFIG.replace(
        "    gen:",
        "    database:\n      uri: postgresql://u:p@db.example.invalid:5432/app\n    gen:",
      ),
    });
    const [task] = expand(
      sqlcVet,
      { cwd: root },
      env(root, { scopedFiles: [`${root}/sqlc.yaml`] }),
    );
    expect(task?.cannotRun).toMatch(/names a database/);
    // A database sqlc could not reach is no compile error.
    expect(() =>
      sqlcVet.parseOutput(
        ran(
          1,
          "",
          "# package db\ndb/query.sql:1:1: failed to connect to `user=u database=app`: hostname resolving error\n",
        ),
        ctx(root, { options: task?.options }),
      ),
    ).toThrow(/could not reach the database/);
  });

  it("vet: a rule hit at its query's line, compile errors at theirs, database rules as one info", () => {
    const { root, tasks } = project();
    const c = ctx(`${root}/api`, { options: tasks[0]?.options });
    const { findings } = sqlcVet.parseOutput(
      ran(
        1,
        "",
        "query.sql: GetUser: sqlc/db-prepare: error preparing query: database connection required\nquery.sql: DeleteAll: sqlc/db-prepare: error preparing query: database connection required\nquery.sql: DeleteAll: no-delete-without-where: DELETE needs a WHERE\n",
      ),
      c,
    );
    expect(findings.map((f) => [f.file, f.line, f.ruleId, f.severity])).toEqual(
      [
        [`${root}/api/db/query.sql`, 4, "no-delete-without-where", "error"],
        [`${root}/api/sqlc.yaml`, 1, "sqlc/db-prepare", "info"],
      ],
    );
    const compile = sqlcVet.parseOutput(
      ran(
        1,
        "",
        '# package \ndb/query.sql:2:12: column "nope" does not exist\n',
      ),
      c,
    );
    expect(
      compile.findings.map((f) => [f.file, f.line, f.col, f.ruleId]),
    ).toEqual([[`${root}/api/db/query.sql`, 2, 12, "compile"]]);
    expect(() =>
      sqlcVet.parseOutput(
        ran(1, "", "error parsing missing.yaml: file does not exist\n"),
        c,
      ),
    ).toThrow(
      "sqlc vet exited 1: error parsing missing.yaml: file does not exist",
    );
    expect(sqlcVet.buildArgs(c).args).toEqual([
      "vet",
      "--no-remote",
      "-f",
      "sqlc.yaml",
    ]);
  });

  it("diff: one finding per stale generated file; a missing output folder named at the config", () => {
    const { root, tasks } = project();
    const c = ctx(`${root}/api`, { options: tasks[0]?.options });
    const stale = [
      "--- a/gen/query.sql.go",
      "+++ b/gen/query.sql.go",
      "@@ -10,12 +10,12 @@",
      " )",
      " ",
      " const getUser = `-- name: GetUser :one",
      "-SELECT id, name FROM users WHERE id = ?",
      "+SELECT id FROM users WHERE id = ?",
      " `",
      " ",
      "-func (q *Queries) GetUser(ctx context.Context, id int64) (User, error) {",
      "+func (q *Queries) GetUser(ctx context.Context, id int64) (int64, error) {",
      " \trow := q.db.QueryRowContext(ctx, getUser, id)",
      "-\tvar i User",
      "-\terr := row.Scan(&i.ID, &i.Name)",
      "-\treturn i, err",
      "+\tvar id_2 int64",
      "+\terr := row.Scan(&id_2)",
      "+\treturn id_2, err",
      " }",
      "",
    ].join("\n");
    const { findings } = sqlcDiff.parseOutput(ran(1, "", stale), c);
    expect(findings.map((f) => [f.file, f.line, f.ruleId, f.language])).toEqual(
      [[`${root}/api/gen/query.sql.go`, 13, "stale", "go"]],
    );
    // gen/ does not exist in this project: exit 1, nothing printed.
    const nogen = sqlcDiff.parseOutput(ran(1), c);
    expect(nogen.findings.map((f) => [f.file, f.ruleId])).toEqual([
      [`${root}/api/sqlc.yaml`, "stale"],
    ]);
    expect(nogen.findings[0]?.message).toMatch(/no `gen` folder/);
    // A new query file never generated, its folder there (review-iac/sqlc2).
    mkdirSync(join(root, "api", "gen"));
    const missing = sqlcDiff.parseOutput(ran(1), c).findings;
    expect(missing.map((f) => [f.file, f.ruleId, f.severity])).toEqual([
      [`${root}/api/sqlc.yaml`, "stale", "error"],
    ]);
    expect(missing[0]?.message).toMatch(/for a query file never generated/);
  });

  it("diff: queries that do not compile are sqlc-vet's to locate, unless it is off", () => {
    const { root, tasks } = project();
    const options = tasks[0]?.options as Record<string, unknown>;
    const compile = ran(
      1,
      "",
      '# package db\ndb/query.sql:2:12: column "nope" does not exist\n',
    );
    const atConfig = sqlcDiff.parseOutput(
      compile,
      ctx(`${root}/api`, { options }),
    );
    expect(atConfig.findings.map((f) => [f.file, f.ruleId])).toEqual([
      [`${root}/api/sqlc.yaml`, "compile"],
    ]);
    const alone = sqlcDiff.parseOutput(
      compile,
      ctx(`${root}/api`, { options: { ...options, vetRuns: false } }),
    );
    expect(alone.findings.map((f) => [f.file, f.line, f.col])).toEqual([
      [`${root}/api/db/query.sql`, 2, 12],
    ]);
  });
});

describe("graphql-inspector", () => {
  const BREAKING =
    "[log] \nDetected the following changes (1) between schemas:\n\n[log] ✖  Field email was removed from object type User\n[error] Detected 1 breaking change\n";

  it("plans only where options.schema names a file, against the main branch's merge base", () => {
    const root = repo(
      { "api/schema.graphql": "type Query { a: Int }\n" },
      true,
    );
    expect(expand(graphqlInspector, { cwd: root }, env(root))).toEqual([]);
    expect(() =>
      expand(
        graphqlInspector,
        { cwd: root },
        env(root, withOptions("graphql-inspector", { schema: "nope.graphql" })),
      ),
    ).toThrow(/nope.graphql does not exist/);
    const named = withOptions("graphql-inspector", {
      schema: "api/schema.graphql",
    });
    const [task] = expand(graphqlInspector, { cwd: root }, env(root, named));
    const options = task?.options as { schema: string; old?: string };
    expect(options.schema).toBe("api/schema.graphql");
    expect(options.old).toMatch(/^git:[0-9a-f]{40}:api\/schema\.graphql$/);
    expect(
      expand(
        graphqlInspector,
        { cwd: root },
        env(root, { ...named, changedPaths: ["README.md"] }),
      ),
    ).toEqual([]);
    // No main branch compares nothing: incomplete under ci, never a pass.
    const shallow = repo(
      { "api/schema.graphql": "type Query { a: Int }\n" },
      false,
    );
    expect(
      expand(graphqlInspector, { cwd: shallow }, env(shallow, named)).map(
        (t) => t.cannotRun,
      ),
    ).toEqual([expect.stringMatching(/no merge base of HEAD/)]);
  });

  it("a breaking change is an error, a dangerous one info; exit 1 without the verdict is a crash", () => {
    const root = tmp("vk-gql-");
    const c = ctx(root, {
      options: { schema: "schema.graphql", old: "git:abc:schema.graphql" },
    });
    const { findings } = graphqlInspector.parseOutput(ran(1, BREAKING), c);
    expect(
      findings.map((f) => [f.file, f.ruleId, f.severity, f.message]),
    ).toEqual([
      [
        `${root}/schema.graphql`,
        "breaking",
        "error",
        "breaking change: Field email was removed from object type User",
      ],
    ]);
    const dangerous = graphqlInspector.parseOutput(
      ran(
        0,
        "[log] \nDetected the following changes (1) between schemas:\n\n[log] ⚠  Enum value GUEST was added to enum Role\n[success] No breaking changes detected\n",
      ),
      c,
    );
    expect(dangerous.findings.map((f) => f.severity)).toEqual(["info"]);
    expect(
      graphqlInspector.parseOutput(ran(0, "[success] No changes detected\n"), c)
        .findings,
    ).toEqual([]);
    expect(() =>
      graphqlInspector.parseOutput(
        ran(
          1,
          "[error] NoTypeDefinitionsFound: \n      Unable to find any GraphQL type definitions for the following pointers:\n",
        ),
        c,
      ),
    ).toThrow("graphql-inspector diff failed: [error] NoTypeDefinitionsFound:");
  });
});

/** A plan env whose config enables apiDiff on openapi.json. */
const apiDiff = (more: Record<string, unknown> = {}): Partial<PlanEnv> =>
  ({
    config: {
      ignore: [],
      tools: {},
      apiDiff: { enabled: true, specs: ["openapi.json"], ...more },
    },
  }) as unknown as Partial<PlanEnv>;

/** The oasdiff tasks, or why they cannot run, for `more` in apiDiff. */
const oasdiffTasks = (root: string, more?: Record<string, unknown>) =>
  expand(oasdiff, { cwd: root }, env(root, apiDiff(more))).map(
    (t) => t.cannotRun ?? t.options,
  );

describe("oasdiff's base", () => {
  it("is the merge base with the main branch unless apiDiff.baseRef names one", () => {
    const root = repo({ "openapi.json": "{}\n" }, true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    expect(oasdiffTasks(root)).toEqual([
      { spec: "openapi.json", baseRef: head, label: head.slice(0, 12) },
    ]);
    // A named ref is read as its commit, and named as written.
    expect(oasdiffTasks(root, { baseRef: "HEAD" })).toEqual([
      { spec: "openapi.json", baseRef: head, label: "HEAD" },
    ]);
  });

  it("an empty apiDiff.baseRef (an unset GITHUB_BASE_REF) is a config error, never the index", async () => {
    const root = repo({ "openapi.json": "{}\n" }, true);
    put(root, {
      "validate.config.json": JSON.stringify({
        apiDiff: { enabled: true, specs: ["openapi.json"], baseRef: "" },
      }),
    });
    await expect(resolveConfig(root)).rejects.toThrow(/baseRef/);
  });

  it("with no main branch it cannot run, never a pass", () => {
    const root = repo({ "openapi.json": "{}\n" }, false);
    expect(oasdiffTasks(root)).toEqual([
      expect.stringMatching(/no merge base of HEAD/),
    ]);
  });

  it("a spec the base does not have yet is not compared: info, and oasdiff does not run", () => {
    const root = repo({ "README.md": "x\n" }, true);
    put(root, { "openapi.json": "{}\n" });
    const [task] = expand(oasdiff, { cwd: root }, env(root, apiDiff()));
    const c = ctx(root, { options: task?.options });
    expect(oasdiff.buildArgs(c).bin).toBe(process.execPath);
    const { findings } = oasdiff.parseOutput(ran(0), c);
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["not-compared", "info"],
    ]);
    expect(findings[0]?.message).toMatch(/its first introduction/);
    // A ref git does not know is still planned, and its build is a crash.
    expect(
      oasdiffTasks(root, { baseRef: "origin/definitely-missing" }),
    ).toEqual([
      {
        spec: "openapi.json",
        baseRef: "origin/definitely-missing",
        label: "origin/definitely-missing",
      },
    ]);
    // A spec on neither side (a typo) is not "new": oasdiff runs and fails.
    const typo = expand(
      oasdiff,
      { cwd: root },
      env(root, {
        config: {
          ignore: [],
          tools: {},
          apiDiff: { enabled: true, specs: ["openapi.jsn"] },
        },
      } as unknown as Partial<PlanEnv>),
    );
    expect(typo).toHaveLength(1);
    expect(typo[0]?.options).not.toHaveProperty("skip");
  });

  it("inTree: true, false, or undefined when git cannot tell, and never a git planted on PATH", () => {
    const root = repo({ "openapi.json": "{}\n" }, false);
    expect(inTree(root, "HEAD", "openapi.json")).toBe(true);
    expect(inTree(root, "HEAD", "nope.json")).toBe(false);
    expect(inTree(root, "0".repeat(40), "openapi.json")).toBeUndefined();
    // A project's own `git` (node_modules/.bin, first on PATH under
    // `pnpm run`) that answers "absent" for every path would switch the API
    // checks off: the system git is used.
    const fake = join(tmp("vk-fake-git-"), "node_modules", ".bin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${fake}:${path ?? ""}`;
    try {
      expect(inTree(root, "HEAD", "openapi.json")).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("tofu", () => {
  it("one finding per hunk of `tofu fmt -check -diff`, at its first changed line", () => {
    const root = tmp("vk-tofu-");
    const stdout = [
      "sub/a.tf",
      "--- old/sub/a.tf",
      "+++ new/sub/a.tf",
      "@@ -1,6 +1,6 @@",
      ' variable "name" {',
      "-type = string",
      '-    default   = "demo"',
      "+  type    = string",
      '+  default = "demo"',
      " }",
      " ",
      ' output "greeting" {',
      "v.tfvars",
      "--- old/v.tfvars",
      "+++ new/v.tfvars",
      "@@ -1 +1 @@",
      "-x   = 1",
      "+x = 1",
      "",
    ].join("\n");
    const { findings } = tofu.parseOutput(ran(3, stdout), ctx(root));
    expect(findings.map((f) => [f.file, f.line, f.fixable])).toEqual([
      [`${root}/sub/a.tf`, 2, true],
      [`${root}/v.tfvars`, 1, true],
    ]);
    const files = { files: [`${root}/main.tf`] };
    expect(tofu.buildArgs(ctx(root, files)).args).toEqual([
      "fmt",
      "-check",
      "-diff",
      "-recursive",
      "-no-color",
      "main.tf",
    ]);
    const fix = tofu.buildArgs(ctx(root, { ...files, fix: true }));
    expect([fix.args, fix.okExitCodes]).toEqual([
      ["fmt", "-recursive", "-no-color", "main.tf"],
      [0],
    ]);
    // The default formatter wherever Terraform files are.
    expect("adoptedAt" in tofu).toBe(false);
  });

  it("is never given Terraform's JSON files, which `tofu fmt` refuses (exit 2)", () => {
    const root = tmp("vk-tofu-");
    const json = [`${root}/use.tf.json`, `${root}/terraform.tfvars.json`];
    expect(expand(tofu, { cwd: root, files: json }, env(root))).toEqual([]);
    expect(
      expand(
        tofu,
        { cwd: root, files: [...json, `${root}/main.tf`] },
        env(root),
      ),
    ).toEqual([{ cwd: root, files: [`${root}/main.tf`] }]);
  });

  it("reads a hunk's own lines as content, even when they look like headers", () => {
    expect(
      hunkStarts(
        "--- a/q.go\n+++ b/q.go\n@@ -4,3 +4,3 @@\n a\n--- old comment\n+++ new comment\n b\n",
        "b/",
      ),
    ).toEqual([{ file: "q.go", line: 5 }]);
  });
});

describe("trivy", () => {
  const REPORT = {
    SchemaVersion: 2,
    ArtifactName: ".",
    ArtifactType: "filesystem",
    Results: [
      {
        Target: "docker/Dockerfile",
        Class: "config",
        Type: "dockerfile",
        Misconfigurations: [
          {
            ID: "DS-0002",
            Title: "Image user should not be 'root'",
            Message:
              "Specify at least 1 USER command in Dockerfile with non-root user as argument",
            Resolution:
              "Add 'USER <non root user name>' line to the Dockerfile",
            Severity: "HIGH",
            PrimaryURL: "https://avd.aquasec.com/misconfig/ds-0002",
            Status: "FAIL",
            CauseMetadata: { Provider: "Dockerfile", Service: "general" },
          },
          // With `include-non-failures` in trivy.yaml (review-iac/tv2).
          {
            ID: "DS-0001",
            Title: "':latest' tag used",
            Message: "No issues found",
            Severity: "MEDIUM",
            Status: "PASS",
            CauseMetadata: { Provider: "Dockerfile", Service: "general" },
          },
        ],
      },
      {
        Target: "k8s/pod.yaml",
        Class: "config",
        Type: "kubernetes",
        Misconfigurations: [
          {
            ID: "KSV-0003",
            Title: "Default capabilities: some containers do not drop all",
            Message:
              "Container 'app' of Pod 'demo' should add 'ALL' to 'securityContext.capabilities.drop'",
            Severity: "LOW",
            Status: "FAIL",
            CauseMetadata: { StartLine: 7, EndLine: 10 },
          },
        ],
      },
      {
        Target: "tf",
        Class: "config",
        Type: "terraform",
        MisconfSummary: { Successes: 52, Failures: 0 },
      },
      {
        Target: "node_modules/x/main.tf",
        Class: "config",
        Type: "terraform",
        Misconfigurations: [
          {
            ID: "AWS-0086",
            Title: "S3 Access block should block public ACL",
            Severity: "HIGH",
            Status: "FAIL",
            CauseMetadata: { StartLine: 1, EndLine: 4 },
          },
        ],
      },
    ],
  };

  it("reports each misconfiguration at its file and line, by severity, in the kit's scope", () => {
    const root = tmp("vk-trivy-");
    const c = ctx(root, {
      options: { scope: ["docker/Dockerfile", "k8s/pod.yaml"] },
    });
    const { findings } = trivy.parseOutput(ran(1, JSON.stringify(REPORT)), c);
    expect(findings.map((f) => [f.file, f.line, f.ruleId, f.severity])).toEqual(
      [
        [`${root}/docker/Dockerfile`, 1, "DS-0002", "error"],
        [`${root}/k8s/pod.yaml`, 7, "KSV-0003", "info"],
      ],
    );
    expect(findings[0]).toMatchObject({
      message:
        "Image user should not be 'root': Specify at least 1 USER command in Dockerfile with non-root user as argument. Add 'USER <non root user name>' line to the Dockerfile",
      url: "https://avd.aquasec.com/misconfig/ds-0002",
      language: "dockerfile",
    });
    // Nothing to scan: no Results key.
    expect(
      trivy.parseOutput(ran(0, '{"SchemaVersion":2,"ArtifactName":"."}'), c)
        .findings,
    ).toEqual([]);
  });

  it("a fatal error (exit 1, no report) is a crash naming trivy's FATAL line", () => {
    const root = tmp("vk-trivy-");
    const c = ctx(root, { options: { scope: [] } });
    expect(() =>
      trivy.parseOutput(
        ran(
          1,
          "",
          "2026-10-18T03:12:04-07:00\tINFO\t[misconfig] Misconfiguration scanning is enabled\n2026-10-18T03:12:04-07:00\tFATAL\tFatal error\trun error: fs scan error: lstat nope: no such file or directory\n",
        ),
        c,
      ),
    ).toThrow(/FATAL\tFatal error/);
    expect(() =>
      trivy.parseOutput(ran(1, '{"Results":[{"Target":"a"}]}'), c),
    ).toThrow(/report holds no failed check/);
  });

  it("puts a finding in a later YAML document at its own line", () => {
    const root = tmp("vk-trivy-");
    // trivy 0.69.3 counts without the `---` lines (review-iac/tv5): the
    // container of the second document is at 13, not 12.
    put(root, {
      "m.yaml":
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata: {x: y}\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  containers:\n    - name: c\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n",
    });
    const stdout = JSON.stringify({
      Results: [
        {
          Target: "m.yaml",
          Type: "kubernetes",
          Misconfigurations: [
            {
              ID: "KSV-0017",
              Title: "Privileged",
              Severity: "HIGH",
              Status: "FAIL",
              CauseMetadata: { StartLine: 12, EndLine: 15 },
            },
          ],
        },
      ],
    });
    const { findings } = trivy.parseOutput(
      ran(1, stdout),
      ctx(root, { options: { scope: ["m.yaml"] } }),
    );
    expect(findings.map((f) => [f.line, f.endLine])).toEqual([[13, 16]]);
  });

  it("runs where a trivy.yaml is or it is enabled, when a file it reads changed", () => {
    const root = tmp("vk-trivy-");
    const scoped = { scopedFiles: [`${root}/Dockerfile`, `${root}/a.ts`] };
    expect(expand(trivy, { cwd: root }, env(root, scoped))).toEqual([]);
    put(root, { "trivy.yaml": "severity: [HIGH]\n" });
    const [task] = expand(trivy, { cwd: root }, env(root, scoped));
    expect(task?.options).toEqual({ scope: ["Dockerfile"] });
    expect(
      expand(
        trivy,
        { cwd: root },
        env(root, { ...scoped, changedPaths: ["a.ts"] }),
      ),
    ).toEqual([]);
    put(root, { Dockerfile: "FROM scratch\n" });
    const built = trivy.buildArgs(ctx(root, { options: task?.options }));
    expect(built.args.slice(0, -1)).toEqual([
      "config",
      "--format",
      "json",
      "--exit-code",
      "1",
      "--skip-check-update",
      "--skip-version-check",
      // Without it trivy pings check.trivy.dev on every run (review-iac/tv1).
      "--disable-telemetry",
    ]);
    // A copy of the scope, not the tree (node_modules took 45 s).
    const staged = built.args.at(-1) ?? "";
    expect(readFileSync(join(staged, "Dockerfile"), "utf8")).toBe(
      "FROM scratch\n",
    );
    // Remote Terraform modules: the registry through a dead proxy, git
    // only for local repositories (review-iac/tv3).
    expect(built.env).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:9",
      GIT_ALLOW_PROTOCOL: "file",
    });
    expect(trivy.refuseArgs?.(["--include-non-failures"])).toMatch(
      /failed checks/,
    );
  });
});

describe("kubeconform", () => {
  const FINDING = `{
  "resources": [
    {
      "filename": "deploy.yaml",
      "kind": "Deployment",
      "name": "demo",
      "version": "apps/v1",
      "status": "statusInvalid",
      "msg": "problem validating schema. Check JSON formatting: jsonschema validation failed with 'https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/master-standalone-strict/deployment-apps-v1.json#' - at '/spec/replicas': got string, want null or integer - at '/spec/template/spec': additional properties 'bogusField' not allowed",
      "validationErrors": [
        { "path": "/spec/template/spec", "msg": "additional properties 'bogusField' not allowed" },
        { "path": "/spec/replicas", "msg": "got string, want null or integer" }
      ]
    },
    {
      "filename": "crd.yaml",
      "kind": "Widget",
      "name": "w",
      "version": "example.com/v1",
      "status": "statusError",
      "msg": "could not find schema for Widget"
    }
  ],
  "summary": { "valid": 0, "invalid": 1, "errors": 1, "skipped": 0 }
}`;

  it("one error per wrong field, sorted, and a resource it could not check", () => {
    const root = tmp("vk-kubeconform-");
    const { findings } = kubeconform.parseOutput(ran(1, FINDING), ctx(root));
    expect(findings.map((f) => [f.file, f.ruleId, f.message])).toEqual([
      [
        `${root}/deploy.yaml`,
        "schema",
        "Deployment demo: /spec/replicas: got string, want null or integer",
      ],
      [
        `${root}/deploy.yaml`,
        "schema",
        "Deployment demo: /spec/template/spec: additional properties 'bogusField' not allowed",
      ],
      [
        `${root}/crd.yaml`,
        "not-validated",
        "Widget w: not checked: could not find schema for Widget",
      ],
    ]);
    const clean =
      '{\n  "resources": [],\n  "summary": {\n    "valid": 1,\n    "invalid": 0,\n    "errors": 0,\n    "skipped": 0\n  }\n}\n';
    expect(kubeconform.parseOutput(ran(0, clean), ctx(root)).findings).toEqual(
      [],
    );
    expect(() =>
      kubeconform.parseOutput(
        ran(1, "", "flag provided but not defined: -bogus\n"),
        ctx(root),
      ),
    ).toThrow(
      "kubeconform produced no JSON output on exit code 1: flag provided but not defined: -bogus",
    );
  });

  it("opt-in only, with the paths and schema location it must be given; only the scope's manifests", () => {
    const root = tmp("vk-kubeconform-");
    const DEPLOY = "apiVersion: apps/v1\nkind: Deployment\n";
    put(root, {
      "k8s/deploy.yaml": DEPLOY,
      "k8s/config.yaml": "name: x\n",
      "k8s/node_modules/foo/d.yaml": DEPLOY,
    });
    expect(kubeconform.adoptedAt?.(root, root)).toBe(false);
    expect(() =>
      expand(
        kubeconform,
        { cwd: root },
        env(root, withOptions("kubeconform", { paths: ["k8s"] })),
      ),
    ).toThrow(/tools\.kubeconform\.options\.schemaLocation/);
    const options = {
      paths: ["k8s"],
      schemaLocation: "schemas/{{.ResourceKind}}{{.KindSuffix}}.json",
    };
    // node_modules is outside the scope; a config file holds no object.
    const scoped = {
      scopedFiles: [`${root}/k8s/deploy.yaml`, `${root}/k8s/config.yaml`],
    };
    const [task] = expand(
      kubeconform,
      { cwd: root },
      env(root, { ...withOptions("kubeconform", options), ...scoped }),
    );
    const c = ctx(root, { options: task?.options });
    const args = kubeconform.buildArgs(c).args;
    expect(args.slice(0, 6)).toEqual([
      "-output",
      "json",
      "-strict",
      "-summary",
      "-schema-location",
      options.schemaLocation,
    ]);
    expect(args.slice(-1)).toEqual(["k8s/deploy.yaml"]);
    expect(
      expand(
        kubeconform,
        { cwd: root },
        env(root, {
          ...withOptions("kubeconform", options),
          changedPaths: ["README.md"],
        }),
      ),
    ).toEqual([]);
  });
});

/** One kube-linter report as 0.8.3 prints it, trimmed. */
const kubeLinterReport = (check: string, path: string) => ({
  Diagnostic: {
    Message:
      'The container "app" is using an invalid container image, "nginx:latest".',
  },
  Check: check,
  Remediation: "Use a container image with a specific tag other than latest.",
  Object: {
    Metadata: { FilePath: path },
    K8sObject: {
      Namespace: "",
      Name: "demo",
      GroupVersionKind: { Group: "apps", Version: "v1", Kind: "Deployment" },
    },
  },
});

describe("kube-linter", () => {
  it("one error per report at its file, line 1, in the kit's scope", () => {
    const root = tmp("vk-kube-linter-");
    const stdout = JSON.stringify({
      Checks: [],
      Reports: [
        kubeLinterReport("latest-tag", `${root}/deploy.yaml`),
        kubeLinterReport("latest-tag", `${root}/node_modules/x/deploy.yaml`),
      ],
      Summary: { ChecksStatus: "Failed", KubeLinterVersion: "0.8.3" },
    });
    const c = ctx(root, {
      options: { inputs: ["deploy.yaml"], scope: ["deploy.yaml"] },
    });
    const { findings } = kubeLinter.parseOutput(ran(1, stdout), c);
    expect(
      findings.map((f) => [f.file, f.line, f.ruleId, f.severity, f.message]),
    ).toEqual([
      [
        `${root}/deploy.yaml`,
        1,
        "latest-tag",
        "error",
        'Deployment demo: The container "app" is using an invalid container image, "nginx:latest". Use a container image with a specific tag other than latest.',
      ],
    ]);
    const clean =
      '{"Checks":[],"Reports":null,"Summary":{"ChecksStatus":"Passed","KubeLinterVersion":"0.8.3"}}';
    expect(kubeLinter.parseOutput(ran(0, clean), c).findings).toEqual([]);
    expect(() =>
      kubeLinter.parseOutput(
        ran(
          1,
          "",
          'Error: loading from path "nope.yaml": lstat nope.yaml: no such file or directory\n',
        ),
        c,
      ),
    ).toThrow(/no JSON output on exit code 1: Error: loading from path/);
    expect(() =>
      kubeLinter.parseOutput(ran(1, clean.replace("Passed", "Failed")), c),
    ).toThrow(/output format may have changed/);
    // Nothing it could read as Kubernetes (review-iac/kl2): exit 0, no JSON.
    expect(
      kubeLinter.parseOutput(
        ran(0, "", "Warning: no valid objects found.\n"),
        c,
      ).findings,
    ).toEqual([]);
  });

  it("a chart that does not render and a manifest that does not parse are errors, a config YAML is not", () => {
    const root = tmp("vk-kube-linter-");
    // kube-linter 0.8.3 --fail-on-invalid-resource (review-iac/tv4): the
    // status stays Passed, and the chart's other templates go unchecked.
    const load = (path: string, message: string) => ({
      Diagnostic: { Message: message },
      Check: "failed-to-load-object",
      Remediation: "Confirm that the file is accessible and is valid k8s yaml.",
      Object: { Metadata: { FilePath: `${root}/${path}` } },
    });
    const stdout = JSON.stringify({
      Checks: [],
      Reports: [
        load(
          ".kube-linter.yaml",
          "failed to decode: Object 'Kind' is missing in 'checks: {}'",
        ),
        load(
          "charts/app",
          'failed to render: template: app/templates/cm.yaml:4:18: executing "app/templates/cm.yaml" at <.Values.missing.deep>: nil pointer evaluating interface {}.deep',
        ),
        load(
          "k8s/broken.yaml",
          "failed to decode: yaml: line 3: did not find expected ',' or ']'",
        ),
      ],
      Summary: { ChecksStatus: "Passed", KubeLinterVersion: "0.8.3" },
    });
    const c = ctx(root, {
      options: {
        inputs: ["charts/app", "k8s/broken.yaml"],
        scope: [
          ".kube-linter.yaml",
          "charts/app/Chart.yaml",
          "charts/app/templates/cm.yaml",
          "k8s/broken.yaml",
        ],
      },
    });
    const { findings } = kubeLinter.parseOutput(ran(1, stdout), c);
    expect(findings.map((f) => [f.file, f.line, f.col, f.ruleId])).toEqual([
      [`${root}/charts/app/templates/cm.yaml`, 4, 18, "render"],
      [`${root}/k8s/broken.yaml`, 3, 1, "parse"],
    ]);
    expect(
      findings.filter((f) => kubeLinter.masks?.(f)).map((f) => f.ruleId),
    ).toEqual(["render"]);
    expect(kubeLinter.buildArgs(c).args).toContain(
      "--fail-on-invalid-resource",
    );
  });

  it("runs where the root holds .kube-linter.yaml or .yml, on the scope's manifests and charts", () => {
    const root = tmp("vk-kube-linter-");
    expect(kubeLinter.adoptedAt?.(root, root)).toBe(false);
    const DEPLOY = "apiVersion: apps/v1\nkind: Deployment\n";
    put(root, {
      ".kube-linter.yml": "checks: {}\n",
      "k8s/d.yaml": DEPLOY,
      "a.yaml": "name: not kubernetes\n",
      "charts/app/Chart.yaml": "apiVersion: v2\nname: app\n",
      "charts/app/templates/d.yaml": DEPLOY,
    });
    expect(kubeLinter.adoptedAt?.(root, root)).toBe(true);
    const scoped = {
      scopedFiles: [
        `${root}/k8s/d.yaml`,
        `${root}/a.yaml`,
        `${root}/charts/app/Chart.yaml`,
        `${root}/charts/app/templates/d.yaml`,
      ],
    };
    const [all] = expand(kubeLinter, { cwd: root }, env(root, scoped));
    expect(all?.options).toEqual({
      inputs: ["charts/app", "k8s/d.yaml"],
      scope: [
        "k8s/d.yaml",
        "a.yaml",
        "charts/app/Chart.yaml",
        "charts/app/templates/d.yaml",
      ],
    });
    const [k8s] = expand(
      kubeLinter,
      { cwd: root },
      env(root, {
        ...scoped,
        ...withOptions("kube-linter", { paths: ["k8s"] }),
      }),
    );
    expect(k8s?.options).toEqual({
      inputs: ["k8s/d.yaml"],
      scope: ["k8s/d.yaml"],
    });
    expect(() =>
      expand(
        kubeLinter,
        { cwd: root },
        env(root, withOptions("kube-linter", { paths: ["nope"] })),
      ),
    ).toThrow(/nope does not exist/);
  });
});

describe("pluto", () => {
  const INGRESS =
    "apiVersion: extensions/v1beta1\nkind: Ingress\nmetadata:\n  name: demo\n";
  const HPA =
    "apiVersion: autoscaling/v2beta2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: demo\n";

  /** A project with the two manifests, and the task's copy of them. */
  function staged() {
    const root = tmp("vk-pluto-");
    put(root, { "k8s/ingress.yaml": INGRESS, "k8s/hpa.yaml": HPA });
    const c = ctx(root, {
      options: {
        files: ["k8s/ingress.yaml", "k8s/hpa.yaml"],
        target: "v1.33.0",
      },
    });
    const built = pluto.buildArgs(c);
    return { root, c, built, real: realpathSync(built.cwd ?? "") };
  }

  it("reads a copy of the scope from inside it, for the target version", () => {
    const { built, real } = staged();
    // Given an absolute -d, pluto 5.24.4 prints `<cwd>/<that path>`.
    expect(built.args).toEqual([
      "detect-files",
      "-d",
      ".",
      "-o",
      "json",
      "-t",
      "k8s=v1.33.0",
    ]);
    expect(readFileSync(join(real, "k8s/hpa.yaml"), "utf8")).toBe(HPA);
  });

  it("a removed API is an error, a deprecated one a warning, at the project's file", () => {
    const { root, c, real } = staged();
    const removed = `{"items":[{"name":"demo","filePath":"${real}/k8s/ingress.yaml","api":{"version":"extensions/v1beta1","kind":"Ingress","deprecated-in":"v1.14.0","removed-in":"v1.22.0","replacement-api":"networking.k8s.io/v1","replacement-available-in":"v1.19.0","component":"k8s"},"deprecated":true,"removed":true,"replacementAvailable":true}],"target-versions":{"cert-manager":"v1.5.3","istio":"v1.11.0","k8s":"v1.33.0"}}`;
    const deprecated = `{"items":[{"name":"demo","filePath":"${real}/k8s/hpa.yaml","api":{"version":"autoscaling/v2beta2","kind":"HorizontalPodAutoscaler","deprecated-in":"v1.23.0","removed-in":"v1.26.0","replacement-api":"autoscaling/v2","replacement-available-in":"","component":"k8s"},"deprecated":true,"removed":false,"replacementAvailable":false}],"target-versions":{"cert-manager":"v1.5.3","istio":"v1.11.0","k8s":"v1.25.0"}}`;
    expect(
      pluto
        .parseOutput(ran(3, removed), c)
        .findings.map((f) => [f.file, f.severity, f.message]),
    ).toEqual([
      [
        `${root}/k8s/ingress.yaml`,
        "error",
        "Ingress demo uses extensions/v1beta1, removed in Kubernetes v1.22.0: move to networking.k8s.io/v1 (available since v1.19.0)",
      ],
    ]);
    // An empty replacement-available-in is pluto not knowing, not "later".
    expect(
      pluto
        .parseOutput(ran(4, deprecated), c)
        .findings.map((f) => [f.severity, f.message]),
    ).toEqual([
      [
        "warning",
        "HorizontalPodAutoscaler demo uses autoscaling/v2beta2, deprecated since Kubernetes v1.23.0: move to autoscaling/v2 (pluto does not know when it became available)",
      ],
    ]);
    const clean =
      '{"target-versions":{"cert-manager":"v1.5.3","istio":"v1.11.0","k8s":"v1.33.0"}}';
    expect(pluto.parseOutput(ran(0, clean), c).findings).toEqual([]);
    expect(() => pluto.parseOutput(ran(3, clean), c)).toThrow(
      /output holds none/,
    );
  });

  it("a manifest that is not valid YAML, which pluto skips without a word, is an error", () => {
    const root = tmp("vk-pluto-");
    put(root, {
      "k8s/broken.yaml":
        "apiVersion: policy/v1beta1\nkind: PodSecurityPolicy\nmetadata: [oops\n",
    });
    const c = ctx(root, {
      options: { files: ["k8s/broken.yaml"], target: "v1.33.0" },
    });
    pluto.buildArgs(c);
    const clean =
      '{"target-versions":{"cert-manager":"v1.5.3","istio":"v1.11.0","k8s":"v1.33.0"}}';
    const { findings } = pluto.parseOutput(ran(0, clean), c);
    expect(findings.map((f) => [f.file, f.ruleId, f.severity])).toEqual([
      [`${root}/k8s/broken.yaml`, "parse", "error"],
    ]);
  });

  it("opt-in only, on the scope's manifests, for options.targetVersion", () => {
    const root = tmp("vk-pluto-");
    put(root, {
      "k8s/a.yaml": INGRESS,
      "k8s/config.yaml": "name: not kubernetes\n",
      "charts/b.yaml": HPA,
    });
    expect(pluto.adoptedAt?.(root, root)).toBe(false);
    const scopedFiles = [
      `${root}/k8s/a.yaml`,
      `${root}/k8s/config.yaml`,
      `${root}/charts/b.yaml`,
    ];
    const planned = (options: unknown, changedPaths?: string[]) =>
      expand(
        pluto,
        { cwd: root },
        env(root, {
          ...withOptions("pluto", options),
          scopedFiles,
          ...(changedPaths ? { changedPaths } : {}),
        }),
      ).map((t) => t.options);
    expect(planned({ paths: ["k8s"] })).toEqual([
      { files: ["k8s/a.yaml"], target: "v1.33.0" },
    ]);
    expect(planned({ targetVersion: "v1.30.0" })).toEqual([
      { files: ["k8s/a.yaml", "charts/b.yaml"], target: "v1.30.0" },
    ]);
    expect(planned({ paths: ["k8s"] }, ["charts/b.yaml"])).toEqual([]);
    expect(pluto.refuseArgs?.(["-t", "k8s=v1.29.0"])).toMatch(
      /options\.targetVersion/,
    );
  });
});
