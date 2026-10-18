import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import {
  absPosix,
  byConfigFolder,
  finding,
  parseJsonLine,
  relativeFiles,
} from "./base.js";

/**
 * The config's `std` includes the Roblox library (`roblox`, `roblox+x`)
 * and it is not pinned to a committed roblox.yml: selene then fetches
 * Roblox's API dump from GitHub (`roblox-std-source`, default "floating").
 * A config that does not parse is selene's to report.
 */
function downloadsRoblox(path: string): boolean {
  let config: Record<string, unknown>;
  try {
    config = parseToml(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  return (
    typeof config.std === "string" &&
    config.std.split("+").includes("roblox") &&
    config["roblox-std-source"] !== "pinned"
  );
}

/** One line of `--display-style json2` (0.32.0). */
interface Json2Line {
  type?: unknown;
  severity?: unknown;
  code?: unknown;
  message?: unknown;
  primary_label?: {
    filename?: unknown;
    span?: { start_line?: unknown; start_column?: unknown };
    message?: unknown;
  };
}

/**
 * selene — the Lua linter: undefined and unused variables, shadowing, wrong
 * standard-library calls, at the level the project's `selene.toml` gives
 * each lint. Where the project chose it: a `selene.toml`, which selene reads
 * only from the folder it runs in, so each file runs from its nearest one's
 * folder; or `tools.selene.enabled` / `.configPath`. Its exit code is 1 for
 * findings and failures alike: the summary line and stderr tell them apart
 * (a bad config or a missing file prints only on stderr). A config whose
 * std would be downloaded (Roblox) cannot run: no network in a hook. No
 * fix. Recorded on 0.32.0:
 * docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md, 5.
 */
export const selene: ToolAdapter = {
  id: "selene",
  layer: "lint",
  languages: ["lua"],
  bin: "selene",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.32.0",
  installHint: "brew install selene  (or: cargo install selene)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId === "parse_error",

  expand(seed, env) {
    const tasks = byConfigFolder(seed, env, "lua", ["selene.toml"]);
    for (const task of tasks) {
      const config = env.toolConfig.configPath ?? join(task.cwd, "selene.toml");
      if (downloadsRoblox(config))
        task.cannotRun = `${config}: std includes roblox, which selene downloads (network): set \`roblox-std-source = "pinned"\` and commit the roblox.yml that \`selene generate-roblox-std\` writes`;
    }
    return tasks;
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(--display-style|--pattern)(=|$)/.test(arg))
      ? "the kit names the files and reads selene's json2 output"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--display-style",
        "json2",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        "--",
        ...relativeFiles(ctx, "selene"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A config it cannot read, a std it cannot find, a file it cannot open.
    const stderr = raw.stderr.trim();
    if (stderr) throw new Error(`selene failed: ${stderr.split("\n")[0]}`);
    const findings: Finding[] = [];
    let summary = false;
    for (const text of raw.stdout.split("\n")) {
      if (!text.trim()) continue;
      const item = parseJsonLine<Json2Line>("selene", text.trim());
      if (item.type === "Summary") {
        summary = true;
        continue;
      }
      const label = item.primary_label;
      const span = label?.span;
      if (
        item.type !== "Diagnostic" ||
        (item.severity !== "Error" && item.severity !== "Warning") ||
        typeof item.code !== "string" ||
        typeof item.message !== "string" ||
        typeof label?.filename !== "string" ||
        typeof span?.start_line !== "number" ||
        typeof span.start_column !== "number"
      )
        throw new Error(
          `selene printed a line that is not a diagnostic with a code, message, position and known severity (${JSON.stringify(item.severity)}): its output format may have changed; refusing to report it.`,
        );
      findings.push(
        finding({
          tool: "selene",
          layer: "lint",
          language: "lua",
          file: absPosix(ctx.cwd, label.filename),
          // 0-based.
          line: span.start_line + 1,
          col: span.start_column + 1,
          ruleId: item.code,
          severity: item.severity === "Error" ? "error" : "warning",
          message:
            typeof label.message === "string" && label.message
              ? `${item.message}: ${label.message}`
              : item.message,
          fixable: false,
        }),
      );
    }
    // Even a clean run prints its summary.
    if (!summary)
      throw new Error(
        `selene printed no summary line (exit ${raw.exitCode}): its output format may have changed; refusing to report it.`,
      );
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
