import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { escapeRegex, findingsArray, scratchOf } from "./base.js";
import {
  configIn,
  excerpt,
  failureLine,
  formatChanged,
  isTestFile,
  type MutantKind,
  type MutationTask,
  MUTATION_TOOL,
  mutantFinding,
  mutationResult,
  planMutation,
  position,
  scopedFile,
} from "./mutation.js";

interface GremlinsFile {
  file_name?: unknown;
  mutations?: { type?: unknown; status?: unknown }[];
}

const CONFIGS = [
  ".gremlins.yaml",
  ".gremlins.yml",
  ".gremlins.json",
  ".gremlins",
];

const KINDS = new Map<unknown, MutantKind>([
  ["LIVED", "survived"],
  ["NOT COVERED", "no-coverage"],
]);

/** A Go operator at the start of `text` (what a gremlins mutant replaces). */
const OPERATOR = /^(?:&&|\|\||\+\+|--|<<|>>|&\^|[<>!=]=|[-+*/%&|^<>!])/;

/**
 * The pattern for `--exclude-files` that leaves only `targets` to mutate: a
 * whole folder where no target is under it, else the file. No flag names the
 * files to mutate, and RE2 has no lookahead to say "only these".
 */
function untouched(
  targets: readonly string[],
  sources: readonly string[],
): string | undefined {
  const holding = new Set(
    targets.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
    }),
  );
  const patterns = new Set<string>();
  for (const path of sources) {
    if (targets.includes(path)) continue;
    const parts = path.split("/");
    const free = parts
      .slice(1)
      .findIndex((_, i) => !holding.has(parts.slice(0, i + 1).join("/")));
    patterns.add(
      free < 0
        ? `${escapeRegex(path)}$`
        : `${escapeRegex(parts.slice(0, free + 1).join("/"))}/`,
    );
  }
  return patterns.size > 0 ? `^(?:${[...patterns].join("|")})` : undefined;
}

/** Folders `go` skips, and folders of no module of this one. */
const NOT_GO = new Set(["testdata", "vendor", "node_modules"]);

/**
 * The module's source files (relative, POSIX), from disk: what gremlins
 * mutates, whatever the kit's scope leaves out. Not the files of a nested
 * module, nor in folders Go ignores (`.x`, `_x`, testdata).
 */
function moduleSources(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          !/^[._]/.test(entry.name) &&
          !NOT_GO.has(entry.name) &&
          !existsSync(join(root, path, "go.mod"))
        )
          walk(path);
      } else if (entry.name.endsWith(".go") && !isTestFile(path))
        files.push(path);
    }
  };
  walk("");
  return files.toSorted();
}

/** `unleash.exclude-files` of the project's gremlins config, if it sets any. */
function configuredExcludes(config: string | undefined): string[] {
  if (!config) return [];
  try {
    const parsed = parseYaml(readFileSync(config, "utf8")) as {
      unleash?: { "exclude-files"?: unknown };
    } | null;
    const value = parsed?.unleash?.["exclude-files"];
    return (Array.isArray(value) ? value : [value]).filter(
      (pattern): pattern is string => typeof pattern === "string",
    );
  } catch {
    return [];
  }
}

/**
 * gremlins — mutation testing for Go: it copies the module to a temporary
 * folder per worker, flips one operator at a time and runs `go test`. A
 * mutant no test fails (LIVED) is a test that passes without checking that
 * behaviour. Where `.gremlins.yaml` is (or `tools.gremlins.enabled`), the
 * `deep` tier. Recorded on 0.6.0:
 * docs/research/lint-toolchain/mutation-testing/gremlins-full.md.
 */
