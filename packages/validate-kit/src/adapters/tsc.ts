import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import pLimit from "p-limit";
import { run } from "../core/exec.js";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, clampSeverity, finding } from "./base.js";

const LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
const GLOBAL_RE = /^(error|warning) (TS\d+): (.+)$/;
const TSCONFIG = /^tsconfig(\.[^/]+)?\.json$/;

interface TscTask {
  /** The project's config, absolute. */
  project: string;
  /**
   * Files this project type-checks that another project owns, absolute: their
   * findings are that project's (it runs them with their own options).
   */
  skip?: string[];
  /**
   * The run's root, when the project's folder is above it: its findings in
   * files outside the run that a nearer `tsconfig*.json` covers are left out.
   */
  root?: string;
}

/** What one candidate config type-checks, as tsc listed it. */
interface Candidate {
  config: string;
  dir: string;
  /** Undefined when tsc reported a problem with the config instead. */
  files: Set<string> | undefined;
  /** Why tsc could not list them at all (it crashed, timed out, is missing). */
  failed?: string;
}

/**
 * `text` without what JSONC allows and JSON does not: with `drop` "comment",
 * comments; with "comma", a comma before `}` or `]`. Strings are kept as they
 * are, commas and braces in them included.
 */
function outsideStrings(text: string, drop: "comment" | "comma"): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (drop === "comment" && c === "/" && text[i + 1] === "/") {
      // TypeScript ends a line comment at any line break, a lone CR and
      // U+2028/U+2029 included.
      while (i < text.length && !/[\n\r\u2028\u2029]/.test(text[i] ?? ""))
        i += 1;
      out += "\n";
    } else if (drop === "comment" && c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 1;
    } else if (drop === "comma" && c === ",") {
      let next = i + 1;
      while (/\s/.test(text[next] ?? "")) next += 1;
      if (text[next] !== "}" && text[next] !== "]") out += c;
    } else out += c;
  }
  return out;
}

/**
 * A tsconfig's object: comments, trailing commas and a BOM are allowed
 * (JSONC, as TypeScript reads it); undefined when it cannot be read.
 */
function readJsonc(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      outsideStrings(outsideStrings(text, "comment"), "comma"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function real(path: string): string {
  try {
    return toPosix(realpathSync(path));
  } catch {
    return path;
  }
}

/** `abs`, or `abs.json` when only that exists (how `extends` names a file). */
function withJson(abs: string): string {
  return abs.endsWith(".json") || !existsSync(`${abs}.json`)
    ? abs
    : `${abs}.json`;
}

/**
 * The configs a tsconfig extends, by real path: relative ones, and package
 * ones found through `node_modules` (a workspace link leads back into the
 * repository).
 */
function extendsOf(path: string, json: Record<string, unknown>): string[] {
  const raw = json["extends"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.flatMap((ext) => {
    if (typeof ext !== "string") return [];
    // `path` is POSIX-spelled, but on Windows its drive letter is not a
    // POSIX-absolute path: posix.resolve() would prepend the cwd to it and
    // never find the file (a tsconfig.base.json then ran as a project).
    if (ext.startsWith(".") || isAbsolute(ext))
      return [real(withJson(absPosix(posix.dirname(path), ext)))];
    for (let at = posix.dirname(path); ; at = posix.dirname(at)) {
      const abs = withJson(posix.join(at, "node_modules", ext));
      if (existsSync(abs)) return [real(abs)];
      if (posix.dirname(at) === at) return [];
    }
  });
}

/**
 * The work tree's top as git sees it, when it is `root` or above it; `root`
 * itself outside a repository. A folder named `.git` alone proves nothing (an
 * empty or broken one above a project is not a repository).
 */
async function repositoryTop(root: string): Promise<string> {
  const raw = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    timeoutMs: 15_000,
  });
  const top = raw.exitCode === 0 ? real(toPosix(raw.stdout.trim())) : "";
  const realRoot = real(root);
  if (top === "" || !(realRoot === top || realRoot.startsWith(`${top}/`)))
    return root;
  // In the root's own spelling (a symlinked root), which the files share.
  const below = posix.relative(top, realRoot);
  if (below === "") return root;
  return root.endsWith(`/${below}`) ? root.slice(0, -(below.length + 1)) : root;
}

/**
 * Every `tsconfig*.json` that could cover a scoped TypeScript file: those in
 * scope, and those in each folder above such a file up to `top`, read from
 * disk (a narrowed `include` or a run on a sub-folder does not hide the
 * project that owns the files).
 */
function candidateConfigs(
  scopedFiles: readonly string[],
  tsFiles: readonly string[],
  top: string,
): string[] {
  const found = new Set(
    scopedFiles.filter((file) => TSCONFIG.test(posix.basename(file))),
  );
  const seen = new Set<string>();
  for (const file of tsFiles) {
    for (
      let dir = posix.dirname(file);
      !seen.has(dir) && (dir === top || dir.startsWith(`${top}/`));
      dir = posix.dirname(dir)
    ) {
      seen.add(dir);
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        // unreadable: nothing found here
      }
      for (const name of names)
        if (TSCONFIG.test(name)) found.add(posix.join(dir, name));
      if (dir === top || posix.dirname(dir) === dir) break;
    }
  }
  // Folder order, like every tool's tasks (G1.1b): a root before its
  // packages.
  return [...found].toSorted((a, b) => {
    const [da, db] = [posix.dirname(a), posix.dirname(b)];
    return da === db ? (a < b ? -1 : 1) : da < db ? -1 : 1;
  });
}

