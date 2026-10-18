import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBin } from "../core/exec.js";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  finding,
  findingsArray,
  lineOf,
  parseJsonOutput,
  scratchOf,
} from "./base.js";
import { PACK_ENV, packerOf, packTasks } from "./npm-package.js";

/** One problem in `analysis.problems`; which fields it has depends on its kind. */
interface Problem {
  kind?: unknown;
  entrypoint?: unknown;
  resolutionKind?: unknown;
  fileName?: unknown;
}

interface AttwTask {
  /** What packs the package as its repository publishes it. */
  packer: "pnpm" | "npm";
}

/** Each problem kind's title (@arethetypeswrong/core 0.18.5, problems.js). */
const TITLES: Record<string, string> = {
  NoResolution: "Resolution failed",
  UntypedResolution: "Could not find types",
  FalseCJS: "Types are CJS, but implementation is ESM",
  FalseESM: "Types are ESM, but implementation is CJS",
  NamedExports: "Named exports cannot be detected by Node.js",
  CJSResolvesToESM: "Entrypoint is ESM-only",
  FallbackCondition: "Resolved through fallback condition",
  CJSOnlyExportsDefault: "CJS module uses default export",
  FalseExportDefault: "Types incorrectly use default export",
  MissingExportEquals: "Types are missing an `export =`",
  UnexpectedModuleSyntax: "Syntax is incompatible with detected module kind",
  InternalResolutionError: "Internal resolution error",
};

/** The resolutions each profile ignores (@arethetypeswrong/cli 0.18.5, profiles.js). */
const PROFILES: Record<string, string[]> = {
  strict: [],
  node16: ["node10"],
  "esm-only": ["node10", "node16-cjs"],
};

/** The package.json field a type problem is about, first that it has. */
const FIELDS = ["exports", "types", "typings", "main"];

/**
 * Packs the package into the task's scratch folder (never beside the
 * user's own tarballs), then checks that tarball. A failed pack exits 90
 * with its log, which the runner reports as a crash.
 */
const PACK_AND_CHECK = `out="$1"; packer="$2"; attw="$3"; shift 3
mkdir -p "$out" && "$packer" pack --pack-destination "$out" > "$out.log" 2>&1 || { cat "$out.log" >&2; exit 90; }
exec "$attw" "$out"/*.tgz "$@"`;

/** Where a problem is: its entrypoint and resolution, or its file. */
function whereOf(p: Problem): string {
  if (typeof p.entrypoint === "string")
    return `"${p.entrypoint}"${typeof p.resolutionKind === "string" ? ` under ${p.resolutionKind} resolution` : ""}`;
  return typeof p.fileName === "string" ? p.fileName : "the package";
}

/** The values of `flag`: `--flag=a`, or the words after `--flag` up to the next flag. */
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => {
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)];
    if (arg !== flag) return [];
    const rest = args.slice(i + 1);
    const end = rest.findIndex((next) => next.startsWith("-"));
    return end < 0 ? rest : rest.slice(0, end);
  });
}

/**
 * The problems the project's profile and ignore-rules hide. attw's JSON
 * lists every problem whatever they say; only its exit code applies them
 * (js-python.md, 3). As attw reads them: the config file's profile over
 * the command line's, and the rules of both.
 */
function hiddenBy(ctx: ToolContext): (p: Problem) => boolean {
  let config: { profile?: unknown; ignoreRules?: unknown } = {};
  try {
    config = JSON.parse(
      readFileSync(ctx.configPath ?? join(ctx.cwd, ".attw.json"), "utf8"),
    ) as typeof config;
  } catch {
    // No config file; a broken one makes attw itself fail.
  }
  const profile =
    typeof config.profile === "string"
      ? config.profile
      : (flagValues(ctx.extraArgs, "--profile").at(-1) ?? "strict");
  const resolutions = new Set(PROFILES[profile] ?? []);
  // A rule is its kind in kebab case: cjs-resolves-to-esm, CJSResolvesToESM.
  const rules = new Set(
    [
      ...flagValues(ctx.extraArgs, "--ignore-rules"),
      ...(Array.isArray(config.ignoreRules)
        ? (config.ignoreRules as unknown[])
        : []),
    ].map((rule) => String(rule).replaceAll("-", "")),
  );
  return (p) =>
    rules.has(String(p.kind).toLowerCase()) ||
    (typeof p.resolutionKind === "string" && resolutions.has(p.resolutionKind));
}

