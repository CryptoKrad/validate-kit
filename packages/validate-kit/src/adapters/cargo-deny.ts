import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { absPosix, finding, parseJsonLine } from "./base.js";

interface Krate {
  name: string;
  version: string;
}

interface DenyLine {
  type: string;
  fields?: {
    severity?: string;
    code?: string;
    message?: string;
    graphs?: { Krate?: Krate }[];
    labels?: { message?: string }[];
  };
}

/**
 * The checks run when the project's own arguments name none. Advisories are
 * osv-scanner's (it reads the RustSec database, and the vulnAudit gate owns
 * the network fetch).
 */
const DEFAULT_CHECKS = ["bans", "licenses", "sources"];
const CHECKS = new Set([...DEFAULT_CHECKS, "advisories", "all"]);

/**
 * cargo-deny — the crate graph against the project's `deny.toml`: banned or
 * duplicated crates, licenses not allowed, registries and git sources not
 * trusted. Runs where a deny.toml is (`cargo deny init` writes one). Its
 * diagnostics carry no file name, so each is placed on the crate's
 * Cargo.toml and names the crate.
 */
export const cargoDeny: ToolAdapter = {
  id: "cargo-deny",
  layer: "security",
  languages: ["rust"],
  bin: "cargo-deny",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  minVersion: "0.16.0",
  installHint:
    "cargo install --locked cargo-deny  (or: brew install cargo-deny)",
  parseVersion: (out) => /cargo-deny\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["deny.toml", ".deny.toml", ".cargo/deny.toml"],
      step: /cargo[- ]deny/,
    }),

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--(format|color)(=|$)/.test(arg)))
      return "--format and --color change the JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = ["--format", "json", "--color", "never"];
    if (ctx.configPath) args.push("check", "--config", ctx.configPath);
    else args.push("check");
    args.push(...ctx.extraArgs);
    if (!ctx.extraArgs.some((arg) => CHECKS.has(arg)))
      args.push(...DEFAULT_CHECKS);
    // Non-zero: one bit per check that failed (four checks).
    return {
      bin: this.bin,
      args,
      okExitCodes: Array.from({ length: 16 }, (_, i) => i),
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const manifest = absPosix(ctx.cwd, "Cargo.toml");
    const findings: Finding[] = [];
    let summary = false;
    // The diagnostics are JSON lines on stderr, beside cargo's own text.
    for (const line of raw.stderr.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      const d = parseJsonLine<DenyLine>("cargo-deny", line.trim());
      if (d.type === "summary") summary = true;
      if (d.type !== "diagnostic" || !d.fields) continue;
      const { severity, code, message, graphs, labels } = d.fields;
      if (severity !== "error" && severity !== "warning") continue;
      const krate = graphs?.[0]?.Krate;
      const why = (labels ?? [])
        .map((l) => l.message)
        .filter((m): m is string => Boolean(m))
        .join("; ");
      findings.push(
        finding({
          tool: "cargo-deny",
          layer: "security",
          language: "rust",
          file: manifest,
          line: 1,
          col: 1,
          ...(code ? { ruleId: code } : {}),
          severity,
          message: [
            krate ? `${krate.name}@${krate.version}:` : "",
            message ?? code ?? "",
            why ? `(${why})` : "",
          ]
            .filter(Boolean)
            .join(" "),
          fixable: false,
        }),
      );
    }
    if (!summary)
      throw new Error(
        `cargo-deny printed no summary${raw.stderr.trim() ? `: ${raw.stderr.trim().split("\n").at(-1) ?? ""}` : ""}`,
      );
    if (raw.exitCode !== 0 && !findings.some((f) => f.severity === "error"))
      throw new Error(
        `cargo-deny exited ${raw.exitCode} without an error diagnostic`,
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
