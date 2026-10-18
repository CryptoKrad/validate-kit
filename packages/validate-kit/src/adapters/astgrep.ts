import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { kitRulesDir, kitSgconfig } from "../core/paths.js";
import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { languageForFile } from "../detect/languages.js";
import {
  absPosix,
  clampSeverity,
  escapeRegex,
  finding,
  parseJsonLine,
} from "./base.js";

/** What `expand` attaches to an ast-grep task from the `astGrep` config key. */
interface AstGrepOptions {
  /** Extra rule directories merged with the bundled rule library. */
  ruleDirs?: string[];
  /** Rule ids selected by the resolved presets and config. */
  ruleIds?: string[];
  /** Absolute path of a project sgconfig that replaces the kit's. */
  sgconfig?: string;
}

const optionsOf = (ctx: ToolContext): AstGrepOptions => ctx.options ?? {};

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

// Generated sgconfigs live in a PER-PROCESS mkdtemp dir (0o700, unpredictable
// name). A fixed world-visible path (the old os.tmpdir()/validate-kit/) could
// be pre-created/poisoned by another local user — a poisoned sgconfig silently
// changes WHICH rules run, i.e. a local-attacker false CLEAN.
let generatedConfigDir: string | undefined;
const generatedConfigCache = new Map<string, string>();

function generatedConfig(ctx: ToolContext): string {
  const ruleDirs = [
    kitRulesDir(),
    ...(optionsOf(ctx).ruleDirs ?? []).map((dir) =>
      isAbsolute(dir) ? dir : resolve(ctx.cwd, dir),
    ),
  ];
  const key = createHash("sha256")
    .update(ruleDirs.join("\0"))
    .digest("hex")
    .slice(0, 16);
  const cached = generatedConfigCache.get(key);
  if (cached) return cached;
  generatedConfigDir ??= mkdtempSync(resolve(tmpdir(), "validate-kit-"));
  const path = resolve(generatedConfigDir, `sgconfig-${key}.yml`);
  writeFileSync(
    path,
    `ruleDirs:\n${ruleDirs.map((ruleDir) => `  - ${quoteYaml(ruleDir)}`).join("\n")}\n`,
  );
  generatedConfigCache.set(key, path);
  return path;
}

function ruleFilterArgs(ctx: ToolContext): string[] {
  const ruleIds = optionsOf(ctx).ruleIds ?? [];
  if (ruleIds.length === 0) return [];
  return ["--filter", `^(?:${ruleIds.map(escapeRegex).join("|")})$`];
}

interface AgMatch {
  file: string;
  /** The source lines the match spans. */
  lines?: string;
  /** Characters before the match on its first line, and after it on its last. */
  charCount?: { leading?: number };
  metadata?: { suppressedBy?: unknown };
  range?: {
    start?: { line: number; column: number };
    end?: { line: number; column: number };
  };
  replacement?: string;
  language?: string;
  ruleId?: string;
  severity?: string;
  message?: string;
}

const suppressions = new Map<string, RegExp>();

/**
 * A match the repository already suppressed for another tool on its line:
 * the rule's `metadata.suppressedBy`, a case-insensitive pattern tested
 * against the match's first line from where the match starts (so
 * `eval(a); exec(b)  # noqa: S307` suppresses the eval only, and a comment
 * inside a multi-line call does not count), as ruff and bandit read their
 * own comments. An ast-grep rule cannot tell which line a comment is on.
 */
function suppressed(m: AgMatch): boolean {
  const pattern = m.metadata?.suppressedBy;
  if (typeof pattern !== "string" || m.lines === undefined) return false;
  let re = suppressions.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    suppressions.set(pattern, re);
  }
  const first = m.lines.split("\n")[0] ?? "";
  const start = m.charCount?.leading ?? m.range?.start?.column ?? 0;
  return re.test(Array.from(first).slice(start).join(""));
}

