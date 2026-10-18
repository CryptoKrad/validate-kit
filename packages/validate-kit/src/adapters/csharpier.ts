import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { groupBy } from "../core/group.js";
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
import { upTo } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, DOTNET_ENV, finding, firstLineOf } from "./base.js";

/** CSharpier's config names (https://csharpier.com/docs/Configuration). */
const CONFIGS = [
  ".csharpierrc",
  ".csharpierrc.json",
  ".csharpierrc.yaml",
  ".csharpierrc.yml",
];

/**
 * A local tool manifest that lists csharpier: .NET 10 writes it at the
 * root, older SDKs in `.config/` (dotnet-ruby-php-elixir.md, 2).
 */
function listsCsharpier(dir: string): boolean {
  return ["dotnet-tools.json", ".config/dotnet-tools.json"].some((name) => {
    try {
      return /"csharpier"\s*:/.test(readFileSync(join(dir, name), "utf8"));
    } catch {
      return false;
    }
  });
}

const HEADER = /^Error (.+?) - Was not formatted( due to syntax errors)?\.$/;
const AROUND = /Expected: Around Line (\d+)/;
const SYNTAX = /^\s+\((\d+),(\d+)\): error (CS\d+): (.+)$/;

/**
 * CSharpier — the opinionated C# formatter: each file it would reformat,
 * at the line its diff starts around (it prints no column), and each file it
 * cannot format because it does not parse. Runs where the project chose it:
 * a `.csharpierrc` (`.json`, `.yaml`, `.yml`) or a dotnet tool manifest
 * listing csharpier, at or above the file, from that folder (so
 * `dotnet csharpier` finds the manifest); or `tools.csharpier.enabled`.
 * `--fix` runs `dotnet csharpier format`, layout only. Recorded on 1.3.0:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 2.
 */
export const csharpier: ToolAdapter = {
  id: "csharpier",
  layer: "format",
  languages: ["csharp"],
  bin: "dotnet",
  versionArgs: ["csharpier", "--version"],
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.3.0",
  installHint:
    "dotnet tool restore, where a dotnet-tools.json lists it  (else: dotnet new tool-manifest && dotnet tool install csharpier; the kit runs `dotnet csharpier`)",
  findingExitCodes: [1],
  masks: (f) => f.ruleId?.startsWith("CS") === true,

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const top = env.projectRoot;
    const runDir = (file: string): string | undefined =>
      upTo(dirname(file), top).find(
        (dir) =>
          CONFIGS.some((name) => existsSync(join(dir, name))) ||
          listsCsharpier(dir),
      ) ?? (env.toolConfig.enabled === true ? seed.cwd : undefined);
    return [...groupBy(seed.files ?? [], runDir)].flatMap(([dir, files]) =>
      dir === undefined ? [] : [{ ...seed, cwd: toPosix(dir), files }],
    );
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(log-format|unformatted-as-warnings|write-stdout)(=|$)/.test(arg),
    )
      ? "the kit reads CSharpier's default report on stderr and its exit code"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "csharpier",
        ctx.fix ? "format" : "check",
        ...ctx.extraArgs,
        ...(ctx.files ?? []).map((file) =>
          posix.relative(toPosix(ctx.cwd), toPosix(file)),
        ),
      ],
      env: DOTNET_ENV,
      // 1: unformatted, and also a missing path or a usage error (stderr).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings: Finding[] = [];
    let file: string | undefined;
    let unformatted: Finding | undefined;
    for (const line of raw.stderr.split("\n")) {
      const head = HEADER.exec(line);
      if (head?.[1]) {
        file = absPosix(ctx.cwd, head[1]);
        unformatted = undefined;
        if (head[2] === undefined) {
          unformatted = finding({
            tool: "csharpier",
            layer: "format",
            language: "csharp",
            file,
            line: 1,
            col: 1,
            severity: "warning",
            message: "Not formatted as CSharpier formats it",
            fixable: true,
          });
          findings.push(unformatted);
        }
        continue;
      }
      const around = AROUND.exec(line);
      if (around && unformatted) {
        unformatted.line = Number(around[1]);
        unformatted = undefined;
        continue;
      }
      const error = SYNTAX.exec(line);
      if (error?.[3] && error[4] && file)
        findings.push(
          finding({
            tool: "csharpier",
            layer: "format",
            language: "csharp",
            file,
            line: Number(error[1]),
            col: Number(error[2]),
            ruleId: error[3],
            severity: "error",
            message: `${error[4]}: CSharpier formats only code that parses`,
            fixable: false,
          }),
        );
    }
    if (findings.length === 0) {
      // A missing path, an unknown flag (read as a path), no command: exit 1.
      if (raw.exitCode !== 0)
        throw new Error(
          `csharpier failed: ${firstLineOf(raw.stderr, raw.stdout) ?? `exit ${raw.exitCode}`}`,
        );
      if (!/^(?:Checked|Formatted) \d+ files/m.test(raw.stdout))
        throw new Error(
          "csharpier printed no `Checked N files` summary: its output format may have changed; refusing to report zero findings.",
        );
    }
    return {
      findings: ctx.fix ? findings.filter((f) => !f.fixable) : findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
