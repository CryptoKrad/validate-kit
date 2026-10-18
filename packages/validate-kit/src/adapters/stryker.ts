import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import picomatch from "picomatch";
import { upTo } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import { scratchOf } from "./base.js";
import {
  configIn,
  excerpt,
  failureLine,
  formatChanged,
  type MutantKind,
  type MutationTask,
  MUTATION_TOOL,
  mutantFinding,
  mutationResult,
  planMutation,
  position,
  scopedFile,
} from "./mutation.js";

/**
 * Stryker's config names, in the order it looks for them (`stryker.conf.*`
 * wins over `stryker.config.*`); it does not read `.ts` or `.mts` configs
 * (stryker-full.md, 2).
 */
const CONFIGS = [
  "stryker.conf",
  ".stryker.conf",
  "stryker.config",
  ".stryker.config",
].flatMap((name) =>
  ["json", "js", "mjs", "cjs"].map((ext) => `${name}.${ext}`),
);

const KINDS = new Map<unknown, MutantKind>([
  ["Survived", "survived"],
  ["NoCoverage", "no-coverage"],
]);

interface StrykerMutant {
  mutatorName?: unknown;
  replacement?: unknown;
  status?: unknown;
  location?: { start?: unknown; end?: unknown };
}

/** The packages a package.json depends on, development ones included. */
function dependencies(root: string): string[] {
  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as
      Record<string, unknown> | undefined;
  } catch {
    return [];
  }
  return ["dependencies", "devDependencies"].flatMap((field) =>
    Object.keys((pkg?.[field] as Record<string, unknown> | undefined) ?? {}),
  );
}

/** Stryker's own `mutate` default (@stryker-mutator/api 10.0.0 schema). */
const DEFAULT_MUTATE = [
  "{src,lib}/**/!(*.+(s|S)pec|*.+(t|T)est).+(cjs|mjs|js|ts|mts|cts|jsx|tsx|html|vue|svelte)",
  "!{src,lib}/**/__tests__/**/*.+(cjs|mjs|js|ts|mts|cts|jsx|tsx|html|vue|svelte)",
];

/** A Stryker task: a mutation task, and the project's config, if it has one. */
interface StrykerTask extends MutationTask {
  config?: string;
}

/**
 * The package a Stryker run belongs to: the first folder up from `root` with
 * Stryker's config or its dependency.
 */
function strykerHome(root: string, projectRoot: string): string | undefined {
  return upTo(root, projectRoot)
    .map(toPosix)
    .find(
      (dir) =>
        configIn(dir, CONFIGS) ||
        dependencies(dir).includes("@stryker-mutator/core"),
    );
}

/** A `mutate` pattern without its `!` or its line range: the files it names. */
function bare(pattern: string): string {
  return pattern.replace(/^!/, "").replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, "");
}

/** The packages a plan already gave a Stryker run (by the plan's scope list). */
const planned = new WeakMap<readonly string[], Set<string>>();

/**
 * The project's `mutate` patterns, Stryker's default without one; undefined
 * when its config cannot be read here (Stryker reports that when it runs).
 */
