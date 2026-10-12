import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { toolAdopted } from "../detect/adoption.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/** One diagnostic of a go/analysis checker's `-json` output. */
interface AnalysisDiagnostic {
  posn?: unknown;
  message?: unknown;
}

interface NilawayTask {
  /** The go.mod `module` path: nilaway reports only packages under it. */
  module?: string;
  /** Files whose findings count (absolute, POSIX): the kit's scope. */
  scope: string[];
}

/** The `module` path a go.mod declares, if it can be read. */
export function goModulePath(dir: string): string | undefined {
  try {
    const mod = readFileSync(join(dir, "go.mod"), "utf8");
    return /^module\s+(\S+)/m.exec(mod)?.[1];
  } catch {
    return undefined;
  }
}

/** `file:line:col: message`, as go/analysis checkers print a type error. */
const POSITIONED = /^(.+?):(\d+):(\d+): (.+)$/;

/**
 * nilaway — Uber's nil-panic analysis for Go: it follows a nil from where it
 * is made to where it is dereferenced, across functions and packages. A
 * whole-module analysis with false positives that need judgement: opt-in
 * (`tools.nilaway.enabled`, or a task step that runs it), the `deep` tier.
 */
export const nilaway: ToolAdapter = {
  id: "nilaway",
  layer: "lint",
  languages: ["go"],
  bin: "nilaway",
  // A `go install`ed checker prints `version devel`: no minimum can be checked.
  versionArgs: ["-V=full"],
  minVersion: "0.0.0",
  parseVersion: () => undefined,
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  installHint: "go install go.uber.org/nilaway/cmd/nilaway@latest",
  // A type error stops the analysis of its package.
  masks: (f) => f.ruleId === "typecheck",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /(?:^|[\s;&|"'(/])nilaway(?:\s|$)/m,
    }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const module = goModulePath(seed.cwd);
    const task: NilawayTask = {
      scope: [...env.scopedFiles],
      ...(module ? { module } : {}),
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--?(json|pretty-print)(=|$)/.test(arg)))
      return "-json and -pretty-print shape the output the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as NilawayTask | undefined;
    // Without -include-pkgs it also reports the module's dependencies.
    const include = task?.module ? ["-include-pkgs", task.module] : [];
    return {
      bin: this.bin,
      args: [
        "-json",
        "-pretty-print=false",
        ...include,
        ...ctx.extraArgs,
        "./...",
      ],
      // Exit 0 with or without findings under -json; 1 when a package does
      // not type-check (the errors on stderr).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const scope = new Set((ctx.options as NilawayTask).scope);
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: [...scope].filter(
        (file) => file.endsWith(".go") && isUnder(file, cwd),
      ).length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    if (raw.exitCode === 1) {
      const errors = raw.stderr.split(/\r?\n/).flatMap((line) => {
        const m = POSITIONED.exec(line.trim());
        if (!m?.[1] || !m[2] || !m[3] || !m[4]) return [];
        return [
          finding({
            tool: "nilaway",
            layer: "lint",
            language: "go",
            file: absPosix(cwd, m[1]),
            line: Number(m[2]),
            col: Number(m[3]),
            ruleId: "typecheck",
            severity: "error",
            message: m[4],
            fixable: false,
          }),
        ];
      });
      if (errors.length === 0)
        throw new Error(
          `nilaway failed: ${raw.stderr.trim().split("\n")[0] ?? ""}`,
        );
      return result(errors);
    }
    // { "<package>": { "<analyzer>": [diagnostic] | { "error": "..." } } }
    const packages = raw.stdout.trim()
      ? (JSON.parse(raw.stdout) as Record<string, Record<string, unknown>>)
      : {};
    const findings: Finding[] = [];
    for (const [pkg, analyzers] of Object.entries(packages)) {
      for (const [name, value] of Object.entries(analyzers)) {
        if (!Array.isArray(value)) {
          const error = (value as { error?: unknown } | null)?.error;
          throw new Error(
            `nilaway: ${name} failed on ${pkg}${typeof error === "string" ? `: ${error}` : ""}`,
          );
        }
        for (const d of value as AnalysisDiagnostic[]) {
          const m =
            typeof d.posn === "string"
              ? /^(.+):(\d+):(\d+)$/.exec(d.posn)
              : null;
          if (!m?.[1] || typeof d.message !== "string")
            throw new Error(
              "nilaway output has a diagnostic without a position or message: its output format may have changed; refusing to report it.",
            );
          const file = absPosix(cwd, m[1]);
          if (!scope.has(file)) continue;
          // The first line says what; the rest trace the nil's flow.
          const [head = "", ...flow] = d.message.trim().split("\n");
          findings.push(
            finding({
              tool: "nilaway",
              layer: "lint",
              language: "go",
              file,
              line: Number(m[2]),
              col: Number(m[3]),
              ruleId: "nil-panic",
              severity: "warning",
              message: [head, ...flow.map((l) => l.trim())].join(" ").trim(),
              fixable: false,
            }),
          );
        }
      }
    }
    return result(
      findings.toSorted(
        (a, b) =>
          a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col,
      ),
    );
  },
};