/** ast-grep — the custom-rule layer across every language. Uses the kit's sgconfig. */
export const astgrep: ToolAdapter = {
  id: "ast-grep",
  layer: "custom-rules",
  languages: ["ts", "js", "rust", "go", "python"],
  bin: "ast-grep",
  supportsFix: true,
  fixWriteBack: true,
  runsAt: "project-root",
  // --include-metadata arrived in 0.38.2.
  minVersion: "0.38.2",
  installHint: "brew install ast-grep  (or: npm i -g @ast-grep/cli)",
  parseVersion: (out) =>
    /ast-grep\s+(\d+\.\d+\.\d+)/.exec(out)?.[1] ??
    /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(seed, env) {
    const { ruleDirs, ruleIds, sgconfig } = env.config.astGrep;
    const options: AstGrepOptions = {
      ...(ruleDirs.length > 0 ? { ruleDirs } : {}),
      ...(ruleIds.length > 0 ? { ruleIds } : {}),
      ...(sgconfig ? { sgconfig: absPosix(env.projectRoot, sgconfig) } : {}),
    };
    return [Object.keys(options).length > 0 ? { ...seed, options } : seed];
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const targets = ctx.files && ctx.files.length > 0 ? ctx.files : [ctx.cwd];
    const options = optionsOf(ctx);
    const configPath =
      ctx.configPath ??
      options.sgconfig ??
      (options.ruleDirs?.length ? generatedConfig(ctx) : kitSgconfig());
    // NOTE: ast-grep applies `--update-all` only WITHOUT `--json` (JSON mode is
    // report-only). So fix mode runs human-output + apply; read mode runs JSON.
    const args = ctx.fix
      ? [
          "scan",
          "-c",
          configPath,
          "--update-all",
          ...ruleFilterArgs(ctx),
          ...ctx.extraArgs,
          ...targets,
        ]
      : [
          "scan",
          "-c",
          configPath,
          "--json=stream",
          // A rule's `suppressedBy` (ast-grep 0.38.2).
          "--include-metadata",
          ...ruleFilterArgs(ctx),
          ...ctx.extraArgs,
          ...targets,
        ];
    return { bin: this.bin, args, okExitCodes: [0, 1] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // Fix mode drops `--json` (ast-grep applies `--update-all` only in human
    // output mode), so stdout is human text, not NDJSON. Parsing it as JSON
    // throws → a successful fix pass would be misreported as an INTERNAL crash.
    if (ctx.fix) {
      return {
        findings: [],
        filesProcessed: 0,
        fixesApplied: 0,
        rawExitCode: raw.exitCode,
        stderr: raw.stderr,
      };
    }
    const findings = [];
    for (const line of raw.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = parseJsonLine<AgMatch>("ast-grep", trimmed);
      if (suppressed(m)) continue;
      const file = absPosix(ctx.cwd, m.file);
      const lang = languageForFile(file);
      const start = m.range?.start;
      const end = m.range?.end;
      findings.push(
        finding({
          tool: "ast-grep",
          layer: "custom-rules",
          language: lang,
          file,
          line: (start?.line ?? 0) + 1,
          col: (start?.column ?? 0) + 1,
          ...(end ? { endLine: end.line + 1, endCol: end.column + 1 } : {}),
          ...(m.ruleId ? { ruleId: m.ruleId } : {}),
          severity: clampSeverity(m.severity),
          message: m.message ?? "ast-grep rule match",
          fixable: typeof m.replacement === "string",
        }),
      );
    }
    // Fail loud on a rule/config error: ast-grep exits non-zero with the error
    // on stderr and empty stdout. okExitCodes:[0,1] would otherwise route this
    // through as a clean run (a false CLEAN on the custom-rules layer).
    if (
      findings.length === 0 &&
      raw.exitCode !== 0 &&
      !raw.spawnError &&
      raw.stderr.trim()
    ) {
      const firstLine = raw.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      throw new Error(
        `ast-grep exited ${raw.exitCode} with no findings — possible rule/config error${firstLine ? `: ${firstLine}` : ""}`,
      );
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