async function mutatePatterns(
  config: string | undefined,
): Promise<readonly string[] | undefined> {
  if (!config) return DEFAULT_MUTATE;
  try {
    const loaded: unknown = config.endsWith(".json")
      ? JSON.parse(readFileSync(config, "utf8"))
      : // Imported once per version of the file, not once per process.
        (
          (await import(
            `${pathToFileURL(config).href}?mtime=${statSync(config).mtimeMs}`
          )) as { default?: unknown }
        ).default;
    const mutate = (loaded as { mutate?: unknown } | null)?.mutate;
    if (mutate === undefined) return DEFAULT_MUTATE;
    return Array.isArray(mutate) &&
      mutate.every((pattern) => typeof pattern === "string")
      ? mutate
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A path as a `mutate` pattern that matches only it. Stryker matches with
 * minimatch after turning `\\` into `/`, so a backslash escape is lost: each
 * special character becomes a class of one (`[[]`), which also ends an
 * extglob's `(`.
 */
const literal = (path: string): string =>
  path.replace(/[[\]{}()*?]/g, (char) => `[${char}]`);

/**
 * Stryker (StrykerJS) — mutation testing for TypeScript and JavaScript: it
 * copies the project to a sandbox, plants one mutant at a time and runs the
 * tests. A mutant no test fails is a test that passes without checking that
 * behaviour. Where a Stryker config is in the package (or `@stryker-mutator/core`
 * in its package.json, or `tools.stryker.enabled`), the `deep` tier. The
 * project's config is kept; the kit sets only where the report, the sandbox
 * and the logs go, outside the project. Recorded on 10.0.0:
 * docs/research/lint-toolchain/mutation-testing/stryker-full.md.
 */
export const stryker: ToolAdapter = {
  id: "stryker",
  layer: "mutation",
  ...MUTATION_TOOL,
  languages: ["ts", "js"],
  bin: "stryker",
  minVersion: "10.0.0",
  installHint:
    "npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner  (or the runner for the project's tests)",
  // Stryker reads its config from the package it runs in: one run per such
  // package, whichever of its folders (a tsconfig's) the planner starts from.
  adoptedAt: (root, projectRoot) =>
    strykerHome(root, projectRoot) !== undefined,
  async expand(seed, env) {
    const home = strykerHome(seed.cwd, env.projectRoot) ?? toPosix(seed.cwd);
    let homes = planned.get(env.scopedFiles);
    if (!homes) {
      homes = new Set();
      planned.set(env.scopedFiles, homes);
    }
    if (homes.has(home)) return [];
    homes.add(home);
    const [task] = planMutation(
      { ...seed, cwd: home },
      env,
      ["ts", "js"],
      ["package.json"],
    );
    if (!task) return [];
    const config =
      env.toolConfig.configPath ??
      CONFIGS.map((name) => join(home, name)).find((path) => existsSync(path));
    const options: StrykerTask = {
      ...(task.options as MutationTask),
      ...(config ? { config } : {}),
    };
    // A changed file the project's `mutate` leaves out (a config file, a
    // story, generated code) is not mutated.
    const patterns = options.targets && (await mutatePatterns(config));
    if (options.targets && patterns) {
      const included = picomatch(
        patterns.filter((p) => !p.startsWith("!")).map(bare),
      );
      const excluded = patterns.filter((p) => p.startsWith("!")).map(bare);
      const isExcluded =
        excluded.length > 0 ? picomatch(excluded) : () => false;
      options.targets = options.targets.filter(
        (path) => included(path) && !isExcluded(path),
      );
      if (options.targets.length === 0) return [];
    }
    return [{ ...task, options }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(reporters|tempDirName|inPlace|incrementalFile)(=|$)/.test(arg),
    )
      ? "the kit sets the report, the sandbox and the incremental file, outside the project"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const scratch = scratchOf(ctx);
    const task = ctx.options as StrykerTask;
    const own = task.config;
    const base = !own
      ? "{}"
      : own.endsWith(".json")
        ? `JSON.parse(readFileSync(${JSON.stringify(own)}, "utf8"))`
        : `(await import(${JSON.stringify(pathToFileURL(own).href)})).default ?? {}`;
    // Without a config, the runner plugin the package installed (Stryker's
    // own default is the `command` runner: `npm test`).
    const runners = dependencies(ctx.cwd).flatMap(
      (dep) => /^@stryker-mutator\/(.+)-runner$/.exec(dep)?.[1] ?? [],
    );
    const settings = {
      ...(task.targets ? { mutate: task.targets.map(literal) } : {}),
      reporters: ["json"],
      jsonReporter: { fileName: join(scratch, "mutation.json") },
      tempDirName: join(scratch, "sandbox"),
      cleanTempDir: "always",
      incremental: false,
      incrementalFile: join(scratch, "incremental.json"),
      // A changed file with nothing to mutate, or no test that imports it,
      // is no failure: its mutants come back as NoCoverage.
      allowEmpty: true,
      fileLogLevel: "off",
      logLevel: "warn",
      allowConsoleColors: false,
    };
    const config = join(scratch, "stryker.kit.mjs");
    writeFileSync(
      config,
      [
        'import { readFileSync } from "node:fs";',
        `const base = ${base};`,
        "export default {",
        ...(runners.length === 1
          ? [`  testRunner: ${JSON.stringify(runners[0])},`]
          : []),
        "  ...base,",
        `  ...${JSON.stringify(settings)},`,
        "};",
        "",
      ].join("\n"),
    );
    return {
      bin: this.bin,
      args: ["run", config, ...ctx.extraArgs],
      // 1 is any failure, and also a score under the project's own
      // thresholds.break: the report says which.
      okExitCodes: [0, 1],
      // A timeout stops its test runner processes too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const report = join(scratchOf(ctx), "mutation.json");
    if (!existsSync(report))
      throw new Error(
        `stryker wrote no report (exit ${raw.exitCode}): ${failureLine(raw, /\bERROR\b|Error:/)}`,
      );
    const { files } = JSON.parse(readFileSync(report, "utf8")) as {
      files?: unknown;
    };
    if (typeof files !== "object" || files === null)
      throw formatChanged("stryker", "wrote a report without files");
    const inScope = scopedFile(ctx);
    const findings: Finding[] = [];
    for (const [path, entry] of Object.entries(
      files as Record<string, { source?: unknown; mutants?: unknown }>,
    )) {
      const file = inScope(path);
      if (!file) continue;
      const { source, mutants } = entry;
      if (!Array.isArray(mutants) || typeof source !== "string")
        throw formatChanged(
          "stryker",
          `reported ${path} without its source or mutants`,
        );
      // Where each line starts, to slice out the code a mutant replaced.
      const starts = [0];
      for (const line of source.split("\n"))
        starts.push((starts.at(-1) ?? 0) + line.length + 1);
      const offset = (p: { line: number; column: number }): number =>
        (starts[p.line - 1] ?? source.length) + p.column - 1;
      const language = languageForFile(file);
      for (const m of mutants as StrykerMutant[]) {
        const kind = KINDS.get(m.status);
        if (!kind) continue;
        const start = position(m.location?.start);
        const end = position(m.location?.end);
        if (
          !start ||
          !end ||
          typeof m.replacement !== "string" ||
          typeof m.mutatorName !== "string"
        )
          throw formatChanged(
            "stryker",
            "reported a mutant without a location, replacement or mutator",
          );
        findings.push(
          mutantFinding({
            tool: "stryker",
            ...(language ? { language } : {}),
            file,
            line: start.line,
            col: start.column,
            endLine: end.line,
            endCol: end.column,
            kind,
            mutation: `${excerpt(source.slice(offset(start), offset(end)))} → ${excerpt(m.replacement)} (${m.mutatorName})`,
          }),
        );
      }
    }
    return mutationResult(raw, ctx, findings);
  },
};
