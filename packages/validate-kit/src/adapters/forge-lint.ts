import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  Severity,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { formatChanged } from "./mutation.js";

/** One line of `forge lint --json`: a rustc-style diagnostic. */
interface Diagnostic {
  $message_type?: unknown;
  message?: unknown;
  code?: { code?: unknown } | null;
  level?: unknown;
  spans?: {
    file_name?: unknown;
    line_start?: unknown;
    column_start?: unknown;
    line_end?: unknown;
    column_end?: unknown;
    is_primary?: unknown;
  }[];
  children?: { message?: unknown; level?: unknown }[];
}

/** forge's levels: `error`, `warning`, `note` (its info and gas lints). */
const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  note: "info",
};

/**
 * forge lint — Foundry's own Solidity linter, in the binary forge-fmt already
 * drives: an incorrect shift, a divide before a multiply, an unchecked call,
 * a name that breaks the style the project set, gas patterns. Where a
 * `foundry.toml` is (the project's `[lint]` table chooses the severities and
 * the lints, as forge reads it), one task per Foundry root. Each diagnostic
 * is a finding at its primary span; forge's `note` is the kit's info. forge
 * exits 0 whatever it finds unless `--deny` says otherwise, so the kit reads
 * the JSON, not the exit code. Recorded on 1.8.5:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const forgeLint: ToolAdapter = {
  id: "forge-lint",
  layer: "lint",
  languages: ["solidity"],
  bin: "forge",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // `forge lint` arrived in 1.3; `--json` and `--deny` as recorded in 1.8.5.
  minVersion: "1.8.0",
  installHint:
    "brew install foundry  (or: curl -L https://foundry.paradigm.xyz | bash; foundryup)",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, { configs: ["foundry.toml"] }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(?:--json|--deny|-D|--format)(=|$)/.test(arg))
      ? "--json is the kit's, and --deny would turn its notes into a failed build"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["lint", "--json", ...ctx.extraArgs],
      // 0 whatever it finds; 1 a file it cannot read; 2 a usage error.
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    for (const line of raw.stdout.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let item: Diagnostic;
      try {
        item = JSON.parse(line) as Diagnostic;
      } catch {
        throw formatChanged(
          "forge lint",
          `printed a line that is not JSON: ${line.slice(0, 80)}`,
        );
      }
      if (item.$message_type !== "diagnostic") continue;
      const span =
        item.spans?.find((s) => s.is_primary === true) ?? item.spans?.[0];
      const code = item.code?.code;
      if (
        typeof item.message !== "string" ||
        typeof code !== "string" ||
        typeof span?.file_name !== "string" ||
        typeof span.line_start !== "number" ||
        typeof span.column_start !== "number"
      )
        throw formatChanged(
          "forge lint",
          "reported a diagnostic without a message, code, file or position",
        );
      const url = item.children?.find(
        (c) =>
          typeof c.message === "string" && c.message.startsWith("https://"),
      )?.message;
      findings.push(
        finding({
          tool: "forge-lint",
          layer: "lint",
          language: "solidity",
          file: absPosix(cwd, span.file_name),
          line: span.line_start,
          col: span.column_start,
          ...(typeof span.line_end === "number" &&
          typeof span.column_end === "number"
            ? { endLine: span.line_end, endCol: span.column_end }
            : {}),
          ruleId: code,
          severity:
            (typeof item.level === "string"
              ? SEVERITY[item.level]
              : undefined) ?? "warning",
          message: item.message,
          fixable: false,
          ...(typeof url === "string" ? { url } : {}),
        }),
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
