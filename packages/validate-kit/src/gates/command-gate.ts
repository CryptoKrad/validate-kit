import { existsSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import { absPosix, finding } from "../adapters/base.js";
import { gitSync } from "../adapters/native.js";
import type {
  Invariant,
  Layer,
  PlanEnv,
  RawOutput,
  RunResult,
  Tier,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";

export interface CommandGateSpec {
  id: string;
  /** Shell command, run with `sh -c` at the project root. Exit 0 = it holds. */
  run: string;
  /** What must stay true, in plain words; shown when the gate fails. */
  statement?: string;
  /**
   * Text the output must contain. Without it a command that ran nothing (no
   * tests collected, an empty script) passes on its exit code alone.
   */
  expect?: string;
  layer?: Layer;
  /** Default "verify": not on every commit, but on every normal run. */
  tier?: Tier;
  timeoutMs?: number;
  /**
   * Paths, relative to the project root, that must exist (a spec, a test
   * file, or a directory). A missing one is a finding at that path; the first
   * one that exists is where a failed command's finding points.
   */
  requires?: string[];
  /**
   * Globs relative to the project root; `!pattern` excludes. In a
   * changed-file run the gate is planned only when a changed path matches,
   * or is under one of `requires`. Without them the gate runs whatever
   * changed.
   */
  covers?: string[];
}

/**
 * Does a changed-file run touch what this gate watches? Full runs: yes.
 * Matched against the change list, not the disk, so a deleted file counts.
 */
function watcher(spec: CommandGateSpec): (env: PlanEnv) => boolean {
  if (!spec.covers?.length) return () => true;
  // picomatch over an array matches when ANY pattern does, so a `!x`
  // pattern would match nearly everything; apply negations as exclusions.
  const options = { dot: true };
  const include = picomatch(
    spec.covers.filter((pattern) => !pattern.startsWith("!")),
    options,
  );
  const negated = spec.covers
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const exclude =
    negated.length > 0 ? picomatch(negated, options) : () => false;
  // A required path may be a directory: anything under it counts.
  const required = (spec.requires ?? []).map((path) =>
    path.replace(/^\.\//, "").replace(/\/+$/, ""),
  );
  const isRequired = (path: string) =>
    required.some((req) => path === req || path.startsWith(`${req}/`));
  return (env) =>
    !env.changedPaths ||
    env.changedPaths.some(
      (path) => isRequired(path) || (include(path) && !exclude(path)),
    );
}

/** git's file list, once per plan: every gate's expand gets the same scope list. */
const listedFor = new WeakMap<readonly string[], string[] | undefined>();

/**
 * The `covers` patterns that match no file of the project: an invariant
 * whose glob a rename left behind never runs in a changed-file run again.
 * Read from git's file list; outside git, none is reported.
 */
function deadCovers(spec: CommandGateSpec, env: PlanEnv): string[] {
  const include = (spec.covers ?? []).filter(
    (pattern) => !pattern.startsWith("!"),
  );
  if (include.length === 0) return [];
  if (!listedFor.has(env.scopedFiles))
    listedFor.set(
      env.scopedFiles,
      gitSync(env.projectRoot, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
        ?.split("\0")
        .filter(Boolean),
    );
  const files = listedFor.get(env.scopedFiles);
  if (files === undefined) return [];
  return include.filter((pattern) => {
    const matches = picomatch(pattern, { dot: true });
    return !files.some((file) => matches(file));
  });
}

const OUTPUT_TAIL_LINES = 15;
const OUTPUT_TAIL_CHARS = 2000;

function outputTail(text: string): string {
  return text
    .trim()
    .split("\n")
    .slice(-OUTPUT_TAIL_LINES)
    .join("\n")
    .slice(-OUTPUT_TAIL_CHARS);
}

/**
 * Wrap a command as a project-level tool, so a project's own check (its test
 * suite, a build, a model run) sits behind the same exit code as everything
 * else. The command's exit code is the verdict; "could not run at all"
 * (126/127) is a crash, never a finding.
 */
export function commandGate(spec: CommandGateSpec): ToolAdapter {
  const watches = watcher(spec);
  return {
    id: spec.id,
    layer: spec.layer ?? "behavior",
    languages: [],
    bin: "sh",
    binSetting: false,
    supportsFix: false,
    fixWriteBack: false,
    minVersion: "1.0.0",
    installHint: "a POSIX shell (sh) on PATH",
    // `sh --version` is not portable; this proves sh runs.
    versionArgs: ["-c", "echo 1.0.0"],
    tier: spec.tier ?? "verify",
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    policy: spec,

    expand: (seed, env) =>
      watches(env)
        ? [{ ...seed, options: { dead: deadCovers(spec, env) } }]
        : [],

    buildArgs: () => ({
      bin: "sh",
      args: ["-c", spec.run],
      okExitCodes: "any",
      processGroup: true,
    }),

    parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
      const output = `${raw.stdout}\n${raw.stderr}`.trim();
      const requires = spec.requires ?? [];
      const missing = requires.filter(
        (path) => !existsSync(resolve(ctx.cwd, path)),
      );
      if (raw.exitCode === 126 || raw.exitCode === 127) {
        // A crash carries no findings, so missing evidence rides on its message.
        throw new Error(
          `${spec.id}: \`${spec.run}\` could not run (exit ${raw.exitCode})${output ? `: ${output.split("\n")[0]}` : ""}${missing.length > 0 ? `; also missing: ${missing.join(", ")}` : ""}`,
        );
      }
      const reason =
        raw.exitCode !== 0
          ? `exited ${raw.exitCode}`
          : spec.expect !== undefined && !output.includes(spec.expect)
            ? `output did not contain ${JSON.stringify(spec.expect)}`
            : undefined;
      // Each stream's own tail: a runner that reports failures on stdout and
      // chatters on stderr must not have the failure pushed out of view.
      const tail = [raw.stdout, raw.stderr]
        .map(outputTail)
        .filter(Boolean)
        .join("\n");
      const label = spec.statement ?? `\`${spec.run}\``;
      const anchor = requires.find((path) => !missing.includes(path)) ?? ".";
      const failure = (file: string, why: string, ruleId = spec.id) =>
        finding({
          tool: spec.id,
          layer: spec.layer ?? "behavior",
          file: absPosix(ctx.cwd, file),
          line: 1,
          col: 1,
          ruleId,
          severity: "error",
          message: `${label} — ${why}`,
          fixable: false,
        });
      const dead = (
        (ctx.options as { dead?: string[] } | undefined)?.dead ?? []
      ).map((pattern) =>
        failure(
          anchor,
          `covers \`${pattern}\`, which matches no file: in a changed-file run this check never runs. Fix the pattern`,
          "dead-cover",
        ),
      );
      return {
        findings: [
          ...dead,
          ...missing.map((path) => failure(path, `${path} does not exist`)),
          ...(reason === undefined
            ? []
            : [failure(anchor, `${reason}${tail ? `\n${tail}` : ""}`)]),
        ],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    },
  };
}

/**
 * An invariant from the config, as a gate: `inv:<id>`, with its evidence as
 * required paths. Without a `check` it only checks that the evidence exists.
 */
export function invariantGate(invariant: Invariant): ToolAdapter {
  return commandGate({
    id: `inv:${invariant.id}`,
    run: invariant.check ?? "true",
    statement: `${invariant.id}: ${invariant.statement}`,
    expect: invariant.expect,
    // Cheap enough for every commit: an invariant that only checks its
    // evidence exists, or one whose `covers` limits it to related changes.
    tier:
      invariant.tier ??
      (invariant.check === undefined || invariant.covers?.length
        ? "fast"
        : "verify"),
    requires: invariant.evidence,
    covers: invariant.covers,
  });
}