export const gremlins: ToolAdapter = {
  id: "gremlins",
  layer: "mutation",
  ...MUTATION_TOOL,
  languages: ["go"],
  bin: "gremlins",
  minVersion: "0.6.0",
  // `go install` builds print `gremlins version dev`: no version to compare.
  parseVersion: (out) => /gremlins version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  rootedAtMarker: true,
  installHint:
    "brew install go-gremlins/tap/gremlins  (or: go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0, which reports version dev)",
  // gremlins reads its config from the module root and the folder it runs in.
  adoptedAt: (root) => configIn(root, CONFIGS),
  expand: (seed, env) => planMutation(seed, env, ["go"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-o|--output|-d|--dry-run|--test-cpu)(=|$)/.test(arg),
    )
      ? "--output and --dry-run replace the report the kit reads, and --test-cpu marks every mutant killed (gremlins 0.6.0)"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const scratch = scratchOf(ctx);
    const task = ctx.options as MutationTask;
    const config =
      ctx.configPath ??
      CONFIGS.map((name) => join(ctx.cwd, name)).find((path) =>
        existsSync(path),
      );
    const exclude =
      task.targets && untouched(task.targets, moduleSources(ctx.cwd));
    return {
      bin: this.bin,
      args: [
        "unleash",
        // With Go's test cache warm, the coverage run takes milliseconds and
        // the default budget (3x it) times every mutant out (issue 267).
        "--timeout-coefficient",
        "30",
        "--output",
        join(scratch, "gremlins.json"),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        // A flag replaces the config's list: the project's own go with it.
        ...(exclude
          ? [exclude, ...configuredExcludes(config)].flatMap((pattern) => [
              "--exclude-files",
              pattern,
            ])
          : []),
        ...ctx.extraArgs,
      ],
      env: {
        GOFLAGS: `${process.env.GOFLAGS ?? ""} -count=1`.trim(),
        // Its copies of the module go to the task's scratch folder.
        TMPDIR: scratch,
      },
      // 10 and 11: below a threshold the project's config sets. 1: it could
      // not run (failing tests, a bad flag); its ERROR line says why.
      okExitCodes: [0, 1, 10, 11],
      // A timeout stops the `go test` runs it started too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 1)
      throw new Error(
        `gremlins could not run (exit 1): ${failureLine(raw, /^ERROR: /)}`,
      );
    const report = join(scratchOf(ctx), "gremlins.json");
    if (!existsSync(report)) {
      // Nothing to mutate writes no report.
      if (
        raw.exitCode === 0 &&
        /No results to report\./.test(raw.stdout + raw.stderr)
      )
        return mutationResult(raw, ctx, []);
      throw new Error(
        `gremlins wrote no report (exit ${raw.exitCode}): ${failureLine(raw)}`,
      );
    }
    const files = findingsArray<GremlinsFile>(
      "gremlins",
      JSON.parse(readFileSync(report, "utf8")),
      "files",
    );
    const inScope = scopedFile(ctx);
    const findings: Finding[] = [];
    let run = 0;
    let timedOut = 0;
    for (const entry of files) {
      let lines: string[] | undefined;
      for (const m of entry.mutations ?? []) {
        if (m.status === "TIMED OUT") timedOut += 1;
        if (m.status !== "SKIPPED" && m.status !== "NOT COVERED") run += 1;
        const kind = KINDS.get(m.status);
        if (!kind) continue;
        const at = position(m);
        if (
          typeof entry.file_name !== "string" ||
          typeof m.type !== "string" ||
          !at
        )
          throw formatChanged(
            "gremlins",
            "reported a mutant without a file, type or position",
          );
        const file = inScope(entry.file_name);
        if (!file) continue;
        // No replaced text in the report: the operator at its column.
        lines ??= readFileSync(file, "utf8").split("\n");
        const operator = OPERATOR.exec(
          (lines[at.line - 1] ?? "").slice(at.column - 1),
        )?.[0];
        findings.push(
          mutantFinding({
            tool: "gremlins",
            language: "go",
            file,
            line: at.line,
            col: at.column,
            kind,
            mutation: operator ? `${m.type} of ${excerpt(operator)}` : m.type,
          }),
        );
      }
    }
    // Every mutant that ran timed out: the budget was wrong, not the tests,
    // and nothing was measured.
    if (run > 0 && timedOut === run)
      throw new Error(
        `gremlins: all ${run} mutants timed out, so none was tested; raise --timeout-coefficient in tools.gremlins.extraArgs`,
      );
    return mutationResult(raw, ctx, findings);
  },
};
