import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { absPosix, finding, parseJsonLine } from "./base.js";
import { relativeFiles } from "./schemas-iac.js";

/** One line of `--error-format=json` (schemas-iac.md, 1). */
interface BufAnnotation {
  path?: unknown;
  start_line?: unknown;
  start_column?: unknown;
  end_line?: unknown;
  end_column?: unknown;
  type?: unknown;
  message?: unknown;
}

/** buf's own config names: a v2 `buf.yaml`, or a v1 `buf.work.yaml`. */
export const BUF_CONFIGS = ["buf.yaml", "buf.work.yaml"];

export const bufAdopted = (root: string, projectRoot: string): boolean =>
  toolAdopted(root, projectRoot, { configs: BUF_CONFIGS });

/** buf's `Failure:` when every `--path` given is outside its modules. */
export const NONE_TARGETED = "Failure: no .proto files were targeted";

/** `--path` for each of the task's files, relative to where buf runs. */
export function bufPaths(ctx: ToolContext): string[] {
  return relativeFiles(ctx).flatMap((file) => ["--path", file]);
}

/** The buf config in `dir`, absolute: what a finding with no file is at. */
export function bufConfigIn(dir: string): string {
  return absPosix(
    dir,
    BUF_CONFIGS.find((name) => existsSync(join(dir, name))) ?? "buf.yaml",
  );
}

/**
 * buf's JSON lines as findings (lint and breaking print the same shape, at
 * paths relative to where it runs). An annotation about a whole file (a
 * deleted file, FILE_NO_DELETE) has no path: it is at the buf config, and
 * its message names the file. A line of another shape throws: buf's output
 * changed.
 */
export function bufFindings(
  tool: string,
  raw: RawOutput,
  ctx: ToolContext,
): Finding[] {
  return raw.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const a = parseJsonLine<BufAnnotation>(tool, line.trim());
      if (
        (a.path !== undefined && typeof a.path !== "string") ||
        typeof a.start_line !== "number" ||
        typeof a.start_column !== "number" ||
        typeof a.type !== "string" ||
        typeof a.message !== "string"
      )
        throw new Error(
          `${tool} printed an annotation without a 1-based position, type or message: its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool,
        layer: "lint",
        language: "proto",
        file:
          typeof a.path === "string"
            ? absPosix(ctx.cwd, a.path)
            : bufConfigIn(ctx.cwd),
        line: a.start_line,
        col: a.start_column,
        ...(typeof a.end_line === "number" && typeof a.end_column === "number"
          ? { endLine: a.end_line, endCol: a.end_column }
          : {}),
        ruleId: a.type,
        // buf has no severity: every rule it runs fails it.
        severity: "error",
        message: a.message,
        fixable: false,
      });
    });
}

/** buf's module cache: `$BUF_CACHE_DIR`, else `$XDG_CACHE_HOME/buf`, else `~/.cache/buf` (macOS too). */
function bufCache(): string {
  const env = process.env;
  if (env["BUF_CACHE_DIR"]) return env["BUF_CACHE_DIR"];
  if (env["XDG_CACHE_HOME"]) return join(env["XDG_CACHE_HOME"], "buf");
  if (process.platform === "win32" && env["LOCALAPPDATA"])
    return join(env["LOCALAPPDATA"], "buf");
  return join(homedir(), ".cache", "buf");
}

/** A buf.lock dependency: v2's `name`, or v1's remote, owner and repository. */
interface LockedDep {
  name?: unknown;
  remote?: unknown;
  owner?: unknown;
  repository?: unknown;
  commit?: unknown;
}

const read = (path: string): unknown => {
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Why buf cannot lint the module in `dir` offline, if it cannot: buf
 * fetches the `deps` of buf.yaml from the BSR when they are not in its
 * cache (exit 1 with no network, a 380 KB download with one), and with no
 * buf.lock it reports every import of them as missing.
 */
export function depsMissing(dir: string): string | undefined {
  const config = read(join(dir, "buf.yaml")) as { deps?: unknown } | undefined;
  const declared = Array.isArray(config?.deps) ? config.deps : [];
  const lock = read(join(dir, "buf.lock")) as { deps?: unknown } | undefined;
  const locked = (Array.isArray(lock?.deps) ? lock.deps : []) as LockedDep[];
  if (declared.length > 0 && locked.length === 0)
    return "buf.yaml has deps but no buf.lock lists them: run `buf dep update`, then commit buf.lock";
  // <cache>/v3/modules/<digest type>/<remote>/<owner>/<name>/<commit>
  const modules = join(bufCache(), "v3", "modules");
  const digests = existsSync(modules) ? readdirSync(modules) : [];
  const missing = locked.filter((dep) => {
    const name =
      typeof dep.name === "string"
        ? dep.name
        : [dep.remote, dep.owner, dep.repository].join("/");
    const commit = typeof dep.commit === "string" ? dep.commit : "";
    return !digests.some((digest) =>
      existsSync(join(modules, digest, name, commit, "files")),
    );
  });
  return missing.length === 0
    ? undefined
    : `buf.lock's deps are not in buf's cache (${bufCache()}), and the kit does not let buf fetch them in a check: run \`buf dep update\` once with the network`;
}

/**
 * buf lint — Protobuf style and API rules (naming, packages, enum zero
 * values, comments) as the project's `buf.yaml` selects them. Runs from the
 * folder of each `buf.yaml` (the proto marker), where the repository chose
 * buf: a `buf.yaml` (v2) or `buf.work.yaml` (v1) at or above it, or
 * `tools.buf.enabled`. Only the task's files (`--path`). Never the network:
 * a module whose `deps` are not in buf's cache is not run, with the reason
 * (`buf dep update`). Recorded on 1.73.0:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 1.
 */
export const buf: ToolAdapter = {
  id: "buf",
  layer: "lint",
  languages: ["proto"],
  bin: "buf",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.73.0",
  installHint: "brew install buf",
  adoptedAt: bufAdopted,
  // 100: findings; 1: a failure (bad flag, bad config), message on stderr.
  findingExitCodes: [100],

  expand(seed: TaskSeed): TaskSeed[] {
    const cannotRun = depsMissing(seed.cwd);
    return [cannotRun ? { ...seed, cannotRun } : seed];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(error-format|path)(=|$)/.test(arg))
      ? "the kit reads buf's JSON lines and passes the files itself"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "lint",
        "--error-format=json",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...bufPaths(ctx),
      ],
      okExitCodes: [0, 1, 100],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 1) {
      // Every file given is outside the modules buf.yaml declares (or one it
      // excludes): buf lints none of them, by the project's choice.
      if (!raw.stderr.trimStart().startsWith(NONE_TARGETED))
        throw new Error(
          `buf lint failed: ${raw.stderr.trim().split("\n")[0] ?? "no message"}`,
        );
      return {
        findings: [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: 0,
        stderr: raw.stderr,
      };
    }
    return {
      findings: bufFindings("buf", raw, ctx),
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
