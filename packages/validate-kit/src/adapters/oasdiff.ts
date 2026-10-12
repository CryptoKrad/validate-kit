import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveBin } from "../core/exec.js";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding, parseFindings } from "./base.js";

/** One spec to diff against its copy at the base ref. */
interface ApiDiffTask {
  spec: string;
  baseRef: string;
}

const taskOf = (ctx: ToolContext): ApiDiffTask | undefined =>
  ctx.options as ApiDiffTask | undefined;

interface OasdiffChange {
  id: string;
  text: string;
  /** 3 = ERR (breaking), 2 = WARN, 1 = INFO. */
  level: number;
  operation?: string;
  path?: string;
  section?: string;
}

/**
 * oasdiff — the apiDiff gate (design: sota-08): the fully-portable half of an
 * API-contract gate — "no breaking change in <spec> vs <baseRef>". OPT-IN via
 * `apiDiff.enabled`; one task per configured spec. The repo-specific
 * staleness half (re-emit the spec from source and compare) stays a per-repo
 * script hook, deliberately outside this plugin.
 */
export const oasdiff: ToolAdapter = {
  id: "oasdiff",
  layer: "security",
  languages: [],
  bin: "oasdiff",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.20.0",
  installHint:
    "brew install oasdiff  (or: go install github.com/oasdiff/oasdiff@latest)",
  versionArgs: ["--version"],
  parseVersion: (out) => /oasdiff version\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],

  detect: (_detection, config) =>
    config.apiDiff.enabled && config.apiDiff.specs.length > 0,

  // One task per configured spec: each diffs against its own base copy.
  expand: (seed, env) =>
    env.config.apiDiff.specs.map((spec) => ({
      ...seed,
      options: { spec, baseRef: env.config.apiDiff.baseRef },
    })),

  buildArgs(ctx: ToolContext): BuiltCommand {
    const cfg = taskOf(ctx);
    if (!cfg) {
      throw new Error(
        "oasdiff task planned without an apiDiff spec — this is a planner bug",
      );
    }
    const headSpec = resolve(ctx.cwd, cfg.spec);
    // The run's own scratch folder, removed when the run ends.
    if (!ctx.tempDir)
      throw new Error(
        "oasdiff needs the run's temp folder; this is a runner bug",
      );
    const basePath = resolve(ctx.tempDir(), `base-${basename(cfg.spec)}`);
    // Extract the base spec from git. A missing base ref must CRASH this
    // adapter (buildArgs throws are crash-isolated per adapter), never pass:
    // in CI a flaked fetch would otherwise silently delete the gate.
    const out = openSync(basePath, "w");
    try {
      // The system git, never one the project puts first on PATH (it could
      // hand back the head as the base); `:./` reads the path from here, so a
      // project in a sub-folder of its repository finds its spec. Straight
      // into the file: a spec can be larger than any output buffer.
      execFileSync(
        resolveBin("git", ctx.cwd),
        ["cat-file", "blob", `${cfg.baseRef}:./${cfg.spec}`],
        { cwd: ctx.cwd, stdio: ["ignore", out, "pipe"] },
      );
    } catch (err) {
      throw new Error(
        `apiDiff: cannot read base spec '${cfg.spec}' at ref '${cfg.baseRef}' — fetch the base ref, fix apiDiff.baseRef, or disable the gate. (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
        { cause: err },
      );
    } finally {
      closeSync(out);
    }
    return {
      bin: this.bin,
      args: [
        "breaking",
        basePath,
        headSpec,
        "--format",
        "json",
        ...ctx.extraArgs,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (!raw.stdout.trim() && raw.exitCode !== 0) {
      const firstLine = raw.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      throw new Error(
        `oasdiff exited ${raw.exitCode} without JSON output${firstLine ? `: ${firstLine}` : ""}`,
      );
    }
    const { items: changes } = parseFindings<OasdiffChange>("oasdiff", raw);
    // A change without its level would read as info, below the gate.
    for (const change of changes) {
      if (
        typeof change.id !== "string" ||
        typeof change.text !== "string" ||
        typeof change.level !== "number"
      )
        throw new Error(
          "oasdiff output has a change without a string id and text and a numeric level: its output format may have changed; refusing to report it as info.",
        );
    }
    const task = taskOf(ctx);
    const spec = task?.spec ?? "openapi.json";
    const findings = changes.map((change) =>
      finding({
        tool: "oasdiff",
        layer: "security",
        file: absPosix(ctx.cwd, spec),
        line: 1,
        col: 1,
        ruleId: change.id,
        severity:
          change.level >= 3 ? "error" : change.level === 2 ? "warning" : "info",
        message: `${change.text}${change.operation && change.path ? ` (${change.operation} ${change.path})` : ""} [vs ${task?.baseRef ?? "base"}]`,
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
