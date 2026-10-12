import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

interface SlitherElement {
  source_mapping?: {
    filename_relative?: string;
    lines?: number[];
    starting_column?: number;
  };
}

interface SlitherDetector {
  check: string;
  impact: string;
  confidence: string;
  description: string;
  elements: SlitherElement[];
  reference?: string;
}

interface SlitherOutput {
  success: boolean;
  error: string | null;
  results?: { detectors?: SlitherDetector[] };
}

interface SlitherTask {
  /** Files whose findings count (absolute, POSIX): the kit's scope. */
  scope: string[];
}

/** Slither's impact → severity: High and Medium gate as errors, Low warns. */
function impactSeverity(impact: string): Severity {
  switch (impact) {
    case "High":
    case "Medium":
      return "error";
    case "Low":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Slither — Trail of Bits' static analyzer for Solidity (reentrancy,
 * unchecked calls, shadowing, ...). It compiles the whole project through
 * Foundry or Hardhat, so it runs from that root, in the `deep` tier, with
 * `--skip-clean` (crytic-compile otherwise runs `forge clean` and deletes the
 * project's build). Findings in dependencies are dropped.
 */
export const slither: ToolAdapter = {
  id: "slither",
  layer: "security",
  languages: ["solidity"],
  bin: "slither",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 600_000,
  minVersion: "0.10.0",
  installHint:
    "uv tool install slither-analyzer  (or: pipx install slither-analyzer)",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const task: SlitherTask = { scope: [...env.scopedFiles] };
    return [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--(json|sarif|checklist)(=|$)/.test(arg)))
      return "--json, --sarif and --checklist replace the JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        ".",
        "--json",
        "-",
        "--exclude-dependencies",
        "--skip-clean",
        ...ctx.extraArgs,
      ],
      // 0 clean; 255 with results (recorded on 0.11.6). A failed compile
      // also exits 255, with `success: false` in the JSON.
      okExitCodes: [0, 255],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const start = raw.stdout.indexOf("{");
    if (start < 0)
      throw new Error(
        `slither printed no JSON: ${raw.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    const out = JSON.parse(raw.stdout.slice(start)) as SlitherOutput;
    if (!out.success)
      throw new Error(`slither failed: ${out.error ?? "unknown error"}`);
    const cwd = toPosix(ctx.cwd);
    const scope = new Set((ctx.options as SlitherTask).scope);
    const findings: Finding[] = [];
    for (const d of out.results?.detectors ?? []) {
      const at = d.elements.find(
        (e) => e.source_mapping?.filename_relative,
      )?.source_mapping;
      if (!at?.filename_relative) continue;
      const file = absPosix(cwd, at.filename_relative);
      if (!isUnder(file, cwd) || !scope.has(file)) continue;
      const lines = at.lines ?? [];
      findings.push(
        finding({
          tool: "slither",
          layer: "security",
          language: "solidity",
          file,
          line: lines[0] ?? 1,
          col: at.starting_column ?? 1,
          ...(lines.length > 1 ? { endLine: lines[lines.length - 1] } : {}),
          ruleId: d.check,
          severity: impactSeverity(d.impact),
          message: `${d.description.split("\n")[0]?.trim() ?? d.check} [${d.impact}, confidence ${d.confidence}]`,
          fixable: false,
          ...(d.reference ? { url: d.reference } : {}),
        }),
      );
    }
    return {
      findings,
      filesProcessed: [...scope].filter(
        (f) => f.endsWith(".sol") && isUnder(f, cwd),
      ).length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
