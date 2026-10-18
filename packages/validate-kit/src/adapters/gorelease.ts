import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
import { absPosix, finding, scratchOf, toolOptions } from "./base.js";
import { formatChanged } from "./mutation.js";

/**
 * git in `dir`, trimmed, outside any hook's repository: a hook exports
 * GIT_DIR and GIT_INDEX_FILE, and a clone or checkout made under them would
 * act on the repository being pushed.
 */
function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("GIT_"),
        ),
      ),
    }).trim();
  } catch {
    return undefined;
  }
}

const Options = z
  .object({
    /**
     * The released version to compare with, as the module proxy knows it
     * (`v1.5.2`, `latest`): a git tag alone is not one.
     */
    base: z.string().min(1),
  })
  .strict();

interface GoreleaseTask {
  base: string;
}

/** The summary of a run with incompatible changes and no proposed version. */
const GENERIC =
  /^Cannot suggest a release version\.\s*Incompatible changes were detected\.$/;

/**
 * gorelease — the module's exported API against a released version: an
 * exported function, type or method removed or changed incompatibly, under
 * a version that does not say so. Each incompatible change is an error on
 * go.mod, naming the package and symbol (gorelease gives no line); with
 * `-version=` in `extraArgs`, a proposed version that does not fit the
 * change is one too. Opt-in (`tools.gorelease.enabled` with `options.base`,
 * a version the module proxy serves), the `deep` tier: it downloads the
 * base through GOPROXY. It checks the committed code (HEAD), in a clone in
 * the scratch folder, since it refuses a work tree with any change in it,
 * an untracked file included. Recorded on
 * golang.org/x/exp v0.0.0-20261014143641-f0251eb4aa3e:
 * docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 6.
 */
export const gorelease: ToolAdapter = {
  id: "gorelease",
  layer: "lint",
  languages: ["go"],
  bin: "gorelease",
  // It has no version flag (-version is the proposed release): `-h` exits 2
  // with its usage, and `go version -m` reads the build.
  versionArgs: ["-h"],
  versionExitCodes: [2],
  parseVersion: () => undefined,
  minVersion: "0.0.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  installHint: "go install golang.org/x/exp/cmd/gorelease@latest",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (env.toolConfig.enabled !== true) return [];
    const task: GoreleaseTask = toolOptions(env, "gorelease", Options);
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--?base(=|$)/.test(arg))
      ? "-base is the kit's: set tools.gorelease.options.base"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    // gorelease judges HEAD and refuses a work tree with any change, an
    // untracked file (a Cargo.lock another tool wrote) among them: it runs
    // in a clone of HEAD in the scratch folder, at the module's place.
    const head = git(ctx.cwd, ["rev-parse", "HEAD"]);
    const top = git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
    const copy = join(scratchOf(ctx), "head");
    const cloned =
      head !== undefined &&
      top !== undefined &&
      git(ctx.cwd, [
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        top,
        copy,
      ]) !== undefined &&
      git(copy, ["checkout", "--quiet", "--detach", head]) !== undefined;
    return {
      bin: this.bin,
      args: [`-base=${(ctx.options as GoreleaseTask).base}`, ...ctx.extraArgs],
      ...(cloned
        ? {
            cwd: join(copy, git(ctx.cwd, ["rev-parse", "--show-prefix"]) ?? ""),
          }
        : {}),
      // 1: incompatible changes, a proposed version that does not fit, or
      // an error (`gorelease:` on stderr); 2 a usage error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    // An error shares exit 1 with the report: a dirty tree, no go.mod, a
    // base the proxy does not have.
    const error = raw.stderr
      .split(/\r?\n/)
      .find((line) => line.startsWith("gorelease:"));
    if (error) throw new Error(error);
    // Exit 0: the change fits (a v0 module may break its API).
    if (raw.exitCode === 0) return result([]);
    const base = (ctx.options as GoreleaseTask).base;
    const at = (ruleId: string, message: string) =>
      finding({
        tool: "gorelease",
        layer: "lint",
        language: "go",
        file: absPosix(ctx.cwd, "go.mod"),
        line: 1,
        col: 1,
        ruleId,
        severity: "error",
        message,
        fixable: false,
      });
    const findings: Finding[] = [];
    const summary: string[] = [];
    let pkg = "";
    let section = "";
    for (const line of raw.stdout.split(/\r?\n/)) {
      if (line.startsWith("## ")) section = line.slice(3);
      else if (line === "# summary") section = "summary";
      else if (line.startsWith("# ")) {
        pkg = line.slice(2);
        section = "";
      } else if (!line.trim()) continue;
      else if (section === "summary") summary.push(line.trim());
      // The symbol in the rule: these have no line, so a baseline that
      // accepts one break must accept no other.
      else if (section === "incompatible changes")
        findings.push(
          at(
            `incompatible-change:${pkg}.${line.trim().split(":")[0] ?? ""}`,
            `${pkg}.${line.trim()}, incompatible with ${base}: restore it, or release a new major version`,
          ),
        );
    }
    const why = summary.join(" ");
    if (why && !GENERIC.test(why))
      findings.push(
        at(
          `release-version:${/^(\S+) is not a valid semantic version/.exec(why)?.[1] ?? why}`,
          why,
        ),
      );
    if (findings.length === 0)
      throw formatChanged(
        "gorelease",
        "exited 1 with no incompatible change and no summary",
      );
    return result(findings);
  },
};