/**
 * Not a project: a `tsconfig.*.json` that another config extends and that has
 * no `include`, `files` or `references` of its own. A `tsconfig.json` is
 * always its folder's project (a NestJS `tsconfig.build.json` extends it).
 */
function basesOf(configs: readonly string[]): Set<string> {
  const read = configs.map((config) => ({ config, json: readJsonc(config) }));
  const extended = new Set(
    read.flatMap(({ config, json }) => (json ? extendsOf(config, json) : [])),
  );
  return new Set(
    read
      .filter(
        ({ config, json }) =>
          posix.basename(config) !== "tsconfig.json" &&
          json !== undefined &&
          !["include", "files", "references"].some((key) => key in json) &&
          extended.has(real(config)),
      )
      .map(({ config }) => config),
  );
}

/**
 * What `config` type-checks, as tsc lists it: an empty set when it has no
 * inputs (TS18003); no set when tsc reports a problem with the config (the
 * project then runs and reports it: noisy, never silent); `failed` when tsc
 * could not answer at all.
 */
async function listingOf(
  config: string,
  root: string,
  timeoutMs: number,
  bin: string | undefined,
): Promise<Omit<Candidate, "config" | "dir">> {
  // The tsc that will check the project lists it: tools.tsc.bin's, if set.
  const raw = await run(bin ?? "tsc", ["-p", config, "--listFilesOnly"], {
    cwd: posix.dirname(config),
    timeoutMs,
    ...(bin === undefined ? {} : { pathOnly: true }),
  });
  const text = `${raw.stdout}${raw.stderr}`;
  if (text.includes("TS18003")) return { files: new Set() };
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnError)
    return {
      files: new Set(
        raw.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((file) => toPosix(file)),
      ),
    };
  // A problem with the config, said in tsc's own words: the project runs and
  // reports it. An exit with nothing said establishes no coverage.
  if (
    (raw.exitCode === 1 || raw.exitCode === 2) &&
    !raw.timedOut &&
    /\berror TS\d+/.test(text)
  )
    return { files: undefined };
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return {
    files: undefined,
    failed: `${posix.relative(root, config) || config}: tsc could not list the files it checks (${raw.timedOut ? `timed out after ${timeoutMs} ms` : raw.spawnError ? "not found" : `exit ${raw.exitCode}`}${first ? `: ${first}` : ""}), so the run cannot say what it covers.`,
  };
}

/**
 * The configs that own `file`, among those that check it: every one in the
 * nearest folder above it (peers in one folder are real projects, perhaps
 * with stricter options); failing that, every other (a file reached by
 * import or a `../` include). A config further up leaves it to them.
 */
function ownersOf(file: string, candidates: readonly Candidate[]): string[] {
  const covering = candidates.filter((candidate) => candidate.files?.has(file));
  const above = covering.filter(({ dir }) => file.startsWith(`${dir}/`));
  if (above.length === 0) return covering.map(({ config }) => config);
  const nearest = Math.max(...above.map(({ dir }) => dir.length));
  return above
    .filter(({ dir }) => dir.length === nearest)
    .map(({ config }) => config);
}

/**
 * Whether a `tsconfig*.json` sits between a file and the project folder `dir`
 * (the file's own folder included), read from disk once per folder.
 */
function nearerConfigs(dir: string): (file: string) => boolean {
  const known = new Map<string, boolean>();
  const hasConfig = (folder: string): boolean => {
    let found = known.get(folder);
    if (found === undefined) {
      try {
        found = readdirSync(folder).some((name) => TSCONFIG.test(name));
      } catch {
        found = false;
      }
      known.set(folder, found);
    }
    return found;
  };
  return (file) => {
    for (
      let folder = posix.dirname(file);
      folder.startsWith(`${dir}/`);
      folder = posix.dirname(folder)
    )
      if (hasConfig(folder)) return true;
    return false;
  };
}

