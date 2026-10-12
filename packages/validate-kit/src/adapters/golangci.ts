import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { run } from "../core/exec.js";
import { gitDirOf } from "../detect/git.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, clampSeverity, finding, parseFindings } from "./base.js";
import { changedPackages, PACKAGE_CAP } from "../detect/go-packages.js";

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  Pos: { Filename: string; Line: number; Column: number };
  Replacement?: unknown;
}

/** What expand attaches to a task: its cache folder, and whether to leave the workspace. */
interface GolangciTask {
  cache: string;
  /** The module is not in the go.work that covers it: run with GOWORK=off. */
  outsideWorkspace?: true;
  /** A changed-file run's packages (go-packages.ts); absent: `./...`. */
  patterns?: string[];
  /** Importers left out above the cap. */
  skipped?: number;
  /** For a narrowed run: the config `./...` would read, or none (false). */
  found?: string | false;
}

/** A path as Go compares it: case-blind on Windows. */
function spelled(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

const workspaces = new Map<string, Promise<Set<string> | undefined>>();

/**
 * The folders a go.work lists (`go work edit -json`), resolved from its own
 * folder, which `go env GOWORK` already gives as a real path; undefined when
 * Go cannot read it. Remembered while the file is unchanged (its mtime and
 * size), and never a failure: the MCP server runs many checks in one process.
 */
function workspaceModules(file: string): Promise<Set<string> | undefined> {
  let stamp: string;
  try {
    const { mtimeMs, size } = statSync(file);
    stamp = `${file}\0${mtimeMs}\0${size}`;
  } catch {
    return Promise.resolve(undefined);
  }
  let modules = workspaces.get(stamp);
  if (!modules) {
    modules = run("go", ["work", "edit", "-json", file], {
      cwd: dirname(file),
      timeoutMs: 15_000,
    }).then((raw) => {
      if (raw.exitCode !== 0) return undefined;
      const uses =
        (JSON.parse(raw.stdout) as { Use?: { DiskPath: string }[] }).Use ?? [];
      // Not real paths: Go refuses a module reached only through a
      // symlinked `use` entry.
      return new Set(
        uses.map(({ DiskPath }) => spelled(resolve(dirname(file), DiskPath))),
      );
    });
    const kept = modules;
    workspaces.set(stamp, kept);
    void kept.then(
      (set) => {
        if (set === undefined) workspaces.delete(stamp);
      },
      () => workspaces.delete(stamp),
    );
  }
  return modules;
}

/**
 * A module a go.work above it does not list: Go refuses `./...` there
 * ("directory prefix . does not contain modules listed in go.work"), so
 * golangci-lint runs it with GOWORK=off. A module the workspace lists keeps
 * it (its sibling modules resolve through it), and so does every module when
 * Go cannot read the go.work: its own error then stops the run. Found on
 * dark-visitor, whose root go.work lists only ./backend.
 */
export async function outsideWorkspace(moduleDir: string): Promise<boolean> {
  const raw = await run("go", ["env", "GOWORK"], {
    cwd: moduleDir,
    timeoutMs: 15_000,
  });
  const file = raw.exitCode === 0 ? raw.stdout.trim() : "";
  if (file === "" || file === "off") return false;
  try {
    const listed = await workspaceModules(file);
    return (
      listed !== undefined && !listed.has(spelled(realpathSync(moduleDir)))
    );
  } catch {
    return false;
  }
}

/** Go's os.UserCacheDir, where golangci-lint keeps its own cache. */
function userCacheDir(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Caches");
  if (process.platform === "win32")
    return process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  return process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache");
}

const caches = new Map<string, Promise<string>>();

/**
 * A cache per checkout and place: golangci-lint's shared one is keyed by
 * package content and returns issues at the paths it first saw them, so a
 * clone got another checkout's paths (DV7), and a checkout moved or mounted
 * elsewhere got its old ones. It lives in the checkout's git folder, so it
 * goes with the clone, under the checkout's path; outside a repository, in
 * the user's cache.
 */
function cacheFor(projectRoot: string): Promise<string> {
  let cache = caches.get(projectRoot);
  if (!cache) {
    const place = createHash("sha256")
      .update(projectRoot)
      .digest("hex")
      .slice(0, 16);
    cache = gitDirOf(projectRoot).then((gitDir) =>
      gitDir
        ? join(gitDir, "validate-kit", "golangci-lint", place)
        : join(userCacheDir(), "validate-kit", "golangci-lint", place),
    );
    caches.set(projectRoot, cache);
  }
  return cache;
}

/**
 * Each file golangci-lint named, spelled as the module is (the task's cwd),
 * or undefined for one outside the module or that does not exist. The path
 * as printed is checked first; only one outside the module is compared by
 * real folder: golangci-lint prints real paths (/private/var for /var on
 * macOS, a symlinked workspace's target), which a baseline keyed by the
 * project's own spelling would not match, and a file symlinked into the
 * module stays the module's.
 */
function inModule(
  files: readonly string[],
  cwd: string,
): (string | undefined)[] {
  const module = `${toPosix(cwd)}/`;
  const realModule = `${toPosix(realpathSync(cwd))}/`;
  const realDirs = new Map<string, string | undefined>();
  const realDir = (dir: string): string | undefined => {
    if (!realDirs.has(dir)) {
      let real: string | undefined;
      try {
        real = `${toPosix(realpathSync(dir))}/`;
      } catch {
        real = undefined;
      }
      realDirs.set(dir, real);
    }
    return realDirs.get(dir);
  };
  return files.map((file) => {
    if (!existsSync(file)) return undefined;
    if (file.startsWith(module)) return file;
    const real = `${realDir(dirname(file)) ?? ""}${basename(file)}`;
    return real.startsWith(realModule)
      ? module + real.slice(realModule.length)
      : undefined;
  });
}

/** golangci-lint v2 — Go meta-linter. Module-scoped. */
export const golangci: ToolAdapter = {
  id: "golangci-lint",
  layer: "lint",
  languages: ["go"],
  bin: "golangci-lint",
  supportsFix: true,
  fixWriteBack: true,
  fileScoped: false,
  rootedAtMarker: true,
  // --path-mode=abs arrived in 2.1.0 (CHANGELOG.md, v2.1.0).
  minVersion: "2.1.0",
  installHint: "brew install golangci-lint",
  parseVersion: (out) =>
    /version v?(\d+\.\d+\.\d+)/.exec(out)?.[1] ??
    /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  // Exit 1: findings reported (recorded on the installed version).
  findingExitCodes: [1],
  // A package that does not type-check is not linted past that.
  masks: (f) => f.ruleId === "typecheck",

  async expand(seed, env) {
    const outside = await outsideWorkspace(seed.cwd);
    // Build tags decide which packages exist, and a config named outside the
    // kit's settings may set them: the whole module then.
    const opaque =
      (env.toolConfig.extraArgs ?? []).some((arg) =>
        /^(?:--build-tags|--config|-c|--no-config)(?:=|$)/.test(arg),
      ) || /(?:^|\s)-tags[=\s]/.test(process.env["GOFLAGS"] ?? "");
    // A changed-file run lints the packages the change reaches, not the
    // whole module (docs/research/lint-toolchain/golangci-changed-packages.md).
    let reach =
      env.changedPaths && !opaque
        ? await changedPackages(seed.cwd, env.projectRoot, env.changedPaths, {
            ...(env.toolConfig.configPath
              ? { configPath: env.toolConfig.configPath }
              : {}),
            ...(outside ? { env: { GOWORK: "off" } } : {}),
          })
        : {};
    if (reach === undefined) return [];
    // golangci-lint looks for its config from the first pattern's folder
    // upward, `./...` from the module's: name the one `./...` would read.
    let found: string | false | undefined;
    if (reach.patterns && !env.toolConfig.configPath) {
      const bin = env.toolConfig.bin ?? "golangci-lint";
      const raw = await run(bin, ["config", "path"], {
        cwd: seed.cwd,
        timeoutMs: 30_000,
        ...(env.toolConfig.bin ? { pathOnly: true } : {}),
      });
      // It prints the path on stderr (2.12.2).
      const printed =
        (raw.stdout.trim() || raw.stderr.trim()).split("\n").at(-1) ?? "";
      found =
        !raw.spawnError && raw.exitCode === 0 && printed !== ""
          ? resolve(seed.cwd, printed)
          : false;
    }
    const config =
      env.toolConfig.configPath ?? (typeof found === "string" ? found : "");
    if (
      reach.patterns &&
      config !== "" &&
      existsSync(config) &&
      /\bbuild-tags\b/.test(readFileSync(config, "utf8"))
    ) {
      reach = {};
      found = undefined;
    }
    return [
      {
        ...seed,
        options: {
          cache: await cacheFor(env.projectRoot),
          ...(outside ? { outsideWorkspace: true as const } : {}),
          ...(reach.patterns ? { patterns: reach.patterns } : {}),
          ...(reach.skipped ? { skipped: reach.skipped } : {}),
          ...(found !== undefined ? { found } : {}),
        } satisfies GolangciTask,
      },
    ];
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as GolangciTask | undefined;
    const args = [
      "run",
      // Another session's golangci-lint holds a lock: wait for it, not crash
      // ("parallel golangci-lint is running").
      "--allow-serial-runners",
      "--output.json.path",
      "stdout",
      // Every issue: the default caps (50 per linter, 3 per text, one per
      // line) cut what a baseline counts, differently as code moves (DV5).
      "--max-issues-per-linter=0",
      "--max-same-issues=0",
      "--uniq-by-line=false",
      // Relative paths are relative to the config's folder, which a nested
      // module may inherit from above it (DV6).
      "--path-mode=abs",
    ];
    if (ctx.configPath) args.push("--config", ctx.configPath);
    else if (typeof task?.found === "string") args.push("--config", task.found);
    else if (task?.found === false) args.push("--no-config");
    if (ctx.fix) args.push("--fix");
    args.push(...ctx.extraArgs, ...(task?.patterns ?? ["./..."]));
    // Only 0 (clean) and 1 (issues found) are ok. golangci's other codes are
    // failures (3 failure, 4 timeout, 5 no go files, 7 error) that can still
    // print an empty-Issues JSON — accepting them parsed as a clean run.
    return {
      bin: this.bin,
      args,
      okExitCodes: [0, 1],
      env: {
        // A cache the caller set is kept.
        ...(task && !process.env["GOLANGCI_LINT_CACHE"]
          ? { GOLANGCI_LINT_CACHE: task.cache }
          : {}),
        ...(task?.outsideWorkspace ? { GOWORK: "off" } : {}),
      },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // JSON may be single-line (v2 default) or pretty-printed, and is wrapped
    // in human noise (progress lines before, "N issues." after). Take the
    // first "{" through the last "}" instead of assuming one line.
    const jsonStart = raw.stdout.indexOf("{");
    const jsonEnd = raw.stdout.lastIndexOf("}");
    // No closing brace = truncated/garbage JSON — pass it through so the
    // parser throws "invalid JSON" (distinct from "no JSON at all").
    const stdoutJson =
      jsonStart === -1
        ? undefined
        : raw.stdout.slice(
            jsonStart,
            jsonEnd > jsonStart ? jsonEnd + 1 : raw.stdout.length,
          );
    if (!stdoutJson && raw.exitCode !== 0) {
      const firstLine = `${raw.stdout}\n${raw.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      throw new Error(
        `golangci-lint failed without JSON output${firstLine ? `: ${firstLine}` : ""}`,
      );
    }
    const { items: issues } = parseFindings<GolangciIssue>(
      "golangci-lint",
      { ...raw, stdout: stdoutJson ?? "" },
      "Issues",
    );
    // An issue in no file of this module: another checkout's, from a cache
    // shared with it (DV7). Reporting it would be a finding no fix can clear.
    const placed = inModule(
      issues.map((i) => absPosix(ctx.cwd, i.Pos.Filename)),
      ctx.cwd,
    );
    const outside = issues.filter((_, n) => placed[n] === undefined);
    if (outside.length > 0) {
      const cache = (ctx.options as GolangciTask | undefined)?.cache;
      throw new Error(
        `golangci-lint reported ${outside.length} issue(s) at files outside the module it checked, or that do not exist (first: ${outside[0]?.Pos.Filename}): its cache${cache && !process.env["GOLANGCI_LINT_CACHE"] ? ` (${cache})` : " (GOLANGCI_LINT_CACHE)"} holds results from another place; delete it and run again.`,
      );
    }
    const findings = issues.map((i, n) =>
      finding({
        tool: "golangci-lint",
        layer: "lint",
        language: "go",
        file: placed[n] ?? absPosix(ctx.cwd, i.Pos.Filename),
        line: i.Pos.Line,
        col: i.Pos.Column,
        ruleId: i.FromLinter,
        severity: clampSeverity(i.Severity || "warning"),
        message: i.Text,
        fixable: i.Replacement !== null && i.Replacement !== undefined,
      }),
    );
    const task = ctx.options as GolangciTask | undefined;
    if (task?.skipped)
      findings.push(
        finding({
          tool: "golangci-lint",
          layer: "lint",
          language: "go",
          file: absPosix(ctx.cwd, "go.mod"),
          line: 1,
          col: 1,
          ruleId: "importers-not-linted",
          severity: "info",
          message: `${task.skipped} package(s) import the changed ones and were not linted (more than ${PACKAGE_CAP}); the full run checks them.`,
          fixable: false,
        }),
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
