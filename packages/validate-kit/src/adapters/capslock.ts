import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { z } from "zod";
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
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, toolOptions } from "./base.js";
import { formatChanged } from "./mutation.js";
import { goModulePath } from "./nilaway.js";

const Options = z
  .object({
    /** The committed `capslock -output=json` of the module, relative to its root. */
    baseline: z.string().min(1),
  })
  .strict();

interface CapslockTask {
  /** Absolute. */
  baseline: string;
}

/**
 * `Package example.com/capfix has new capability EXEC compared to the baseline.`
 * `Package example.com/capfix no longer has capability EXEC which was in the baseline.`
 */
const CHANGED =
  /^Package (\S+) (has new|no longer has) capability (\S+) (?:compared to|which was in) the baseline\.$/;
/** A call path step: `main.go:9:41    example.com/capfix/runner.Version`. */
const STEP = /^(\S+?):(\d+):(\d+)\s+(\S+)$/;

/** The package of a function: `example.com/m/p.(*T).M` -> `example.com/m/p`. */
function packageOf(fn: string): string {
  const slash = fn.lastIndexOf("/") + 1;
  return fn.slice(0, slash) + (fn.slice(slash).split(".")[0] ?? "");
}

/**
 * capslock — what the module's code can do through its dependencies (run a
 * program, open a file or a socket, read the environment, call unsafe
 * code), compared with a baseline the project committed: a dependency
 * update that gives a package a capability it did not have is an error,
 * naming the package, the capability and where the module's code calls
 * into it; one it no longer has is info (record the baseline again).
 * Opt-in (`tools.capslock.enabled` with `options.baseline`, the committed
 * `capslock -output=json` of the module, recorded with the same
 * `extraArgs`), the `deep` tier: it loads and compiles every package,
 * fetching modules the cache does not have yet.
 * Recorded on v0.3.4: docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 5.
 */
export const capslock: ToolAdapter = {
  id: "capslock",
  layer: "security",
  languages: ["go"],
  bin: "capslock",
  versionArgs: ["-version"],
  parseVersion: (out) => /capslock version v(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.3.4",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  installHint: "go install github.com/google/capslock/cmd/capslock@latest",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (env.toolConfig.enabled !== true) return [];
    const { baseline } = toolOptions(env, "capslock", Options);
    const path = resolve(seed.cwd, baseline);
    if (!existsSync(path))
      return [
        {
          ...seed,
          cannotRun: `no capslock baseline at ${posix.relative(toPosix(env.projectRoot), toPosix(path))}: record it in the module with \`capslock -output=json > ${baseline}\` and commit it`,
        },
      ];
    const task: CapslockTask = { baseline: path };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--?output(=|$)/.test(arg))
      ? "-output is the kit's: it reads the comparison with the baseline"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "-output=compare",
        // Outside a module it would `go get` the packages (network).
        "-force_local_module",
        ...ctx.extraArgs,
        (ctx.options as CapslockTask).baseline,
      ],
      // 1: any difference from the baseline; 2 an error (no baseline, a
      // package that does not compile).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const module = goModulePath(ctx.cwd) ?? "";
    const goMod = absPosix(cwd, "go.mod");
    /** A file of the module, by its package and base name: capslock prints only the base name. */
    const fileIn = (pkg: string, base: string) => {
      const dir =
        pkg === module
          ? ""
          : module && pkg.startsWith(`${module}/`)
            ? pkg.slice(module.length + 1)
            : undefined;
      const file =
        dir === undefined ? undefined : absPosix(cwd, posix.join(dir, base));
      return file && existsSync(file) ? file : undefined;
    };
    const changes: {
      pkg: string;
      added: boolean;
      capability: string;
      path: {
        fn: string;
        site?: { base: string; line: number; col: number };
      }[];
    }[] = [];
    for (const line of raw.stdout.split(/\r?\n/)) {
      const head = CHANGED.exec(line.trim());
      if (head?.[1] && head[2] && head[3]) {
        changes.push({
          pkg: head[1],
          added: head[2] === "has new",
          capability: head[3],
          path: [],
        });
        continue;
      }
      const current = changes.at(-1);
      if (!current || !line.trim()) continue;
      const step = STEP.exec(line.trim());
      current.path.push(
        step?.[1] && step[4]
          ? {
              fn: step[4],
              site: {
                base: step[1],
                line: Number(step[2]),
                col: Number(step[3]),
              },
            }
          : { fn: line.trim() },
      );
    }
    if (raw.exitCode === 1 && changes.length === 0)
      throw formatChanged(
        "capslock",
        "exited 1 (a difference from the baseline) but named no package",
      );
    const findings: Finding[] = changes.map((c) => {
      // Where the module's own code calls out: the last step whose caller
      // (the step before it) is in the module.
      let place = { file: goMod, line: 1, col: 1 };
      for (let i = 1; i < c.path.length; i++) {
        const site = c.path[i]?.site;
        const caller = c.path[i - 1]?.fn;
        const file =
          site && caller ? fileIn(packageOf(caller), site.base) : undefined;
        if (file && site) place = { file, line: site.line, col: site.col };
      }
      const chain = c.path.map((step) => step.fn).join(" -> ");
      return finding({
        tool: "capslock",
        layer: "security",
        language: "go",
        ...place,
        ruleId: c.capability,
        severity: c.added ? "error" : "info",
        message: c.added
          ? `${c.pkg} gained capability ${c.capability}, which the baseline does not have${chain ? ` (${chain})` : ""}: remove the call, or record the baseline again if it is intended`
          : `${c.pkg} no longer has capability ${c.capability}: record the baseline again to drop it`,
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