/**
 * The dependencies a project's package.json declares that do not resolve
 * from its directory: type-checking it would report every import of them.
 */
function missingDependencies(projectDir: string, root: string): string[] {
  let manifest: string | undefined;
  for (let at = projectDir; ; at = posix.dirname(at)) {
    if (existsSync(posix.join(at, "package.json"))) {
      manifest = posix.join(at, "package.json");
      break;
    }
    if (at === root || posix.dirname(at) === at) break;
  }
  if (!manifest) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const names = ["dependencies", "devDependencies"].flatMap((key) =>
    Object.keys((pkg[key] as Record<string, string> | undefined) ?? {}),
  );
  const resolvable = (name: string): boolean => {
    for (let at = projectDir; ; at = posix.dirname(at)) {
      if (existsSync(posix.join(at, "node_modules", name))) return true;
      if (posix.dirname(at) === at) return false;
    }
  };
  return names.filter((name) => !resolvable(name)).toSorted();
}

/** One task for `project`, or one that cannot run while its dependencies are missing. */
function projectTask(
  seed: TaskSeed,
  project: string,
  root: string,
  skip: string[] = [],
  failed?: string,
): TaskSeed {
  const dir = posix.dirname(project);
  const missing = missingDependencies(dir, root);
  const task: TscTask = {
    project,
    ...(skip.length > 0 ? { skip } : {}),
    ...(root.startsWith(`${dir}/`) ? { root } : {}),
  };
  if (failed !== undefined)
    return { ...seed, cwd: dir, options: task, cannotRun: failed };
  return {
    ...seed,
    cwd: dir,
    options: task,
    ...(missing.length > 0
      ? {
          cannotRun: `${posix.relative(root, project) || project}: ${missing.length} declared dependenc${missing.length === 1 ? "y is" : "ies are"} not installed (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); type-checking it would only report unresolved imports. Install them first.`,
        }
      : {}),
  };
}

