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
import { finding, findingsArray, parseJsonOutput } from "./base.js";
import { formatChanged } from "./mutation.js";

interface Item {
  kind?: unknown;
  name?: unknown;
  hints?: unknown;
  location?: unknown;
  accessibility?: unknown;
}

/** `/abs/File.swift:8:6` */
const LOCATION = /^(.*):(\d+):(\d+)$/;

/** A kind's word for the message: `function.method.instance` → `method`. */
function nameOf(kind: string): string {
  const parts = kind.split(".");
  return parts[1] === "method"
    ? "method"
    : parts[0] === "function"
      ? "function"
      : (parts[0] ?? kind);
}

/**
 * periphery — Swift declarations nothing uses: a method, a free function, a
 * property only ever assigned, a protocol that could go. The usual leftover
 * of a refactor an agent half-finished. Public declarations are kept (a
 * library's API is used by its consumers), so it reports what the package
 * itself can never reach. Where a `Package.swift` is (a Swift package; an
 * Xcode project needs `tools.periphery.extraArgs` naming it), one task per
 * package, the `deep` tier: it builds the package with tests to index it.
 * periphery exits 0 whatever it finds unless `--strict`, so the kit reads
 * the JSON. Recorded on 3.8.0:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const periphery: ToolAdapter = {
  id: "periphery",
  layer: "lint",
  languages: ["swift"],
  bin: "periphery",
  versionArgs: ["version"],
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "3.0.0",
  installHint: "brew install periphery",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 900_000,
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["Package.swift", ".periphery.yml"],
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(?:format|strict|quiet)(=|$)/.test(arg))
      ? "--format, --strict and --quiet are the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "scan",
        "--format",
        "json",
        "--quiet",
        "--retain-public",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      // 0 whatever it finds; 1 a build it could not finish; 64 a usage error.
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const items = findingsArray<Item>(
      "periphery",
      parseJsonOutput<unknown>("periphery", raw, []),
    );
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = items.map((item) => {
      const at =
        typeof item.location === "string" ? LOCATION.exec(item.location) : null;
      if (typeof item.kind !== "string" || typeof item.name !== "string" || !at)
        throw formatChanged(
          "periphery",
          "reported a result without a kind, name or location",
        );
      const hints = Array.isArray(item.hints)
        ? item.hints.filter((h): h is string => typeof h === "string")
        : [];
      const hint = hints[0] ?? "unused";
      const path = toPosix(at[1] ?? "");
      return finding({
        tool: "periphery",
        layer: "lint",
        language: "swift",
        file: path.startsWith("/") ? path : `${cwd}/${path}`,
        line: Number(at[2]),
        col: Number(at[3]),
        ruleId: hint,
        severity: "warning",
        message:
          hint === "unused"
            ? `Unused ${nameOf(item.kind)} '${item.name}'`
            : `${hint}: ${nameOf(item.kind)} '${item.name}'`,
        fixable: false,
      });
    });
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
