import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { groupBy } from "../core/group.js";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { dotnetWorkspaces } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import {
  absPosix,
  DOTNET_ENV,
  finding,
  firstLineOf,
  sarifResults,
  scratchOf,
} from "./base.js";

const csharp = (file: string) => languageForFile(file) === "csharp";

/**
 * A diagnostic as the console prints it (1b), each one twice:
 * `/abs/Program.cs(3,19): error CS8602: … [/abs/App.csproj]`, and with no
 * position `/abs/App.csproj : error NU1101: … [/abs/App.csproj]` or
 * `MSBUILD : error MSB1009: …`.
 */
const CONSOLE =
  /^(.+?)(?:\((\d+),(\d+)(?:,\d+,\d+)?\))? ?: (error|warning) ([A-Za-z]+\d+): (.*?)(?: \[[^\]]+\])?$/;

interface BuildTask {
  /** The project or solution to build (absolute). */
  workspace: string;
}

const LEVELS: Record<string, Severity | undefined> = {
  error: "error",
  warning: "warning",
  // Analyzer suggestions (CA1822): not printed, and they do not fail the build.
  note: "info",
  none: undefined,
};

/**
 * Each compile writes its own SARIF 2.1 log, named by a fresh GUID: one
 * `-p:ErrorLog=` for the whole build is written by every project in it, the
 * last one over the rest. Imported after the project's own targets, so it
 * wins over an ErrorLog the project sets.
 */
function errorLogTargets(dir: string): string {
  return `<Project>
  <PropertyGroup>
    <ErrorLog>${dir}/$([System.Guid]::NewGuid()).sarif,version=2.1</ErrorLog>
  </PropertyGroup>
</Project>
`;
}

/**
 * dotnet build — the C# compiler and the analyzers the project enables
 * (nullable dereference CS8602, unused variable CS0219, CA rules), each at its
 * location from the compiler's SARIF 2.1 log; warnings fail the build
 * (`-warnaserror`). Opt-in (`tools.dotnet-build.enabled`), deep tier: it
 * compiles every project a changed C# file is in (its solution when one lists
 * it), and restoring a `PackageReference` not in the local cache needs NuGet
 * (the network). Its `bin/` and `obj/` go to the run's scratch folder
 * (`ArtifactsPath`), not into the project. Recorded on SDK 10.0.401:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 1b.
 */
