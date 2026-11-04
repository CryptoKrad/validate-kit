import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { absPosix, finding, parseJsonOutput } from "./base.js";
import { formatChanged } from "./mutation.js";

interface Item {
  line?: unknown;
  type?: unknown;
  file?: unknown;
  variable?: unknown;
}

interface Report {
  findings?: {
    high_confidence?: Item[];
    medium_confidence?: Item[];
    low_confidence?: Item[];
  };
  total_findings?: unknown;
}

/** sobelow's confidence as the kit's weight: how sure it is, not how bad. */
const CONFIDENCE: [keyof NonNullable<Report["findings"]>, Severity][] = [
  ["high_confidence", "error"],
  ["medium_confidence", "warning"],
  ["low_confidence", "info"],
];

/**
 * sobelow — security findings in a Phoenix application: a path from the
 * request into `send_file` (traversal), `String.to_atom` on user input (the
 * atom table fills), raw HTML, a config that ships without CSRF or HTTPS.
 * credo is style and consistency; this is what an attacker reaches. Where a
 * mix.exs is and the project chose it: sobelow among its deps, a
 * `.sobelow-conf`, `tools.sobelow.enabled`, or a step. One task per Mix
 * root; each finding is reported at its line with the check as the rule
 * and sobelow's confidence as the severity (high an error, medium a
 * warning, low info). sobelow exits 0 whatever it finds unless `--exit`
 * says otherwise, so the kit reads the JSON. Recorded on 0.18.1:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const sobelow: ToolAdapter = {
  id: "sobelow",
  layer: "security",
  languages: ["elixir"],
  bin: "sobelow",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.13.0",
  installHint:
    'mix escript.install hex sobelow  (or: {:sobelow, "~> 0.18", only: [:dev, :test], runtime: false} in mix.exs)',
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  adoptedAt: (root, projectRoot) =>
    existsSync(join(root, ".sobelow-conf")) ||
    toolAdopted(root, projectRoot, {
      configs: [".sobelow-conf"],
      mix: "sobelow",
      step: /(?:^|[\s;&|"'(/])(?:mix\s+)?sobelow(?:\s|$)/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-f|--format|--exit|--compact|--quiet|--verbose)(=|$)/.test(arg),
    )
      ? "--format and --exit are the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--format",
        "json",
        ...(ctx.configPath ? ["--config"] : []),
        ...ctx.extraArgs,
      ],
      // 0 whatever it finds; 1 a usage error (no JSON).
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const report = parseJsonOutput<Report>("sobelow", raw, { findings: {} });
    if (report.findings === undefined || typeof report.findings !== "object")
      throw formatChanged("sobelow", "printed JSON without a findings object");
    const findings: Finding[] = [];
    for (const [key, severity] of CONFIDENCE) {
      const items = report.findings[key];
      if (items === undefined) continue;
      if (!Array.isArray(items))
        throw formatChanged("sobelow", `${key} is not an array`);
      for (const item of items) {
        if (
          typeof item.type !== "string" ||
          typeof item.file !== "string" ||
          typeof item.line !== "number"
        )
          throw formatChanged(
            "sobelow",
            "reported a finding without a type, file or line",
          );
        const [ruleId = item.type, ...rest] = item.type.split(": ");
        findings.push(
          finding({
            tool: "sobelow",
            layer: "security",
            language: "elixir",
            file: absPosix(cwd, item.file),
            line: item.line,
            col: 1,
            ruleId,
            severity,
            message: `${rest.join(": ") || item.type}${typeof item.variable === "string" && item.variable !== "" ? ` (from \`${item.variable}\`)` : ""}`,
            fixable: false,
            url: `https://hexdocs.pm/sobelow/Sobelow.${ruleId}.html`,
          }),
        );
      }
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
