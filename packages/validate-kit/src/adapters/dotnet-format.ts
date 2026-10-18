import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import picomatch from "picomatch";
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
import { dotnetWorkspaces, upTo } from "../detect/adoption.js";
import { languageForFile, toPosix } from "../detect/languages.js";
import {
  absPosix,
  DOTNET_ENV,
  finding,
  findingsArray,
  firstLineOf,
  scratchOf,
} from "./base.js";

/** An `.editorconfig` that sets .NET or C# style (`dotnet_…`, `csharp_…`). */
function dotnetStyle(path: string): boolean {
  try {
    return /^\s*(?:dotnet|csharp)_\w+\s*=/m.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

interface DotnetTask {
  /** The project or solution to load (absolute). */
  workspace: string;
  /** The project root and the kit's `ignore` globs: a full run reads the whole workspace. */
  top: string;
  ignore: string[];
}

interface FormatDocument {
  FilePath?: unknown;
  FileChanges?: unknown;
}

interface FormatChange {
  LineNumber?: unknown;
  CharNumber?: unknown;
  DiagnosticId?: unknown;
  FormatDescription?: unknown;
}

/** An analyzer pass prefixes its description with the severity (1c). */
const PREFIXED = /^(error|warning|info) (\w+): (.*)$/s;

/**
 * dotnet format — whitespace and the code style the `.editorconfig` sets
 * (`IDE0007` use `var`, …), each change it would make at its line and
 * column, from its JSON report. Runs where the project chose it: C# files in
 * a project (or a solution listing it) under an `.editorconfig` with
 * `dotnet_`/`csharp_` keys, or `tools.dotnet-format.enabled`. It loads each
 * workspace once: the whole of it in a full run, the changed files
 * (`--include`) otherwise. It restores the project first, into the run's
 * scratch folder (`ArtifactsPath`), which needs NuGet (the network) only for
 * a `PackageReference` not in the local cache, NuGet Audit off: verify tier.
 * `--fix` runs `dotnet format`, which applies those style fixes too, not only
 * whitespace. Recorded on SDK 10.0.401:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 1c.
 */
export const dotnetFormat: ToolAdapter = {
  id: "dotnet-format",
  layer: "format",
  languages: ["csharp"],
  // One load of the workspace per run, not one per chunk of files.
  fileScoped: false,
  bin: "dotnet",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  tier: "verify",
  minVersion: "10.0.401",
  installHint:
    "brew install dotnet  (or: https://dotnet.microsoft.com/download)",

  expand(_seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const top = toPosix(env.projectRoot);
    const chosen = env.toolConfig.enabled === true;
    const changed = env.changedPaths && new Set(env.changedPaths.map(toPosix));
    const styled = new Map<string, boolean>();
    const adopted = (file: string) =>
      chosen ||
      upTo(dirname(file), top).some((dir) => {
        if (!styled.has(dir))
          styled.set(dir, dotnetStyle(join(dir, ".editorconfig")));
        return styled.get(dir);
      });
    const files = env.scopedFiles.filter(
      (file) =>
        languageForFile(file) === "csharp" &&
        (!changed || changed.has(posix.relative(top, file))) &&
        adopted(file),
    );
    const workspaceOf = dotnetWorkspaces(top);
    return [...groupBy(files, workspaceOf)].flatMap(([workspace, own]) => {
      if (workspace === undefined) return [];
      const task: DotnetTask = {
        workspace,
        top,
        ignore: [...env.config.ignore],
      };
      // shortcut: a full run checks the whole workspace, so a file in it no
      // dotnet_ .editorconfig reaches is checked too; upgrade if a project
      // mixes them.
      return [
        {
          cwd: posix.dirname(workspace),
          ...(changed ? { files: own } : {}),
          options: task,
        },
      ];
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(report|verify-no-changes|include)(=|$)/.test(arg),
    )
      ? "the kit sets the report, the files and when to write changes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const { workspace } = ctx.options as DotnetTask;
    const scratch = toPosix(scratchOf(ctx));
    return {
      bin: this.bin,
      args: [
        "format",
        basename(workspace),
        ...(ctx.fix ? [] : ["--verify-no-changes"]),
        "--report",
        scratch,
        ...ctx.extraArgs,
        ...(ctx.files
          ? [
              "--include",
              ...ctx.files.map((file) =>
                posix.relative(toPosix(ctx.cwd), toPosix(file)),
              ),
            ]
          : []),
      ],
      // Its restore's bin/ and obj/ go to the scratch folder, not the project.
      env: {
        ...DOTNET_ENV,
        UseArtifactsOutput: "true",
        ArtifactsPath: `${scratch}/artifacts`,
      },
      // 1: a missing project or an unknown flag, told by its stderr.
      okExitCodes: [0, 1, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 1)
      throw new Error(
        `dotnet format failed: ${firstLineOf(raw.stderr) ?? "exit 1 with no message"}`,
      );
    const report = join(scratchOf(ctx), "format-report.json");
    // Every run writes it, a clean one as `[]`.
    if (!existsSync(report))
      throw new Error(
        "dotnet format wrote no format-report.json: its output format may have changed; refusing to report zero findings.",
      );
    const documents = findingsArray<FormatDocument>(
      "dotnet format",
      JSON.parse(readFileSync(report, "utf8")),
    );
    const { top, ignore } = ctx.options as DotnetTask;
    // A file under an ignored folder (a fixture) is not the project's.
    const ignored =
      ignore.length > 0 ? picomatch(ignore, { dot: true }) : () => false;
    const changes = documents.map((doc) => ({
      doc,
      own: findingsArray<FormatChange>("dotnet format", doc, "FileChanges"),
    }));
    // 2: changes needed. Checked before the kit's ignore list drops any.
    if (
      !ctx.fix &&
      raw.exitCode === 2 &&
      changes.every(({ own }) => own.length === 0)
    )
      throw new Error(
        "dotnet format exited 2, which means changes are needed, but its report lists none: its output format may have changed; refusing to report it.",
      );
    const findings: Finding[] = [];
    for (const { doc, own } of changes) {
      for (const change of own) {
        const description = change.FormatDescription;
        if (
          typeof doc.FilePath !== "string" ||
          typeof change.LineNumber !== "number" ||
          typeof change.CharNumber !== "number" ||
          typeof change.DiagnosticId !== "string" ||
          typeof description !== "string"
        )
          throw new Error(
            "dotnet format reported a change without a file, position, id or description: its output format may have changed; refusing to report it.",
          );
        const file = absPosix(ctx.cwd, doc.FilePath);
        if (ignored(posix.relative(top, file))) continue;
        const prefixed = PREFIXED.exec(description);
        findings.push(
          finding({
            tool: "dotnet-format",
            layer: "format",
            language: "csharp",
            file,
            line: change.LineNumber,
            col: change.CharNumber,
            ruleId: change.DiagnosticId,
            // Whitespace has no prefix; dotnet format prints it as an error.
            severity: (prefixed?.[1] as Severity | undefined) ?? "error",
            message: prefixed?.[3] ?? description,
            fixable: true,
          }),
        );
      }
    }
    return {
      // The report lists what a fix run changed: nothing is left of it.
      findings: ctx.fix ? [] : findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: ctx.fix ? findings.length : 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
