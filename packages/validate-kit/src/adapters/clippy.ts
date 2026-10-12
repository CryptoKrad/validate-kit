import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, clampSeverity, finding, parseJsonLine } from "./base.js";

interface CargoSpan {
  file_name: string;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  is_primary: boolean;
  suggested_replacement?: string | null;
}
interface CargoMessage {
  reason: string;
  message?: {
    level: string;
    message: string;
    code?: { code: string } | null;
    spans?: CargoSpan[];
  };
}

/** clippy — Rust linter. Crate-scoped (ignores explicit file lists). */
export const clippy: ToolAdapter = {
  id: "clippy",
  layer: "lint",
  languages: ["rust"],
  bin: "cargo",
  // A rustc error (the crate does not compile) stops clippy's lints.
  masks: (f) =>
    f.severity === "error" && !(f.ruleId ?? "").startsWith("clippy::"),
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  minVersion: "0.1.0",
  installHint: "rustup component add clippy",
  versionArgs: ["clippy", "--version"],
  parseVersion: (out) => /clippy\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Warm-cache runs are safe: cargo replays cached diagnostics verbatim as
    // compiler-message JSON (verified on clippy 0.1.96; pinned by the warm-run
    // canary in polyglot.test.ts — see sota-clippy-warm-cache-full.md).
    // Caveats if extraArgs ever adds flags: `--no-deps` filtering is bypassed
    // on cached replay (rust-clippy#13983 — prefer `-p <crate>`), and
    // `--all-targets` can duplicate diagnostics (cargo#15741 — the runner's
    // dedupe() already drops those).
    const args = [
      "clippy",
      "--message-format=json",
      "--quiet",
      ...ctx.extraArgs,
    ];
    return { bin: this.bin, args, okExitCodes: [0, 1, 101] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings = [];
    for (const line of raw.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      const obj = parseJsonLine<CargoMessage>("clippy", trimmed);
      const msg = obj.message;
      if (obj.reason !== "compiler-message" || !msg) continue;
      if (msg.level !== "warning" && msg.level !== "error") continue;
      if (!msg.spans || msg.spans.length === 0) continue;
      const span = msg.spans.find((s) => s.is_primary) ?? msg.spans[0];
      if (!span) continue;
      findings.push(
        finding({
          tool: "clippy",
          layer: "lint",
          language: "rust",
          file: absPosix(ctx.cwd, span.file_name),
          line: span.line_start,
          col: span.column_start,
          endLine: span.line_end,
          endCol: span.column_end,
          ...(msg.code?.code ? { ruleId: msg.code.code } : {}),
          severity: clampSeverity(msg.level),
          message: msg.message.split("\n")[0] ?? msg.message,
          fixable: msg.spans.some(
            (s) => typeof s.suggested_replacement === "string",
          ),
        }),
      );
    }
    if (raw.exitCode !== 0 && findings.length === 0) {
      const firstLine = `${raw.stdout}\n${raw.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      throw new Error(
        `clippy failed without diagnostic JSON output${firstLine ? `: ${firstLine}` : ""}`,
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
