import { readFileSync } from "node:fs";
import { globSync } from "tinyglobby";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, escapeRegex, finding } from "./base.js";

/** `<crate> -- <path>/Cargo.toml:`, then one `\t<dependency>` line each. */
const CRATE = /^(\S+) -- (.+Cargo\.toml):$/;

/**
 * A Cargo.toml table of cargo-machete's own (its `ignored` list), at the
 * root or in a crate under it: a workspace runs as one task from its root.
 */
function tableIn(root: string): boolean {
  return globSync("**/Cargo.toml", {
    cwd: root,
    absolute: true,
    ignore: ["**/target/**", "**/node_modules/**"],
    followSymbolicLinks: false,
  }).some((manifest) => {
    try {
      return /^\s*\[(?:package|workspace)\.metadata\.cargo-machete\]/m.test(
        readFileSync(manifest, "utf8"),
      );
    } catch {
      return false;
    }
  });
}

/**
 * The line of a Cargo.toml that declares `dependency`: in a dependencies
 * table (`[dependencies]`, `[dev-dependencies]`, a target's), or its own
 * `[dependencies.<name>]` header; a `[features]` key of the same name is not
 * it.
 */
export function declaredAt(manifest: string, dependency: string): number {
  try {
    const lines = readFileSync(manifest, "utf8").split("\n");
    const name = escapeRegex(dependency);
    const key = new RegExp(`^\\s*["']?${name}["']?\\s*[=.]`);
    const header = new RegExp(
      `^\\s*\\[(?:[^\\]]*\\.)?(?:dev-|build-)?dependencies\\.${name}\\]`,
    );
    let table = "";
    for (const [i, line] of lines.entries()) {
      const opened = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
      if (opened !== undefined) {
        if (header.test(line)) return i + 1;
        table = opened;
      } else if (table.trim().endsWith("dependencies") && key.test(line))
        return i + 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * cargo-machete — Rust dependencies a crate declares and never uses: each
 * one is compile time, download size and supply-chain surface for nothing.
 * It reads the source, so it is fast and needs no build, but a macro that
 * uses a crate it cannot see is a false positive: list those under
 * `[package.metadata.cargo-machete] ignored`. Where the project chose it:
 * that table, `tools.cargo-machete.enabled`, or a step that runs it.
 * Recorded on 0.9.2 (text output only):
 * docs/research/lint-toolchain/hygiene-adapters.md.
 */
export const cargoMachete: ToolAdapter = {
  id: "cargo-machete",
  layer: "lint",
  languages: ["rust"],
  bin: "cargo-machete",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  minVersion: "0.9.0",
  installHint: "cargo install --locked cargo-machete",
  findingExitCodes: [1],
  adoptedAt: (root, projectRoot) =>
    tableIn(root) ||
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /(?:^|[\s;&|"'(/])cargo[ -]machete(?:\s|$)|\/cargo-machete@/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(fix|with-metadata)$/.test(arg))
      ? "--fix rewrites Cargo.toml and --with-metadata may rewrite Cargo.lock"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["--skip-target-dir", ...ctx.extraArgs, "."],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    let manifest: string | undefined;
    for (const line of raw.stdout.split(/\r?\n/)) {
      const crate = CRATE.exec(line);
      if (crate?.[2]) {
        manifest = absPosix(cwd, crate[2]);
        continue;
      }
      const dependency = /^\t(\S+)$/.exec(line)?.[1];
      if (dependency && manifest)
        findings.push(
          finding({
            tool: "cargo-machete",
            layer: "lint",
            language: "rust",
            file: manifest,
            line: declaredAt(manifest, dependency),
            col: 1,
            ruleId: "unused-dependency",
            severity: "warning",
            message: `\`${dependency}\` is a dependency nothing in the crate uses`,
            fixable: false,
          }),
        );
      else if (line.trim() === "") manifest = undefined;
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
