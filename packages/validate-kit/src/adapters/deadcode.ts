import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding, findingsArray } from "./base.js";
import { outsideWorkspace } from "./golangci.js";

/** One package of `deadcode -json` (docs/research/lint-toolchain/go-deadcode.md, 1). */
interface DeadPackage {
  Funcs?: {
    Name?: unknown;
    Position?: { File?: unknown; Line?: unknown; Col?: unknown };
  }[];
}

interface DeadcodeTask {
  outsideWorkspace?: true;
  /** Files whose findings count (absolute, POSIX): the kit's scope. */
  scope: string[];
}

/**
 * Go's deadcode — functions no main package can reach. A whole-program
 * analysis a file subset cannot scope, using up to 1.6 GB, whose findings
 * need judgement: the `deep` tier, under the `ci` profile only.
 */
export const deadcode: ToolAdapter = {
  id: "deadcode",
  layer: "lint",
  languages: ["go"],
  bin: "deadcode",
  // It has no version flag (`go version -m` names it): its -h runs, and no
  // minimum can be checked. 0.39.0 or later suppresses marker methods.
  versionArgs: ["-h"],
  minVersion: "0.0.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  installHint:
    "go install golang.org/x/tools/cmd/deadcode@latest  (Go 1.25: @v0.49.0)",
  parseVersion: () => undefined,
  // No config file of its own: chosen in the kit's config or a step that
  // runs it (not golangci-lint's old linter of the same name).
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /x\/tools\/cmd\/deadcode|(?:^|[\s;&|"'(])deadcode(?:\s+-\S+)*\s+\.\.?\//m,
    }),

  async expand(seed: TaskSeed, env: PlanEnv): Promise<TaskSeed[]> {
    const task: DeadcodeTask = {
      scope: [...env.scopedFiles],
      ...((await outsideWorkspace(seed.cwd))
        ? { outsideWorkspace: true as const }
        : {}),
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    if (extraArgs.some((arg) => /^-(-)?(f|whylive)(=|$)/.test(arg)))
      return "-f and -whylive replace the JSON the kit reads";
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as DeadcodeTask | undefined;
    return {
      bin: this.bin,
      args: ["-json", ...ctx.extraArgs, "./..."],
      // Exit 0 whether or not it finds dead code; 1 on errors.
      okExitCodes: [0, 1],
      ...(task?.outsideWorkspace ? { env: { GOWORK: "off" } } : {}),
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const result = (findings: RunResult["findings"]): RunResult => ({
      findings,
      filesProcessed: (ctx.options as DeadcodeTask).scope.filter(
        (file) => file.endsWith(".go") && isUnder(file, toPosix(ctx.cwd)),
      ).length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    if (raw.exitCode === 1) {
      const last = raw.stderr
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith("deadcode: "));
      // A library module: no main package, nothing to reach from.
      if (last === "deadcode: no main packages") return result([]);
      throw new Error(last ?? `deadcode failed: ${raw.stderr.trim()}`);
    }
    const task = ctx.options as DeadcodeTask;
    const scope = new Set(task.scope);
    const cwd = toPosix(ctx.cwd);
    // A nested module's functions belong to its own run, judged from its own
    // mains (go-deadcode.md, 4).
    const nested = new Map<string, boolean>();
    const inNested = (file: string): boolean => {
      for (let dir = dirname(file); dir !== cwd && isUnder(dir, cwd);) {
        if (!nested.has(dir)) nested.set(dir, existsSync(join(dir, "go.mod")));
        if (nested.get(dir)) return true;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return false;
    };
    // A clean run prints `null`.
    const packages =
      raw.stdout.trim() === "null"
        ? []
        : findingsArray<DeadPackage>("deadcode", JSON.parse(raw.stdout));
    const findings = packages.flatMap((pkg) => {
      if (!Array.isArray(pkg.Funcs))
        throw new Error(
          "deadcode output has a package without Funcs: its output format may have changed; refusing to report it.",
        );
      return pkg.Funcs.flatMap((fn) => {
        const at = fn.Position;
        if (
          typeof fn.Name !== "string" ||
          typeof at?.File !== "string" ||
          typeof at.Line !== "number" ||
          typeof at.Col !== "number"
        )
          throw new Error(
            "deadcode output has a function without a name or position: its output format may have changed; refusing to report it.",
          );
        const file = absPosix(cwd, at.File);
        if (!isUnder(file, cwd) || inNested(file) || !scope.has(file))
          return [];
        return [
          finding({
            tool: "deadcode",
            layer: "lint",
            language: "go",
            file,
            line: at.Line,
            col: at.Col,
            ruleId: "unreachable-func",
            severity: "warning",
            message: `unreachable func: ${fn.Name}`,
            fixable: false,
          }),
        ];
      });
    });
    return result(
      findings.toSorted(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.col - b.col ||
          a.message.localeCompare(b.message),
      ),
    );
  },
};
