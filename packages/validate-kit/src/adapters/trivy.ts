import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
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
import { languageForFile, toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray } from "./base.js";
import { changedAny, scopeOf, stage } from "./schemas-iac.js";

interface TrivyMisconfiguration {
  ID?: unknown;
  Title?: unknown;
  Message?: unknown;
  Resolution?: unknown;
  Severity?: unknown;
  Status?: unknown;
  PrimaryURL?: unknown;
  CauseMetadata?: { StartLine?: unknown; EndLine?: unknown };
}

interface TrivyResult {
  Target?: unknown;
  Type?: unknown;
  Misconfigurations?: unknown;
}

interface TrivyTask {
  /** The scope's files trivy reads, relative to the project root. */
  scope: string[];
}

const SEVERITY: Record<string, Severity> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  UNKNOWN: "warning",
  LOW: "info",
};

/** A proxy that refuses every connection: a remote module fails at once. */
const NO_PROXY = "http://127.0.0.1:9";

/**
 * What trivy config reads: Dockerfiles, Terraform, Kubernetes and Helm
 * YAML, CloudFormation and ARM JSON, and its own config and ignore file.
 */
function input(path: string): boolean {
  const language = languageForFile(path);
  return (
    language === "dockerfile" ||
    language === "terraform" ||
    language === "yaml" ||
    /\.(?:json|tpl)$/.test(path) ||
    basename(path) === ".trivyignore"
  );
}

/**
 * The file's own line for trivy's `line` in a multi-document YAML file:
 * trivy counts the lines without the `---` separators, so a finding in the
 * second document came out one line high, in the third two.
 */
function realLine(lines: readonly string[] | undefined, line: number): number {
  if (lines === undefined) return line;
  let counted = 0;
  for (const [index, text] of lines.entries()) {
    if (/^---(?:\s|$)/.test(text)) continue;
    counted++;
    if (counted === line) return index + 1;
  }
  return line;
}

/**
 * trivy config — infrastructure misconfigurations: a container that runs as
 * root or privileged, an S3 bucket without encryption or versioning, a
 * security group open to the world, in Dockerfiles, Terraform, Kubernetes,
 * Helm, CloudFormation and ARM. Each failed check at its file and line (a
 * whole-file Dockerfile rule at line 1); CRITICAL and HIGH are errors,
 * MEDIUM warnings, LOW info (`--severity` in extraArgs narrows it). Where
 * the project chose it: a `trivy.yaml` at the root, or
 * `tools.trivy.enabled`. No network: `--skip-check-update`, and
 * `--disable-telemetry` (`--skip-version-check` alone still pinged
 * check.trivy.dev); remote Terraform modules go through a proxy that
 * refuses, and git may clone only local repositories. With no checks
 * bundle cached it uses the checks built into trivy (an ERROR line on its
 * stderr, the same findings). It reads a copy of the kit's scope, not the
 * tree (45 s on this repository, most of it node_modules): verify tier.
 * Recorded on 0.69.3:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 6.
 */
export const trivy: ToolAdapter = {
  id: "trivy",
  layer: "security",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "trivy",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "verify",
  minVersion: "0.69.3",
  installHint: "brew install trivy",
  parseVersion: (out) => /Version: (\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      existsSync(join(env.projectRoot, "trivy.yaml"));
    if (!chosen) return [];
    const scope = scopeOf(env, input);
    if (scope.length === 0 || !changedAny(env, input)) return [];
    const task: TrivyTask = { scope };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(-f|--format|--exit-code|-o|--output|--template|--include-non-failures)(=|$)/.test(
        arg,
      ),
    )
      ? "the kit reads trivy's JSON report of failed checks on stdout, and its exit code"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "config",
        "--format",
        "json",
        "--exit-code",
        "1",
        "--skip-check-update",
        "--skip-version-check",
        "--disable-telemetry",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        // Its config and ignore file are still read from here, the project.
        stage(ctx, (ctx.options as TrivyTask).scope),
      ],
      env: {
        HTTPS_PROXY: NO_PROXY,
        HTTP_PROXY: NO_PROXY,
        https_proxy: NO_PROXY,
        http_proxy: NO_PROXY,
        // trivy clones a git:: module with git, which ignored the proxy.
        GIT_ALLOW_PROTOCOL: "file",
      },
      // 1: misconfigurations found, and every fatal error (no report then).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (!raw.stdout.trim()) {
      const lines = raw.stderr.split(/\r?\n/);
      throw new Error(
        `trivy produced no report on exit ${raw.exitCode}: ${lines.find((line) => /\bFATAL\b/.test(line))?.trim() ?? lines.find(Boolean)?.trim() ?? "no message"}`,
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(raw.stdout);
    } catch (err) {
      throw new Error(
        `trivy produced invalid JSON output: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // A project with nothing to scan has no Results key.
    const results = findingsArray<TrivyResult>("trivy", report, "Results", {
      absentIsNone: true,
    });
    const scope = new Set((ctx.options as TrivyTask).scope);
    const findings: Finding[] = [];
    let failed = 0;
    for (const result of results) {
      if (result.Misconfigurations === undefined) continue;
      if (typeof result.Target !== "string")
        throw new Error(
          "trivy reported misconfigurations without a target: its output format may have changed; refusing to report them.",
        );
      const path = posix.normalize(toPosix(result.Target));
      const file = absPosix(ctx.cwd, path);
      let lines: string[] | undefined;
      if (result.Type === "kubernetes")
        try {
          lines = readFileSync(file, "utf8").split(/\r?\n/);
        } catch {
          lines = undefined;
        }
      for (const m of findingsArray<TrivyMisconfiguration>(
        "trivy",
        result.Misconfigurations,
      )) {
        const severity =
          typeof m.Severity === "string" ? SEVERITY[m.Severity] : undefined;
        if (
          typeof m.ID !== "string" ||
          typeof m.Title !== "string" ||
          typeof m.Status !== "string" ||
          severity === undefined
        )
          throw new Error(
            `trivy reported a misconfiguration without an ID, title, status or known severity (${JSON.stringify(m.Severity)}): its output format may have changed; refusing to report it.`,
          );
        // A check that passed (`include-non-failures` in trivy.yaml).
        if (m.Status !== "FAIL") continue;
        failed++;
        // A file the kit's scope leaves out (a remote module).
        if (!scope.has(path)) continue;
        const start = m.CauseMetadata?.StartLine;
        const end = m.CauseMetadata?.EndLine;
        findings.push(
          finding({
            tool: "trivy",
            layer: "security",
            language: languageForFile(file),
            file,
            // Whole-file rules (a Dockerfile with no USER) have no lines.
            line: typeof start === "number" ? realLine(lines, start) : 1,
            col: 1,
            ...(typeof end === "number"
              ? { endLine: realLine(lines, end) }
              : {}),
            ruleId: m.ID,
            severity,
            message: [
              m.Title,
              typeof m.Message === "string"
                ? `: ${m.Message.replace(/\.+$/, "")}`
                : "",
              typeof m.Resolution === "string" ? `. ${m.Resolution}` : "",
            ].join(""),
            fixable: false,
            ...(typeof m.PrimaryURL === "string" ? { url: m.PrimaryURL } : {}),
          }),
        );
      }
    }
    // Checked before the scope drops any.
    if (raw.exitCode === 1 && failed === 0)
      throw new Error(
        "trivy exited 1, which means it found misconfigurations, but its report holds no failed check: its output format may have changed; refusing to report it.",
      );
    return {
      findings,
      filesProcessed: scope.size,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
