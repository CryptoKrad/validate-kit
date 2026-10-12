import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";

interface Frame {
  module?: string;
  package?: string;
  function?: string;
  position?: { filename?: string; line?: number; column?: number };
}

interface Message {
  SBOM?: { roots?: string[] };
  osv?: { id: string; summary?: string; aliases?: string[] };
  finding?: { osv: string; fixed_version?: string; trace?: Frame[] };
}

/** The objects of a stream of concatenated (indented) JSON values. */
export function jsonStream<T>(text: string): T[] {
  const out: T[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && --depth === 0) {
      out.push(JSON.parse(text.slice(start, i + 1)) as T);
    }
  }
  if (depth !== 0)
    throw new Error(
      "govulncheck output ends inside a JSON value: refusing to report it.",
    );
  return out;
}

/**
 * govulncheck — the Go team's vulnerability check: it reports an advisory
 * only where the module's code can reach the vulnerable function, which
 * osv-scanner (lockfile versions only) cannot tell. Part of the vulnAudit
 * gate, so opt-in with it, and it needs network for vuln.go.dev. A module or
 * package that is only imported is osv-scanner's to report; here only a
 * reachable call gates, at the module's own line that starts the call.
 */
export const govulncheck: ToolAdapter = {
  id: "govulncheck",
  layer: "security",
  languages: ["go"],
  bin: "govulncheck",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  minVersion: "1.1.0",
  installHint: "go install golang.org/x/vuln/cmd/govulncheck@latest",
  versionArgs: ["-version"],
  parseVersion: (out) => /govulncheck@v(\d+\.\d+\.\d+)/.exec(out)?.[1],

  detect: (_detection, config) => config.vulnAudit.enabled,

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--?(format|json|scan|mode)(=|$)/.test(arg)))
      return "-format, -json, -scan and -mode change the symbol-level JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    // Exit 0 with or without findings under -format json; anything else is
    // a failure (no module, no network), which must not pass.
    return {
      bin: this.bin,
      args: ["-format", "json", ...ctx.extraArgs, "./..."],
      okExitCodes: [0],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const messages = jsonStream<Message>(raw.stdout);
    if (!messages.some((m) => m.SBOM))
      throw new Error(
        "govulncheck printed no SBOM: its output format may have changed; refusing to report it.",
      );
    const roots = new Set(messages.flatMap((m) => m.SBOM?.roots ?? []));
    const advisories = new Map(
      messages.flatMap((m) => (m.osv ? [[m.osv.id, m.osv] as const] : [])),
    );
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const { finding: f } of messages) {
      // Symbol level only: trace[0] names the vulnerable function.
      if (!f?.trace?.[0]?.function) continue;
      const call = f.trace.find(
        (frame) => frame.module !== undefined && roots.has(frame.module),
      );
      const at = call?.position;
      if (!at?.filename || !at.line) continue;
      const file = absPosix(ctx.cwd, at.filename);
      const key = `${f.osv}\0${file}\0${at.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const vuln = f.trace[0];
      const osv = advisories.get(f.osv);
      const aliases = osv?.aliases?.length
        ? ` (${osv.aliases.join(", ")})`
        : "";
      const fixed = f.fixed_version
        ? `; fixed in ${f.fixed_version}`
        : "; no fixed version";
      findings.push(
        finding({
          tool: "govulncheck",
          layer: "security",
          language: "go",
          file,
          line: at.line,
          col: at.column ?? 1,
          ruleId: f.osv,
          severity: "error",
          message: `calls ${vuln.package ?? vuln.module ?? "?"}.${vuln.function}: ${osv?.summary ?? f.osv}${aliases}${fixed}`,
          fixable: false,
          url: `https://pkg.go.dev/vuln/${f.osv}`,
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
