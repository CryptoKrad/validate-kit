import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted, upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray, scratchOf } from "./base.js";

interface AderynInstance {
  contract_path?: unknown;
  line_no?: unknown;
  src?: unknown;
}

interface AderynIssue {
  title?: unknown;
  description?: unknown;
  detector_name?: unknown;
  instances?: unknown;
}

interface AderynTask {
  /** Files whose findings count (absolute, POSIX): the kit's scope. */
  scope: string[];
  /**
   * What its paths are relative to: the `root` its aderyn.toml names, else
   * where it runs.
   */
  base: string;
}

/** The `root` an aderyn.toml in `dir` names (default `.`), absolute. */
function rootOf(dir: string): string {
  let root: unknown;
  try {
    root = parseToml(readFileSync(join(dir, "aderyn.toml"), "utf8")).root;
  } catch {
    // aderyn itself reports a broken aderyn.toml
  }
  return absPosix(dir, typeof root === "string" ? root : ".");
}

const REPORT = "aderyn-report.json";

/**
 * The 1-based column of byte `offset` of `bytes` (aderyn's `src` is
 * `byteOffset:byteLength`).
 */
function columnOf(bytes: Buffer, offset: number): number {
  if (offset <= 0) return 1;
  const start = bytes.lastIndexOf(0x0a, offset - 1) + 1;
  return bytes.subarray(start, offset).toString().length + 1;
}

/**
 * aderyn — Cyfrin's Solidity static analyzer (88 detectors): `tx.origin`
 * used for authorization, unsafe ERC20 calls, state that could be immutable,
 * centralization risks. It compiles the whole project with the solc each
 * pragma asks for, and DOWNLOADS that solc into `~/.svm` the first time a
 * version is missing (network), hence the `deep` tier (the `ci` profile),
 * never a hook. Opt-in: `tools.aderyn.enabled` or an `aderyn.toml`
 * (`aderyn init`) at or above a Foundry/Hardhat root (it compiles through
 * one, with its remappings). Runs, when a `.sol` file changed, from that
 * aderyn.toml's folder (where aderyn reads it) or the root; its report goes
 * to the scratch folder (by default it writes `report.md` into the
 * project), and it exits 0 with issues, so the report is the verdict. High
 * issues are errors, low ones warnings, each at the file its aderyn.toml
 * `root` makes it relative to; findings outside the kit's scope are
 * dropped. Recorded on 0.6.8:
 * docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, 6.
 */
export const aderyn: ToolAdapter = {
  id: "aderyn",
  layer: "security",
  languages: ["solidity"],
  bin: "aderyn",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  minVersion: "0.6.8",
  installHint: "pnpm add -D @cyfrin/aderyn  (or: npm i -g @cyfrin/aderyn)",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, { configs: ["aderyn.toml"] }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // shortcut: two Foundry roots under one aderyn.toml run it twice (the
    // runner drops the repeated findings); plan it once if that is slow.
    const dir = upTo(seed.cwd, env.projectRoot).find((d) =>
      existsSync(join(d, "aderyn.toml")),
    );
    const cwd = dir === undefined ? seed.cwd : toPosix(dir);
    const task: AderynTask = {
      scope: [...env.scopedFiles],
      base: dir === undefined ? cwd : rootOf(cwd),
    };
    return [{ ...seed, cwd, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-o|--output|--stdout|-l|--lsp)(=|$)/.test(arg))
      ? "the kit reads aderyn's JSON report from its own scratch folder; --output, --stdout and --lsp change that"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: ["--output", join(scratchOf(ctx), REPORT), ...ctx.extraArgs, "."],
      // 1: no Solidity in its scope (parseOutput), or a crash.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const empty = {
      findings: [],
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
    if (raw.exitCode === 1) {
      // Every .sol file it was given is in a folder it skips (lib, test, script).
      if (raw.stderr.includes("No solidity files found in given scope"))
        return empty;
      throw new Error(
        `aderyn failed: ${raw.stderr.trim().split("\n")[0] || "no output"}`,
      );
    }
    const path = join(scratchOf(ctx), REPORT);
    if (!existsSync(path))
      throw new Error(
        `aderyn exited ${raw.exitCode} without writing its report: its output may have changed; refusing to report zero findings.`,
      );
    const report = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    // 0.6.8 has two buckets: a third would be issues the kit never reads.
    const other = Object.keys(report).find(
      (key) =>
        key.endsWith("_issues") &&
        key !== "high_issues" &&
        key !== "low_issues",
    );
    if (other)
      throw new Error(
        `aderyn's report has ${other}, which the kit does not read: its output format may have changed; refusing to report it.`,
      );
    const { scope: inScope, base } = ctx.options as AderynTask;
    const scope = new Set(inScope);
    const sources = new Map<string, Buffer>();
    const findings: Finding[] = [];
    for (const [bucket, severity] of [
      ["high_issues", "error"],
      ["low_issues", "warning"],
    ] as const) {
      for (const issue of findingsArray<AderynIssue>(
        "aderyn",
        report[bucket],
        "issues",
      )) {
        if (
          typeof issue.title !== "string" ||
          typeof issue.detector_name !== "string"
        )
          throw new Error(
            "aderyn reported an issue without a title or detector: its output format may have changed; refusing to report it.",
          );
        for (const at of findingsArray<AderynInstance>(
          "aderyn",
          issue,
          "instances",
        )) {
          if (
            typeof at.contract_path !== "string" ||
            typeof at.line_no !== "number"
          )
            throw new Error(
              "aderyn reported an instance without a file or line: its output format may have changed; refusing to report it.",
            );
          const file = absPosix(base, at.contract_path);
          if (!sources.has(file)) {
            if (!existsSync(file))
              throw new Error(
                `aderyn reported ${at.contract_path}, which is not at ${file}: the kit read its paths against the wrong root; refusing to drop the finding.`,
              );
            sources.set(file, readFileSync(file));
          }
          if (!scope.has(file)) continue;
          const bytes = sources.get(file);
          const offset =
            typeof at.src === "string" ? Number(at.src.split(":")[0]) : NaN;
          findings.push(
            finding({
              tool: "aderyn",
              layer: "security",
              language: "solidity",
              file,
              line: at.line_no,
              col:
                bytes && Number.isInteger(offset) ? columnOf(bytes, offset) : 1,
              ruleId: issue.detector_name,
              severity,
              message:
                typeof issue.description === "string"
                  ? `${issue.title}: ${issue.description}`
                  : issue.title,
              fixable: false,
            }),
          );
        }
      }
    }
    return { ...empty, findings };
  },
};
