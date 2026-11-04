import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
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
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  finding,
  findingsArray,
  lineOf,
  parseJsonOutput,
  toolOptions,
} from "./base.js";
import { formatChanged } from "./mutation.js";

/**
 * Config files with a schema check-jsonschema ships (`--builtin-schema
 * vendor.*`, offline), by the globs that name them from the project root.
 * GitHub workflows are actionlint's. `*.schema.json` is checked against its
 * own metaschema.
 */
const BUILTIN: readonly { schema: string; globs: readonly string[] }[] = [
  {
    schema: "vendor.renovate",
    globs: [
      "renovate.json",
      "renovate.json5",
      ".renovaterc",
      ".renovaterc.json",
      ".github/renovate.json",
      ".gitlab/renovate.json",
    ],
  },
  {
    schema: "vendor.dependabot",
    globs: [".github/dependabot.yml", ".github/dependabot.yaml"],
  },
  {
    schema: "vendor.compose-spec",
    globs: [
      "compose.yml",
      "compose.yaml",
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.*.yml",
      "compose.*.yaml",
      "docker-compose.*.yml",
      "docker-compose.*.yaml",
    ],
  },
  { schema: "vendor.gitlab-ci", globs: [".gitlab-ci.yml"] },
  { schema: "vendor.circle-ci", globs: [".circleci/config.yml"] },
  {
    schema: "vendor.taskfile",
    globs: ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"],
  },
  {
    schema: "vendor.readthedocs",
    globs: [".readthedocs.yaml", ".readthedocs.yml"],
  },
  {
    schema: "vendor.github-issue-config",
    globs: [".github/ISSUE_TEMPLATE/config.yml"],
  },
  {
    schema: "vendor.github-issue-forms",
    globs: [".github/ISSUE_TEMPLATE/*.yml", ".github/ISSUE_TEMPLATE/*.yaml"],
  },
  {
    schema: "vendor.github-actions",
    globs: [
      "action.yml",
      "action.yaml",
      ".github/actions/*/action.yml",
      ".github/actions/*/action.yaml",
    ],
  },
  { schema: "vendor.mergify", globs: [".mergify.yml"] },
  { schema: "vendor.codecov", globs: ["codecov.yml", ".codecov.yml"] },
  { schema: "vendor.travis", globs: [".travis.yml"] },
  {
    schema: "vendor.azure-pipelines",
    globs: ["azure-pipelines.yml", "azure-pipelines.yaml"],
  },
  { schema: "vendor.bitbucket-pipelines", globs: ["bitbucket-pipelines.yml"] },
  {
    schema: "vendor.buildkite",
    globs: [".buildkite/pipeline.yml", ".buildkite/pipeline.yaml"],
  },
  { schema: "vendor.cloudbuild", globs: ["cloudbuild.yaml", "cloudbuild.yml"] },
  { schema: "vendor.drone-ci", globs: [".drone.yml"] },
  {
    schema: "vendor.woodpecker-ci",
    globs: [
      ".woodpecker.yml",
      ".woodpecker.yaml",
      ".woodpecker/*.yml",
      ".woodpecker/*.yaml",
    ],
  },
  {
    schema: "vendor.snapcraft",
    globs: ["snapcraft.yaml", "snap/snapcraft.yaml"],
  },
  { schema: "vendor.citation-file-format", globs: ["CITATION.cff"] },
  { schema: "metaschema", globs: ["**/*.schema.json"] },
];

