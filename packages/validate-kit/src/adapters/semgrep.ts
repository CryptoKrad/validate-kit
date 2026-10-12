import { existsSync } from "node:fs";
import { kitSemgrepConfig } from "../core/paths.js";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, finding, parseFindings } from "./base.js";

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end?: { line: number; col: number };
  extra?: { message?: string; severity?: string; fix?: string };
}

interface SemgrepError {
  level?: string;
  message?: string;
  path?: string;
}

/**
 * Semgrep's severities: LOW, MEDIUM, HIGH, CRITICAL, and the legacy INFO,
 * WARNING, ERROR for LOW, MEDIUM, HIGH
 * (docs/research/lint-toolchain/semgrep-severity.md). Undefined for any other.
 */
function mapSeverity(s: string): "error" | "warning" | "info" | undefined {
  switch (s.toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
    case "ERROR":
      return "error";
    case "MEDIUM":
    case "WARNING":
      return "warning";
    case "LOW":
    case "INFO":
      return "info";
    default:
      return undefined;
  }
}

/** semgrep — multi-language SAST. Optional. Uses the kit's custom ruleset (offline). */
export const semgrep: ToolAdapter = {
  id: "semgrep",
  layer: "security",
  languages: ["ts", "js", "rust", "go", "python"],
  bin: "semgrep",
  supportsFix: false,
  fixWriteBack: false,
  runsAt: "project-root",
  optional: true,
  minVersion: "1.50.0",
  installHint: "brew install semgrep  (or: pipx install semgrep)",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  detect: () => existsSync(kitSemgrepConfig()),

  // Rewritten ids carry the config file's folders (the kit's install path):
  // a baseline would hold on one checkout only (DV8;
  // docs/research/lint-toolchain/semgrep-rule-id-prefix.md).
  refuseArgs: (extraArgs) =>
    extraArgs.includes("--rewrite-rule-ids")
      ? "--rewrite-rule-ids puts the config file's path into every rule id, so findings and a baseline would depend on where the kit is installed"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = [
      "--json",
      "--quiet",
      "--disable-version-check",
      "--config",
      ctx.configPath ?? kitSemgrepConfig(),
    ];
    // semgrep exits 2 on the flag given twice.
    if (!ctx.extraArgs.includes("--no-rewrite-rule-ids"))
      args.push("--no-rewrite-rule-ids");
    args.push(...ctx.extraArgs);
    const targets = ctx.files && ctx.files.length > 0 ? ctx.files : [ctx.cwd];
    args.push(...targets);
    return {
      bin: this.bin,
      args,
      okExitCodes: [0, 1],
      env: { SEMGREP_SEND_METRICS: "off" },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { root, items: results } = parseFindings<SemgrepResult>(
      "semgrep",
      raw,
      "results",
    );
    const parsed = (root ?? {}) as { errors?: SemgrepError[] };
    // errors[] holds files semgrep could NOT scan (parse failures, timeouts)
    // while the exit code stays 0/1 — dropping them lets unscanned files pass
    // the security layer as CLEAN. Level "warn" entries (rule skips etc.) are
    // tolerated; level "error" means real coverage loss → fail loud.
    const scanErrors = (parsed.errors ?? []).filter(
      (e) => (e.level ?? "error").toLowerCase() === "error",
    );
    if (scanErrors.length > 0) {
      const first = scanErrors[0];
      throw new Error(
        `semgrep failed to scan ${scanErrors.length} target(s)${first?.path ? ` (first: ${first.path})` : ""}: ${first?.message ?? "unknown error"}`,
      );
    }
    const findings = results.map((r) => {
      // A result without its path or a severity semgrep defines: the output
      // changed, and it must not read as info.
      const severity =
        typeof r.path === "string" && typeof r.extra?.severity === "string"
          ? mapSeverity(r.extra.severity)
          : undefined;
      if (!severity)
        throw new Error(
          `semgrep output has a result without a path or a known severity (${JSON.stringify(r.extra?.severity)}): its output format may have changed; refusing to report it as info.`,
        );
      const file = absPosix(ctx.cwd, r.path);
      const lang = languageForFile(file);
      return finding({
        tool: "semgrep",
        layer: "security",
        language: lang,
        file,
        line: r.start.line,
        col: r.start.col,
        ...(r.end ? { endLine: r.end.line, endCol: r.end.col } : {}),
        ruleId: r.check_id,
        severity,
        message: r.extra?.message ?? r.check_id,
        fixable: typeof r.extra?.fix === "string",
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
