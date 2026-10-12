import { isAbsolute, resolve } from "node:path";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
  VulnAuditConfig,
} from "../core/types.js";
import { absPosix, finding, findingsArray, parseFindings } from "./base.js";

interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  database_specific?: { severity?: string };
}

interface OsvPackage {
  package: { name: string; version: string; ecosystem: string };
  vulnerabilities?: OsvVulnerability[];
}

interface OsvResult {
  source: { path: string };
  packages?: OsvPackage[];
}

/**
 * OSV severity → finding severity: known CVEs in a lockfile gate the run. An
 * advisory that states no severity (or one this does not know) is a warning,
 * so it gates too; only one marked LOW is info (the operator's decision,
 * 2026-10-04).
 */
function osvSeverity(s: string | undefined): "error" | "warning" | "info" {
  switch ((s ?? "").toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "error";
    case "LOW":
      return "info";
    default:
      return "warning";
  }
}

/**
 * osv-scanner — the vulnAudit gate (design: sota-08). One CLI covering the
 * kit's whole polyglot surface (npm + cargo + go + pypi lockfiles) under the
 * OSV.dev schema. OPT-IN via `vulnAudit.enabled` in validate config; needs
 * network (or `offline: true` with a pre-cached DB).
 */
export const osvScanner: ToolAdapter = {
  id: "osv-scanner",
  layer: "security",
  languages: ["ts", "js", "rust", "go", "python"],
  bin: "osv-scanner",
  supportsFix: false,
  fixWriteBack: false,
  runsAt: "project-root",
  fileScoped: false,
  optional: true,
  minVersion: "2.0.0",
  installHint: "brew install osv-scanner",
  versionArgs: ["--version"],
  parseVersion: (out) =>
    /osv-scanner version:\s*(\d+\.\d+\.\d+)/.exec(out)?.[1],

  detect: (_detection, config) => config.vulnAudit.enabled,

  expand: (seed, env) => [{ ...seed, options: env.config.vulnAudit }],

  // Exit 1: findings reported (recorded on the installed version).
  findingExitCodes: [1],

  buildArgs(ctx: ToolContext): BuiltCommand {
    const cfg = ctx.options as VulnAuditConfig | undefined;
    const args = ["scan", "source", "--format", "json", "--recursive"];
    if (cfg?.offline) args.push("--offline-vulnerabilities");
    if (cfg?.configFile) {
      args.push(
        "--config",
        isAbsolute(cfg.configFile)
          ? cfg.configFile
          : resolve(ctx.cwd, cfg.configFile),
      );
    }
    args.push(...ctx.extraArgs);
    // Ignore ctx.files: the gate scans LOCKFILES under scanPaths, not the
    // changed source files.
    for (const path of cfg?.scanPaths ?? ["."]) {
      args.push(isAbsolute(path) ? path : resolve(ctx.cwd, path));
    }
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A user explicitly enabled this gate — "no lockfiles found", a stale/
    // absent offline DB, or a network failure must crash loud, never pass.
    if (!raw.stdout.trim() && raw.exitCode !== 0) {
      const firstLine = raw.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      throw new Error(
        `osv-scanner exited ${raw.exitCode} without scan JSON${firstLine ? `: ${firstLine}` : ""}`,
      );
    }
    const { items: results } = parseFindings<OsvResult>(
      "osv-scanner",
      raw,
      "results",
    );
    const findings = [];
    for (const result of results) {
      const file = absPosix(ctx.cwd, result.source.path);
      for (const pkg of findingsArray<OsvPackage>(
        "osv-scanner",
        result,
        "packages",
      )) {
        const { name, version, ecosystem } = pkg.package;
        for (const vuln of findingsArray<OsvVulnerability>(
          "osv-scanner",
          pkg,
          "vulnerabilities",
          { absentIsNone: true },
        )) {
          const aliases = vuln.aliases?.length
            ? ` (${vuln.aliases.join(", ")})`
            : "";
          findings.push(
            finding({
              tool: "osv-scanner",
              layer: "security",
              file,
              line: 1,
              col: 1,
              ruleId: vuln.id,
              severity: osvSeverity(vuln.database_specific?.severity),
              message: `${name}@${version} (${ecosystem}): ${vuln.summary ?? vuln.id}${aliases}`,
              fixable: false,
              url: `https://osv.dev/vulnerability/${vuln.id}`,
            }),
          );
        }
      }
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