/**
 * attw (@arethetypeswrong/cli) — the types a package publishes against how
 * TypeScript and Node resolve it: an ESM-only entrypoint a `require` reaches,
 * types that say CJS for ESM code, an entrypoint with no types. Each problem
 * the project's profile and ignore-rules leave is an error at the
 * package.json field it is about. The package is packed into the task's
 * scratch folder, by pnpm under a pnpm lockfile (so `publishConfig` holds)
 * else npm, with no script and no network. Where a package it could publish
 * (a name, a version, not private) chose it: @arethetypeswrong/cli in its
 * package.json or one above it, an `.attw.json`, or `tools.attw.enabled`;
 * run from that package. Recorded on 0.18.5:
 * docs/research/lint-toolchain/sota-2026-10-18/js-python.md, 3.
 */
export const attw: ToolAdapter = {
  id: "attw",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "attw",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.18.5",
  installHint: "pnpm add -D @arethetypeswrong/cli",
  parseVersion: (out) => /cli: v(\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],

  expand: (seed, env) =>
    packTasks(seed, env, "@arethetypeswrong/cli", [".attw.json"]).map(
      (task) => {
        if (task.cannotRun) return task;
        const options: AttwTask = {
          packer: packerOf(task.cwd, env.projectRoot),
        };
        return { cwd: task.cwd, options };
      },
    ),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|-q|--quiet|-P|--pack|-p|--from-npm)(=|$)/.test(arg),
    )
      ? "the kit packs the package and reads attw's JSON; --format and --quiet change it, and --from-npm reads the registry"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: "sh",
      args: [
        "-c",
        PACK_AND_CHECK,
        "attw",
        join(scratchOf(ctx), "pack"),
        (ctx.options as AttwTask).packer,
        // The project's attw; a configured one (the planner's object over
        // this one) on PATH only.
        resolveBin(this.bin, ctx.cwd, process.env, this !== attw),
        "--format",
        "json",
        ...(ctx.configPath ? ["--config-path", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      env: PACK_ENV,
      // 1: problems, and a usage error (no JSON then).
      okExitCodes: [0, 1],
      // A timeout stops the packing too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const root = parseJsonOutput<{ analysis?: { types?: unknown } } | null>(
      "attw",
      raw,
      null,
    );
    // A package with no types has nothing to check, and exits 0.
    const analysis = root?.analysis;
    const problems =
      analysis?.types === false
        ? []
        : findingsArray<Problem>("attw", analysis, "problems");
    const manifest = join(ctx.cwd, "package.json");
    const text = readFileSync(manifest, "utf8");
    const pkg = JSON.parse(text) as object;
    const field = FIELDS.find((key) => Object.hasOwn(pkg, key));
    const hidden = hiddenBy(ctx);
    // Exit 0: whatever the JSON lists, the profile hides.
    const shown = raw.exitCode === 1 ? problems.filter((p) => !hidden(p)) : [];
    const findings = shown.map((p) => {
      if (typeof p.kind !== "string")
        throw new Error(
          "attw reported a problem without a kind: its output format may have changed; refusing to report it.",
        );
      return finding({
        tool: "attw",
        layer: "lint",
        file: absPosix(ctx.cwd, manifest),
        line: field ? lineOf(text, new RegExp(`"${field}"\\s*:`)) : 1,
        col: 1,
        ruleId: p.kind,
        severity: "error",
        message: `${TITLES[p.kind] ?? p.kind} at ${whereOf(p)}`,
        fixable: false,
        url: `https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/${p.kind}.md`,
      });
    });
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
