import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
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
import { absPosix, escapeRegex, finding, parseJsonLine } from "./base.js";
import { declaredAt } from "./cargo-machete.js";

interface Krate {
  name: string;
  version: string;
}

interface Graph {
  Krate?: Krate;
  parents?: Graph[];
}

interface DenyLine {
  type: string;
  fields?: {
    severity?: string;
    code?: string;
    message?: string;
    graphs?: Graph[];
    labels?: { message?: string; span?: string }[];
  };
}

/** Diagnostics about one crate depending on another, the [bans] rules. */
const EDGE = new Set(["banned", "unmatched-wrapper", "not-allowed"]);

/** The workspace's own crates: name to Cargo.toml (absolute). */
function workspaceCrates(root: string): Map<string, string> {
  const crates = new Map<string, string>();
  for (const manifest of globSync("**/Cargo.toml", {
    cwd: root,
    absolute: true,
    // Vendored and built crates are not the workspace's own.
    ignore: [
      "**/target/**",
      "**/vendor/**",
      "**/node_modules/**",
      "**/.cargo/**",
    ],
    followSymbolicLinks: false,
  })) {
    try {
      const doc = parseToml(readFileSync(manifest, "utf8")) as {
        package?: { name?: unknown };
      };
      if (typeof doc.package?.name === "string")
        crates.set(doc.package.name, manifest);
    } catch {
      // A manifest that does not parse names no crate.
    }
  }
  return crates;
}

/**
 * The line of `manifest` that depends on `crate`: its key, or a renamed
 * key's `package = "<crate>"`.
 */
function dependsAt(manifest: string, crate: string): number {
  const line = declaredAt(manifest, crate);
  if (line > 1) return line;
  try {
    const renamed = new RegExp(`package\\s*=\\s*"${escapeRegex(crate)}"`);
    const at = readFileSync(manifest, "utf8")
      .split("\n")
      .findIndex((text) => renamed.test(text));
    return at < 0 ? line : at + 1;
  } catch {
    return line;
  }
}

/**
 * The checks run when the project's own arguments name none. Advisories are
 * osv-scanner's (it reads the RustSec database, and the vulnAudit gate owns
 * the network fetch).
 */
const DEFAULT_CHECKS = ["bans", "licenses", "sources"];
const CHECKS = new Set([...DEFAULT_CHECKS, "advisories", "all"]);

/**
 * cargo-deny — the crate graph against the project's `deny.toml`: banned or
 * duplicated crates, licenses not allowed, registries and git sources not
 * trusted. Runs where a deny.toml is (`cargo deny init` writes one). Its
 * diagnostics carry no file name: a [bans] one (a layer rule: only the API
 * crate may use the database crate) is placed where a workspace crate
 * declares the banned one, the rest on the root Cargo.toml, naming the crate
 * (docs/research/lint-toolchain/layer-rules.md).
 */
