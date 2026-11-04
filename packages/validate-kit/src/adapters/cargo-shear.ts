import { readFileSync } from "node:fs";
import { globSync } from "tinyglobby";
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
import { absPosix, finding, findingsArray, parseJsonOutput } from "./base.js";
import { declaredAt } from "./cargo-machete.js";
import { formatChanged } from "./mutation.js";

interface Item {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  file?: unknown;
  location?: { offset?: unknown };
  help?: unknown;
}

interface Report {
  findings?: Item[];
}

/** A Cargo.toml table of cargo-shear's own, at the root or in a crate. */
function tableIn(root: string): boolean {
  return globSync("**/Cargo.toml", {
    cwd: root,
    absolute: true,
    ignore: ["**/target/**", "**/node_modules/**"],
    followSymbolicLinks: false,
  }).some((manifest) => {
    try {
      return /^\s*\[(?:package|workspace)\.metadata\.cargo-shear\]/m.test(
        readFileSync(manifest, "utf8"),
      );
    } catch {
      return false;
    }
  });
}

/** The 1-based line a byte offset falls on, 1 when the file is unreadable. */
function lineAt(file: string, offset: number): number {
  try {
    const text = readFileSync(file);
    let line = 1;
    for (let i = 0; i < Math.min(offset, text.length); i++)
      if (text[i] === 0x0a) line += 1;
    return line;
  } catch {
    return 1;
  }
}

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
};

/**
 * cargo-shear — Cargo dependencies a crate declares and never uses, a
 * dependency in the wrong table, and a Rust file no module reaches (the
 * orphan an agent leaves after a move). It parses the source with
 * rust-analyzer's parser, so it needs no build, but it runs `cargo metadata`,
 * which writes Cargo.lock and may read the network: the `verify` tier.
 * Where the project chose it: a `[package.metadata.cargo-shear]` or
 * `[workspace.metadata.cargo-shear]` table, `tools.cargo-shear.enabled`, or
 * a step that runs it. One task per crate or workspace root. Recorded on
 * 1.14.0: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const cargoShear: ToolAdapter = {
  id: "cargo-shear",
  layer: "lint",
  languages: ["rust"],
  bin: "cargo-shear",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "1.0.0",
  installHint:
    "brew install cargo-shear  (or: cargo install --locked cargo-shear)",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "verify",
  findingExitCodes: [1],
  adoptedAt: (root, projectRoot) =>
    tableIn(root) ||
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /(?:^|[\s;&|"'(/])cargo[ -]shear(?:\s|$)|\/cargo-shear@/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(?:fix|format|expand)(=|$)/.test(arg))
      ? "--format is the kit's; --fix rewrites Cargo.toml; --expand needs nightly"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["--format=json", ...ctx.extraArgs],
      // 1: findings (a usage error shares it; that leaves no JSON).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const report = parseJsonOutput<Report>("cargo-shear", raw, {
      findings: [],
    });
    const items = findingsArray<Item>("cargo-shear", report.findings ?? []);
    if (raw.exitCode === 1 && items.length === 0)
      throw formatChanged(
        "cargo-shear",
        "exited 1 with no finding in its JSON",
      );
    const findings: Finding[] = [];
    for (const item of items) {
      if (typeof item.code !== "string" || typeof item.message !== "string")
        throw formatChanged(
          "cargo-shear",
          "reported a finding without a code or message",
        );
      const code = item.code;
      const severity =
        (typeof item.severity === "string"
          ? SEVERITY[item.severity]
          : undefined) ?? "warning";
      const help = typeof item.help === "string" ? `: ${item.help}` : "";
      const at = (file: string, line: number, message: string) =>
        findings.push(
          finding({
            tool: "cargo-shear",
            layer: "lint",
            language: "rust",
            file,
            line,
            col: 1,
            ruleId: code.replace(/^shear\//, ""),
            severity,
            message,
            fixable: false,
          }),
        );
      const [first = "", ...rest] = item.message.split("\n");
      if (code === "shear/unlinked_files") {
        // The files follow the first line; none is in `file`.
        for (const path of rest.filter((p) => p.trim() !== ""))
          at(
            absPosix(cwd, path.trim()),
            1,
            `no module reaches this file${help}`,
          );
        continue;
      }
      const manifest = absPosix(
        cwd,
        typeof item.file === "string" ? item.file : "Cargo.toml",
      );
      const dependency = /`([^`]+)`/.exec(first)?.[1];
      const line =
        typeof item.location?.offset === "number"
          ? lineAt(manifest, item.location.offset)
          : dependency
            ? declaredAt(manifest, dependency)
            : 1;
      at(manifest, line, `${first}${help}`);
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
