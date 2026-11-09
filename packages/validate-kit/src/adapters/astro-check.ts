import { stripVTControlCharacters } from "node:util";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";
import { formatChanged } from "./mutation.js";
import { packageTasks } from "./npm-package.js";

/** `src/pages/index.astro:7:6 - error ts(2322): Type '…' is not assignable …` */
const DIAGNOSTIC =
  /^(.+?):(\d+):(\d+) - (error|warning|hint) (\w+)\((\d+)\): (.*)$/;

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  hint: "info",
};

/** Does the package.json name `dep` in any of its dependency tables? */
function depends(manifest: Record<string, unknown>, dep: string): boolean {
  return ["dependencies", "devDependencies"].some((table) => {
    const deps = manifest[table];
    return typeof deps === "object" && deps !== null && dep in deps;
  });
}

/**
 * astro check — the type errors inside `.astro` files: a component used
 * without a required prop, a frontmatter value of the wrong type, a broken
 * import. `tsc` does not read `.astro`, so an Astro site that only runs tsc
 * checks its `.ts` and none of its pages. Where a package depends on both
 * `astro` and `@astrojs/check` (without the second, `astro check` stops to
 * ask whether to install it), run from that package with its own astro.
 * Errors are errors, warnings warnings, hints info; the diagnostic's code
 * (`ts2322`) is the rule. It writes the generated types under `.astro/`, as
 * `astro sync` does. Recorded on astro 7.4.1 with @astrojs/check 0.9.12:
 * docs/research/lint-toolchain/sota-2026-11-09/recorded.md.
 */
export const astroCheck: ToolAdapter = {
  id: "astro-check",
  layer: "type-check",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  tier: "verify",
  bin: "astro",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "4.0.0",
  installHint: "pnpm add -D @astrojs/check typescript",
  parseVersion: (out) => /astro\s+v(\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],

  expand: (seed, env) =>
    packageTasks(
      seed,
      env,
      ({ manifest }) =>
        depends(manifest, "astro") && depends(manifest, "@astrojs/check"),
    ),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-w|--watch|--root|--minimumSeverity|--preserveWatchOutput)(=|$)/.test(
        arg,
      ),
    )
      ? "--watch never ends, and --root and --minimumSeverity are the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["check", ...ctx.extraArgs],
      env: { ASTRO_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
      // 1: a diagnostic at the failing severity, and a config it could not load.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const lines = stripVTControlCharacters(raw.stdout).split(/\r?\n/);
    // No summary: astro stopped before checking (a config error, a prompt).
    if (!lines.some((line) => /^Result \(\d+ files?\):/.test(line))) {
      const why = [...lines, ...raw.stderr.split(/\r?\n/)].find((line) =>
        /error/i.test(line),
      );
      throw why
        ? new Error(`astro check: ${stripVTControlCharacters(why).trim()}`)
        : formatChanged("astro check", "printed no Result summary");
    }
    const findings: Finding[] = [];
    for (const line of lines) {
      const [, file, row, col, level, source, code, message] =
        DIAGNOSTIC.exec(line) ?? [];
      if (!file || !level) continue;
      findings.push(
        finding({
          tool: "astro-check",
          layer: "type-check",
          file: absPosix(ctx.cwd, file),
          line: Number(row),
          col: Number(col),
          ruleId: `${source}${code}`,
          severity: SEVERITY[level] ?? "error",
          message: message ?? "",
          fixable: false,
        }),
      );
    }
    if (raw.exitCode === 1 && !findings.some((f) => f.severity === "error"))
      throw formatChanged(
        "astro check",
        "exited 1 with no error diagnostic in its output",
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
