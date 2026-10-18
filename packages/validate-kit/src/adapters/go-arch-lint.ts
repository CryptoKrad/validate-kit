import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray, fromRealCwd } from "./base.js";
import { formatChanged } from "./mutation.js";

/** A place in a file; Line and Offset (the column) are 1-based numbers. */
interface Reference {
  Valid?: unknown;
  File?: unknown;
  Line?: unknown;
  Offset?: unknown;
}

interface DepWarning {
  ComponentName?: unknown;
  FileRelativePath?: unknown;
  ResolvedImportName?: unknown;
  Reference?: Reference;
}

interface DeepScanWarning {
  Gate?: { ComponentName?: unknown; MethodName?: unknown };
  Dependency?: {
    ComponentName?: unknown;
    Name?: unknown;
    Injection?: Reference;
  };
}

/**
 * go-arch-lint — the module's imports against the components and the
 * dependencies between them its `.go-arch-lint.yml` allows: a handler that
 * imports the repository layer directly, a file in no component, an
 * implementation from a component passed to one that may not depend on it
 * (deep scan). Each is an error at the import or the file; an arch file
 * with errors is a crash naming them, since it checked nothing. Where `.go-arch-lint.yml` is in the
 * module root (it does not look further up), the `deep` tier. Every failure
 * exits 1 and an error prints text, not JSON, even with `--json`: the JSON
 * tells findings from failures. Recorded on v1.19.0:
 * docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 7.
 */
export const goArchLint: ToolAdapter = {
  id: "go-arch-lint",
  layer: "lint",
  languages: ["go"],
  bin: "go-arch-lint",
  versionArgs: ["version"],
  parseVersion: (out) => /Linter version: \D*(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "1.19.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  installHint: "go install github.com/fe3dback/go-arch-lint@latest",
  adoptedAt: (root) => existsSync(join(root, ".go-arch-lint.yml")),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(json|output-json-one-line|output-color|output-type)(=|$)/.test(arg),
    )
      ? "the output flags are the kit's: it reads --json"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "check",
        "--json",
        ...(ctx.configPath ? ["--arch-file", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    let root: { Type?: unknown; Payload?: unknown } | undefined;
    try {
      root = JSON.parse(raw.stdout) as typeof root;
    } catch {
      root = undefined;
    }
    if (root?.Type !== "models.Check")
      throw new Error(
        `go-arch-lint failed: ${(raw.stderr || raw.stdout).trim().split("\n")[0] ?? ""}`,
      );
    const cwd = toPosix(ctx.cwd);
    // The JSON names real paths (/private/var on macOS).
    const own = fromRealCwd(cwd);
    const payload = root.Payload;
    // An arch file with errors checks nothing (the real imports go
    // unreported): a crash, never a finding a baseline could accept.
    const broken = findingsArray<Reference & { Text?: unknown }>(
      "go-arch-lint",
      payload,
      "ExecutionWarnings",
    );
    if (broken.length > 0)
      throw new Error(
        `go-arch-lint: the arch file has errors, so it checked nothing: ${broken
          .map(
            (w) =>
              `${typeof w.File === "string" && w.File ? `${posix.relative(cwd, own(toPosix(w.File)))}:${String(w.Line)}:${String(w.Offset)}: ` : ""}${String(w.Text)}`,
          )
          .join("; ")}`,
      );
    const place = (ref: Reference | undefined, fallback: string) =>
      ref?.Valid === true && typeof ref.File === "string"
        ? {
            file: own(toPosix(ref.File)),
            line: Number(ref.Line),
            col: Number(ref.Offset),
          }
        : { file: fallback, line: 1, col: 1 };
    const findings: Finding[] = [];
    const add = (
      at: { file: string; line: number; col: number },
      ruleId: string,
      message: string,
    ) =>
      findings.push(
        finding({
          tool: "go-arch-lint",
          layer: "lint",
          language: at.file.endsWith(".go") ? "go" : undefined,
          ...at,
          ruleId,
          severity: "error",
          message,
          fixable: false,
        }),
      );
    const archFile = ctx.configPath ?? absPosix(cwd, ".go-arch-lint.yml");
    for (const w of findingsArray<DepWarning>(
      "go-arch-lint",
      payload,
      "ArchWarningsDeps",
    ))
      add(
        place(w.Reference, `${cwd}${String(w.FileRelativePath)}`),
        "forbidden-dependency",
        `component ${String(w.ComponentName)} may not depend on ${String(w.ResolvedImportName)}: remove the import, or allow it under deps.${String(w.ComponentName)} in the arch file`,
      );
    for (const w of findingsArray<{ FileRelativePath?: unknown }>(
      "go-arch-lint",
      payload,
      "ArchWarningsNotMatched",
    ))
      add(
        { file: `${cwd}${String(w.FileRelativePath)}`, line: 1, col: 1 },
        "unmatched-file",
        "this file is in no component of the arch file: add its folder to one, or exclude it",
      );
    for (const w of findingsArray<DeepScanWarning>(
      "go-arch-lint",
      payload,
      "ArchWarningsDeepScan",
    )) {
      const gate = w.Gate;
      const dep = w.Dependency;
      add(
        place(dep?.Injection, archFile),
        "forbidden-injection",
        `${String(gate?.ComponentName)}.${String(gate?.MethodName)} is given ${String(dep?.Name)} from component ${String(dep?.ComponentName)}, which ${String(gate?.ComponentName)} may not depend on: pass an implementation from an allowed component, or allow the dependency in the arch file`,
      );
    }
    if (raw.exitCode !== 0 && findings.length === 0)
      throw formatChanged(
        "go-arch-lint",
        `exited ${raw.exitCode} with a report that names no warning`,
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
