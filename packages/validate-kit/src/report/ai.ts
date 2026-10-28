import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { kitVersion } from "../core/paths.js";
import type { RunSummary } from "../core/runner.js";
import type { Finding } from "../core/types.js";
import { toPosix } from "../detect/languages.js";

/**
 * AI-assist channel (design: sota-04): a flat, denormalized projection of the
 * SAME finding objects that feed SARIF/json/pretty, shaped for LLM agents —
 * repo-relative paths, redundant addressing (1-based range + verbatim snippet
 * as the drift-proof anchor), surrounding context so the model can reason
 * without re-reading the file, and an explicit fix-applicability boundary.
 * Emitted by `check --ai-json` and served by the MCP server (`check mcp`).
 */
export interface AiAssistReport {
  schemaVersion: "1.0";
  tool: { name: string; version: string };
  /** Repo root, so `file` paths are unambiguously resolvable. */
  root: string;
  totalFindings: number;
  /** Findings that are not accepted debt: the ones a change has to fix. */
  newFindings: number;
  findings: AiFinding[];
}

interface AiRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface AiFinding {
  /** Stable within a run; used by MCP get_finding. */
  id: string;
  /** Survives line drift and reruns: hash(ruleId + file + normalized snippet). */
  fingerprint: string;
  tool: string;
  ruleId?: string;
  helpUri?: string;
  severity: "error" | "warning" | "note";
  /** SARIF `rank` semantics, 0..1. Adapters carry no confidence → 0.5. */
  confidence: number;
  message: string;
  /** Repo-relative, POSIX-normalized. */
  file: string;
  /** The config file the tool used, repo-relative, when known. */
  config?: string;
  /** PRIMARY anchor — 1-based lines/columns (matches SARIF + human reading). */
  range: AiRange;
  /** The exact offending line(s) — drift-proof anchor for text-based edits. */
  snippet: string;
  /** Surrounding code so the model reasons without re-reading the file. */
  context?: { beforeLines: string[]; afterLines: string[]; startLine: number };
  /**
   * safe   → a tool-native autofix exists; apply via apply_safe_fixes / --fix.
   * manual → guidance only; a human or agent must author the edit.
   * (hasChoices is reserved — no adapter carries suggestion sets yet.)
   */
  fixApplicability: "safe" | "hasChoices" | "manual";
  /** `baselined`: accepted debt in validate.baseline.json, not this change's. */
  classification: "new" | "baselined";
}

const CONTEXT_LINES = 2;

// Same keyword family as semgrep/custom.yml vk-hardcoded-credential: snippets
// leave the machine (into prompts / MCP clients), so credential-shaped values
// are redacted before they can reach a model or transcript.
const CREDENTIAL_RE =
  /((?:password|passwd|pwd|api_key|apikey|api_token|secret|secret_key|access_token|auth_token|bearer_token|client_secret|private_key|db_password|database_url|connection_string|aws_secret_access_key)\s*[:=]\s*["'])([^"'\n]{6,})(["'])/gi;

function redactSecrets(text: string): string {
  return text.replace(CREDENTIAL_RE, "$1«redacted»$3");
}

function severityOf(f: Finding): AiFinding["severity"] {
  if (f.severity === "error") return "error";
  if (f.severity === "warning") return "warning";
  return "note";
}

export function toAiReport(
  summary: RunSummary,
  projectRoot: string,
): AiAssistReport {
  const lineCache = new Map<string, string[] | undefined>();
  const linesOf = (file: string): string[] | undefined => {
    if (!lineCache.has(file)) {
      try {
        lineCache.set(file, readFileSync(file, "utf8").split(/\r?\n/));
      } catch {
        lineCache.set(file, undefined);
      }
    }
    return lineCache.get(file);
  };

  const mapped = summary.findings.map((f, index): AiFinding => {
    const lines = linesOf(f.file);
    const startLine = Math.max(1, f.line);
    const endLine = Math.max(startLine, f.endLine ?? f.line);
    const snippet = redactSecrets(
      (lines ?? [])
        .slice(startLine - 1, endLine)
        .join("\n")
        .trimEnd(),
    );

    let context: AiFinding["context"];
    if (lines) {
      const beforeStart = Math.max(0, startLine - 1 - CONTEXT_LINES);
      const beforeLines = lines
        .slice(beforeStart, startLine - 1)
        .map(redactSecrets);
      const afterLines = lines
        .slice(endLine, endLine + CONTEXT_LINES)
        .filter((l, i, arr) => !(l === "" && i === arr.length - 1))
        .map(redactSecrets);
      context = { beforeLines, afterLines, startLine: beforeStart + 1 };
    }

    const file = toPosix(relative(projectRoot, f.file));
    const fingerprint = createHash("sha256")
      .update(
        `${f.ruleId ?? f.message}\0${file}\0${snippet.replace(/\s+/g, " ").trim()}`,
      )
      .digest("hex")
      .slice(0, 16);

    return {
      id: `F${index + 1}-${fingerprint}`,
      fingerprint,
      tool: f.tool,
      ...(f.ruleId ? { ruleId: f.ruleId } : {}),
      ...(f.url ? { helpUri: f.url } : {}),
      severity: severityOf(f),
      confidence: 0.5,
      message: redactSecrets(f.message),
      file,
      ...(f.config ? { config: toPosix(relative(projectRoot, f.config)) } : {}),
      range: {
        startLine,
        startColumn: Math.max(1, f.col),
        endLine,
        endColumn: Math.max(1, f.endCol ?? f.col),
      },
      snippet,
      ...(context ? { context } : {}),
      fixApplicability: f.fixable ? "safe" : "manual",
      classification: f.baselined ? "baselined" : "new",
    };
  });
  // New findings first: they are the ones a change has to fix.
  const findings = mapped.toSorted(
    (a, b) =>
      Number(a.classification === "baselined") -
      Number(b.classification === "baselined"),
  );

  return {
    schemaVersion: "1.0",
    tool: { name: "validate-kit", version: kitVersion() },
    root: toPosix(projectRoot),
    totalFindings: findings.length,
    newFindings: findings.filter((f) => f.classification === "new").length,
    findings,
  };
}

export function toAiJson(summary: RunSummary, projectRoot: string): string {
  return JSON.stringify(toAiReport(summary, projectRoot), null, 2);
}