export const cargoDeny: ToolAdapter = {
  id: "cargo-deny",
  layer: "security",
  languages: ["rust"],
  bin: "cargo-deny",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  minVersion: "0.16.0",
  installHint:
    "cargo install --locked cargo-deny  (or: brew install cargo-deny)",
  parseVersion: (out) => /cargo-deny\s+(\d+\.\d+\.\d+)/.exec(out)?.[1],
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["deny.toml", ".deny.toml", ".cargo/deny.toml"],
      step: /cargo[- ]deny/,
    }),

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^--(format|color)(=|$)/.test(arg)))
      return "--format and --color change the JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = ["--format", "json", "--color", "never"];
    if (ctx.configPath) args.push("check", "--config", ctx.configPath);
    else args.push("check");
    args.push(...ctx.extraArgs);
    if (!ctx.extraArgs.some((arg) => CHECKS.has(arg)))
      args.push(...DEFAULT_CHECKS);
    // Non-zero: one bit per check that failed (four checks).
    return {
      bin: this.bin,
      args,
      okExitCodes: Array.from({ length: 16 }, (_, i) => i),
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const manifest = absPosix(ctx.cwd, "Cargo.toml");
    let summary = false;
    const diagnostics: NonNullable<DenyLine["fields"]>[] = [];
    // The diagnostics are JSON lines on stderr, beside cargo's own text.
    for (const line of raw.stderr.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      const d = parseJsonLine<DenyLine>("cargo-deny", line.trim());
      if (d.type === "summary") summary = true;
      if (d.type === "diagnostic" && d.fields) diagnostics.push(d.fields);
    }
    // A [bans] finding goes on the line where one of the workspace's own
    // crates declares the crate: the parent an unmatched-wrapper names,
    // else the nearest workspace crate up the graph.
    let crates: Map<string, string> | undefined;
    const unwrapped = new Map<string, string>();
    const parentIn = (d: NonNullable<DenyLine["fields"]>) =>
      /direct parent '(\S+) = /.exec(d.message ?? "")?.[1];
    for (const d of diagnostics) {
      const parent = parentIn(d);
      const krate = d.graphs?.[0]?.Krate?.name;
      if (
        d.code === "unmatched-wrapper" &&
        parent &&
        krate &&
        !unwrapped.has(krate)
      )
        unwrapped.set(krate, parent);
    }
    const place = (d: NonNullable<DenyLine["fields"]>) => {
      const graph = d.graphs?.[0];
      const krate = graph?.Krate?.name;
      if (!graph || !krate || !d.code || !EDGE.has(d.code)) return undefined;
      crates ??= workspaceCrates(ctx.cwd);
      const named =
        d.code === "unmatched-wrapper" ? parentIn(d) : unwrapped.get(krate);
      const at = named ? crates.get(named) : undefined;
      if (at) return { file: at, line: dependsAt(at, krate) };
      // Breadth first up the graph: the first workspace crate, at its
      // dependency on the crate below it.
      let level = [{ node: graph, child: krate }];
      while (level.length > 0) {
        const next: typeof level = [];
        for (const { node, child } of level)
          for (const parent of node.parents ?? []) {
            const name = parent.Krate?.name;
            if (!name) continue;
            const own = crates.get(name);
            if (own) return { file: own, line: dependsAt(own, child) };
            next.push({ node: parent, child: name });
          }
        level = next;
      }
      return undefined;
    };
    const findings: Finding[] = [];
    for (const d of diagnostics) {
      const { severity, code, message, graphs, labels } = d;
      if (severity !== "error" && severity !== "warning") continue;
      const krate = graphs?.[0]?.Krate;
      // The deny.toml `reason` and `use-instead` say why and what to do;
      // the other labels only point.
      const reason = labels?.find((l) => l.message === "reason")?.span;
      const instead = labels?.find((l) => l.message === "use instead")?.span;
      const why =
        reason || instead
          ? [reason, instead ? `use ${instead} instead` : ""]
              .filter(Boolean)
              .join("; ")
          : (labels ?? [])
              .map((l) => l.message)
              .filter((m): m is string => Boolean(m))
              .join("; ");
      const at = place(d);
      findings.push(
        finding({
          tool: "cargo-deny",
          layer: "security",
          language: "rust",
          file: at ? absPosix(ctx.cwd, at.file) : manifest,
          line: at?.line ?? 1,
          col: 1,
          ...(code ? { ruleId: code } : {}),
          severity,
          message: [
            krate ? `${krate.name}@${krate.version}:` : "",
            message ?? code ?? "",
            why ? `(${why})` : "",
          ]
            .filter(Boolean)
            .join(" "),
          fixable: false,
        }),
      );
    }
    if (!summary)
      throw new Error(
        `cargo-deny printed no summary${raw.stderr.trim() ? `: ${raw.stderr.trim().split("\n").at(-1) ?? ""}` : ""}`,
      );
    if (raw.exitCode !== 0 && !findings.some((f) => f.severity === "error"))
      throw new Error(
        `cargo-deny exited ${raw.exitCode} without an error diagnostic`,
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