const Options = z
  .object({
    /** The project's own pairs: files (globs from the root) and their schema (a builtin name, a path or a URL). */
    schemas: z
      .array(
        z
          .object({
            files: z.array(z.string().min(1)).min(1),
            schema: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

interface Task {
  schema: string;
  /** Relative to the root (POSIX). */
  files: string[];
}

interface Item {
  filename?: unknown;
  path?: unknown;
  message?: unknown;
}

interface Report {
  status?: unknown;
  errors?: Item[];
  parse_errors?: Item[];
}

/** The last key of a JSON path (`$.services.api.ports` → `ports`). */
function lastKey(path: string): string | undefined {
  const key = path
    .split(/[.[]/)
    .at(-1)
    ?.replace(/]$/, "")
    .replace(/^['"]|['"]$/g, "");
  return key && !/^\d+$/.test(key) ? key : undefined;
}

/**
 * check-jsonschema — a config file against the schema its tool publishes:
 * Renovate, Dependabot, Compose, GitLab CI, CircleCI, Taskfile, Read the
 * Docs, GitHub issue forms and composite actions, and more, from the
 * schemas check-jsonschema bundles (no network); a `*.schema.json` against
 * its metaschema; and the project's own pairs in
 * `tools.check-jsonschema.options.schemas`. A key with a wrong type or an
 * unexpected name is what an agent leaves in a file no linter parses. It
 * runs where such a file is, one task per schema; each error is a finding
 * on the file at the line of the path's last key (the tool gives a JSON
 * path, not a line). GitHub workflows are left to actionlint. Recorded on
 * 0.39.0: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const checkJsonschema: ToolAdapter = {
  id: "check-jsonschema",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "check-jsonschema",
  parseVersion: (out) => /version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.28.0",
  installHint:
    "uv tool install check-jsonschema  (or: pip install check-jsonschema)",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const own = toolOptions(env, "check-jsonschema", Options).schemas ?? [];
    const pairs = [
      ...own.map((p) => ({ schema: p.schema, globs: p.files })),
      ...BUILTIN,
    ];
    const ignore =
      env.config.ignore.length > 0
        ? picomatch(env.config.ignore, { dot: true })
        : () => false;
    const changed = env.changedPaths
      ? new Set(env.changedPaths.map(toPosix))
      : undefined;
    const candidates = env.scopedFiles
      .map((file) => toPosix(file))
      .map((file) =>
        file.startsWith(`${toPosix(root)}/`)
          ? file.slice(toPosix(root).length + 1)
          : file,
      );
    const tasks: TaskSeed[] = [];
    const taken = new Set<string>();
    for (const pair of pairs) {
      const matches = picomatch([...pair.globs], { dot: true });
      // Exact names are looked up on disk (a dotfile is outside the scope's
      // languages); globs with a wildcard are matched against the scope.
      const named = pair.globs
        .filter((g) => !/[*?[{]/.test(g))
        .filter((g) => existsSync(join(root, g)));
      const files = [
        ...new Set([...named, ...candidates.filter((f) => matches(f))]),
      ]
        .filter(
          (f) => !ignore(f) && !taken.has(f) && (!changed || changed.has(f)),
        )
        .toSorted();
      if (files.length === 0) continue;
      for (const f of files) taken.add(f);
      const task: Task = { schema: pair.schema, files };
      tasks.push({ ...seed, files, options: task });
    }
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-o|--output-format|--builtin-schema|--schemafile|--check-metaschema)(=|$)/.test(
        arg,
      ),
    )
      ? "-o, --builtin-schema, --schemafile and --check-metaschema are the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as Task;
    const schema =
      task.schema === "metaschema"
        ? ["--check-metaschema"]
        : task.schema.startsWith("vendor.")
          ? ["--builtin-schema", task.schema]
          : ["--schemafile", task.schema];
    return {
      bin: this.bin,
      args: ["-o", "json", ...schema, ...ctx.extraArgs, ...task.files],
      // 1: a file fails its schema (a missing file too, with a traceback and
      // no JSON); 2: a bad option or schema name.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const task = ctx.options as Task;
    const report = parseJsonOutput<Report>("check-jsonschema", raw, {
      errors: [],
      parse_errors: [],
    });
    const errors = findingsArray<Item>("check-jsonschema", report.errors ?? []);
    const parseErrors = findingsArray<Item>(
      "check-jsonschema",
      report.parse_errors ?? [],
    );
    if (raw.exitCode === 1 && errors.length === 0 && parseErrors.length === 0)
      throw formatChanged(
        "check-jsonschema",
        "exited 1 with no error in its JSON",
      );
    const ruleId = task.schema.replace(/^vendor\./, "").replace(/^.*\//, "");
    const texts = new Map<string, string | undefined>();
    const textOf = (file: string): string | undefined => {
      if (!texts.has(file)) {
        try {
          texts.set(file, readFileSync(file, "utf8"));
        } catch {
          texts.set(file, undefined);
        }
      }
      return texts.get(file);
    };
    const findings: Finding[] = [];
    for (const [items, parse] of [
      [errors, false],
      [parseErrors, true],
    ] as const) {
      for (const item of items) {
        if (
          typeof item.filename !== "string" ||
          typeof item.message !== "string"
        )
          throw formatChanged(
            "check-jsonschema",
            "reported an error without a filename or message",
          );
        const file = absPosix(cwd, item.filename);
        const path = typeof item.path === "string" ? item.path : "";
        const key = lastKey(path);
        findings.push(
          finding({
            tool: "check-jsonschema",
            layer: "lint",
            file,
            line: key
              ? lineOf(
                  textOf(file),
                  new RegExp(
                    `(?:^|[\\s{,])["']?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]`,
                  ),
                )
              : 1,
            col: 1,
            ruleId: parse ? "parse" : ruleId,
            severity: "error",
            message: path ? `${path}: ${item.message}` : item.message,
            fixable: false,
          }),
        );
      }
    }
    return {
      findings,
      filesProcessed: task.files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