export const dotnetBuild: ToolAdapter = {
  id: "dotnet-build",
  layer: "lint",
  languages: ["csharp"],
  fileScoped: false,
  bin: "dotnet",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  tier: "deep",
  minVersion: "10.0.401",
  installHint:
    "brew install dotnet  (or: https://dotnet.microsoft.com/download)",
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (env.toolConfig.enabled !== true) return [];
    const top = toPosix(env.projectRoot);
    const changed = env.changedPaths && new Set(env.changedPaths.map(toPosix));
    // A deleted file too: what used it may no longer compile.
    const files = [
      ...env.scopedFiles.filter(
        (file) =>
          csharp(file) && (!changed || changed.has(posix.relative(top, file))),
      ),
      ...[...(changed ?? [])]
        .map((path) => posix.join(top, path))
        .filter((file) => csharp(file) && !existsSync(file)),
    ];
    const workspaceOf = dotnetWorkspaces(top);
    return [...groupBy(files, workspaceOf).keys()].flatMap((workspace) => {
      if (workspace === undefined) return [];
      const task: BuildTask = { workspace };
      return [{ ...seed, cwd: posix.dirname(workspace), options: task }];
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /ErrorLog|ArtifactsPath|UseArtifactsOutput|CustomAfterMicrosoftCommonTargets/i.test(
        arg,
      ),
    )
      ? "the kit sets where the compiler's SARIF log and the build output go"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const { workspace } = ctx.options as BuildTask;
    const scratch = toPosix(scratchOf(ctx));
    const targets = absPosix(scratch, "error-log.targets");
    writeFileSync(targets, errorLogTargets(scratch));
    return {
      bin: this.bin,
      args: [
        "build",
        basename(workspace),
        // An up-to-date project skips the compiler and writes no log (1b).
        "--no-incremental",
        "-warnaserror",
        "-nologo",
        "-v",
        "q",
        "-p:UseArtifactsOutput=true",
        `-p:ArtifactsPath=${scratch}/artifacts`,
        `-p:CustomAfterMicrosoftCommonTargets=${targets}`,
        // A global property, so a project's own NuGetAudit cannot turn it
        // back on: the audit fetches vulnerability data on every restore.
        "-p:NuGetAudit=false",
        ...ctx.extraArgs,
      ],
      env: DOTNET_ENV,
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const scratch = scratchOf(ctx);
    const logs = existsSync(scratch)
      ? readdirSync(scratch).filter((name) => name.endsWith(".sarif"))
      : [];
    const findings: Finding[] = [];
    for (const name of logs) {
      const text = readFileSync(join(scratch, name), "utf8");
      for (const r of sarifResults("dotnet build", { ...raw, stdout: text })) {
        const level = typeof r.level === "string" ? r.level : "warning";
        const severity = LEVELS[level];
        if (severity === undefined && level !== "none")
          throw new Error(
            `dotnet build's SARIF has a result of unknown level ${JSON.stringify(r.level)}: its output format may have changed; refusing to report it.`,
          );
        const location = r.locations?.[0]?.physicalLocation;
        const uri = location?.artifactLocation?.uri;
        const region = location?.region;
        // A diagnostic about the compilation, not a file: the console has
        // it, and a failed build without a finding throws below.
        if (severity === undefined || typeof uri !== "string" || !region)
          continue;
        const file = uri.startsWith("file:")
          ? toPosix(fileURLToPath(uri))
          : absPosix(ctx.cwd, uri);
        findings.push(
          finding({
            tool: "dotnet-build",
            layer: "lint",
            language: languageForFile(file),
            file,
            line: region.startLine,
            col: region.startColumn,
            endLine: region.endLine,
            endCol: region.endColumn,
            ...(typeof r.ruleId === "string" ? { ruleId: r.ruleId } : {}),
            severity,
            message:
              typeof r.message?.text === "string"
                ? r.message.text
                : String(r.ruleId),
            fixable: false,
          }),
        );
      }
    }
    if (logs.length === 0 && raw.exitCode === 0)
      throw new Error(
        "dotnet build wrote no SARIF log: the compiler did not run; refusing to report zero findings.",
      );
    // What no log holds: MSBuild, NuGet and SDK diagnostics (MSB…, NU…,
    // NETSDK…, a target's <Warning>), each printed twice, and once more if a
    // log has it too.
    const { workspace } = ctx.options as BuildTask;
    const seen = new Set(
      findings.map((f) => `${f.file}:${f.line}:${f.col}:${f.ruleId}`),
    );
    for (const text of raw.stdout.split(/\r?\n/)) {
      const m = CONSOLE.exec(text.trim());
      if (!m?.[1] || !m[4] || !m[5]) continue;
      const file =
        m[1].startsWith("/") || /^[A-Za-z]:[\\/]/.test(m[1])
          ? toPosix(m[1])
          : workspace;
      const line = m[2] ? Number(m[2]) : 1;
      const col = m[3] ? Number(m[3]) : 1;
      const key = `${file}:${line}:${col}:${m[5]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(
        finding({
          tool: "dotnet-build",
          layer: "lint",
          language: languageForFile(file),
          file,
          line,
          col,
          ruleId: m[5],
          severity: m[4] === "error" ? "error" : "warning",
          message: m[6] ?? m[5],
          fixable: false,
        }),
      );
    }
    // The build failed and neither a log nor the console says why.
    if (
      raw.exitCode === 1 &&
      !findings.some((f) => f.severity === "error" || f.severity === "warning")
    )
      throw new Error(
        `dotnet build failed with no finding: ${firstLineOf(raw.stdout, raw.stderr) ?? "exit 1"}`,
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