/** tsc — TypeScript type checker, once per project (a `tsconfig*.json`). */
export const tsc: ToolAdapter = {
  id: "tsc",
  layer: "type-check",
  languages: ["ts"],
  bin: "tsc",
  // A syntax error (TS1xxx) anywhere stops tsc reporting type errors.
  masks: (f) => /^TS1\d{3}$/.test(f.ruleId ?? ""),
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  runsAt: "project-root",
  minVersion: "5.0.0",
  installHint: "pnpm add -D typescript",
  versionArgs: ["--version"],
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  configFor: (_finding, ctx) => (ctx.options as TscTask | undefined)?.project,

  async expand(seed: TaskSeed, env: PlanEnv): Promise<TaskSeed[]> {
    const root = toPosix(env.projectRoot);
    const configured = env.toolConfig.configPath;
    if (configured) return [projectTask(seed, configured, root)];

    const tsFiles = env.scopedFiles.filter(
      (file) => languageForFile(file) === "ts",
    );
    const configs = candidateConfigs(
      env.scopedFiles,
      tsFiles,
      await repositoryTop(root),
    );
    const bases = basesOf(configs);
    // Each listing parses its whole program: as many at once as the run
    // allows tools.
    const limit = pLimit(Math.max(1, env.config.concurrency));
    const timeoutMs = env.toolConfig.timeoutMs ?? 120_000;
    const candidates: Candidate[] = await Promise.all(
      configs
        .filter((config) => !bases.has(config))
        .map((config) =>
          limit(async () => ({
            config,
            dir: posix.dirname(config),
            ...(await listingOf(config, root, timeoutMs, env.toolConfig.bin)),
          })),
        ),
    );
    const owners = new Map<string, Set<string>>();
    const owning = new Set<string>();
    for (const file of tsFiles) {
      const mine = ownersOf(file, candidates);
      if (mine.length === 0) continue;
      owners.set(file, new Set(mine));
      for (const config of mine) owning.add(config);
    }
    // A changed-file run: the projects that own files and list a change
    // (they may import it); all of them when TypeScript was deleted, which no
    // list holds. Only changed files can be checked by no project.
    const changed = env.changedPaths
      ? [...new Set(env.changedPaths.map((path) => posix.join(root, path)))]
      : undefined;
    const deleted = changed?.some(
      (file) => languageForFile(file) === "ts" && !existsSync(file),
    );
    const runs = (candidate: Candidate): boolean =>
      candidate.files === undefined ||
      (owning.has(candidate.config) &&
        (!changed ||
          deleted === true ||
          changed.some((file) => candidate.files?.has(file))));
    const tasks = candidates.filter(runs).map(({ config, files, failed }) =>
      projectTask(
        seed,
        config,
        root,
        [...(files ?? [])].filter((file) => {
          const own = owners.get(file);
          return own !== undefined && !own.has(config);
        }),
        failed,
      ),
    );
    // A config tsc could not list may own the files in its folder.
    const unknownDirs = candidates
      .filter((candidate) => !candidate.files)
      .map(({ dir }) => dir);
    const orphans = tsFiles.filter(
      (file) =>
        !owners.has(file) &&
        (!changed || changed.includes(file)) &&
        !unknownDirs.some((dir) => file.startsWith(`${dir}/`)) &&
        // The kit's own config: the kit loads it, no project needs to (DV1).
        file !== env.configFile,
    );
    // First: its folder is the project root, which sorts first (G1.1b).
    if (orphans.length > 0) {
      tasks.unshift({
        ...seed,
        cannotRun: `${orphans.length} TypeScript file(s) are in no tsconfig project, so tsc cannot check them (${orphans
          .slice(0, 3)
          .map((file) => posix.relative(root, file))
          .join(
            ", ",
          )}${orphans.length > 3 ? ", …" : ""}). Add them to a tsconfig.json's include.`,
      });
    }
    return tasks;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as TscTask;
    const args = ["--noEmit", "--pretty", "false", "-p", task.project];
    args.push(...ctx.extraArgs);
    return { bin: this.bin, args, okExitCodes: [0, 1, 2] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    // Errors inside dependencies (a .d.ts this TypeScript cannot read, or
    // one that fails under skipLibCheck: false) become one error, not a flood.
    let inDependencies = 0;
    let firstInDependencies = "";
    const task = ctx.options as TscTask | undefined;
    const skip = new Set(task?.skip);
    const cwd = toPosix(ctx.cwd);
    // Every diagnostic line read, kept or left to another project: only a
    // failure that printed none of them is reported as such.
    let parsed = 0;
    const nearer = nearerConfigs(cwd);
    const text = `${raw.stdout}\n${raw.stderr}`;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const located = LINE_RE.exec(trimmed);
      if (located) {
        const [, file, ln, col, level, code, message] = located;
        if (!file || !ln || !col) continue;
        parsed += 1;
        const abs = absPosix(ctx.cwd, file);
        // Relative to the project: one that sits under node_modules keeps its
        // own errors.
        if (posix.relative(cwd, abs).split("/").includes("node_modules")) {
          inDependencies += 1;
          firstInDependencies ||= trimmed;
          continue;
        }
        if (skip.has(abs)) continue;
        // Outside the run, where a nearer project covers the file: its own
        // project would report it, with its own options.
        if (task?.root && !abs.startsWith(`${task.root}/`) && nearer(abs))
          continue;
        findings.push(
          finding({
            tool: "tsc",
            layer: "type-check",
            language: "ts",
            file: abs,
            line: Number(ln),
            col: Number(col),
            ...(code ? { ruleId: code } : {}),
            severity: clampSeverity(level),
            message: message ?? "Type error",
            fixable: false,
          }),
        );
        continue;
      }

      const global = GLOBAL_RE.exec(trimmed);
      if (!global) continue;
      parsed += 1;
      const [, level, code, message] = global;
      findings.push(
        finding({
          tool: "tsc",
          layer: "type-check",
          language: "ts",
          file: absPosix(ctx.cwd, "."),
          line: 1,
          col: 1,
          ...(code ? { ruleId: code } : {}),
          severity: clampSeverity(level),
          message: message ?? "Type error",
          fixable: false,
        }),
      );
    }
    if (inDependencies > 0) {
      findings.push(
        finding({
          tool: "tsc",
          layer: "type-check",
          language: "ts",
          file: task?.project ?? absPosix(ctx.cwd, "."),
          line: 1,
          col: 1,
          ruleId: "dependency-types",
          severity: "error",
          message: `${inDependencies} diagnostic(s) inside node_modules, first: ${firstInDependencies}. A dependency's type definitions fail under this TypeScript and these settings: upgrade typescript (a newer syntax), or the dependency.`,
          fixable: false,
        }),
      );
    }
    if (parsed === 0 && raw.exitCode !== 0) {
      const firstLine = text
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      findings.push(
        finding({
          tool: "tsc",
          layer: "type-check",
          language: "ts",
          file: absPosix(ctx.cwd, "."),
          line: 1,
          col: 1,
          severity: "error",
          message: firstLine ?? "tsc failed without parseable diagnostics",
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
