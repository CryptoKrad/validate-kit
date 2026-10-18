import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { brakeman } from "../src/adapters/brakeman.js";
import { credo } from "../src/adapters/credo.js";
import { csharpier } from "../src/adapters/csharpier.js";
import { dotnetBuild } from "../src/adapters/dotnet-build.js";
import { dotnetFormat } from "../src/adapters/dotnet-format.js";
import { mixFormat } from "../src/adapters/mix-format.js";
import { phpCsFixer } from "../src/adapters/php-cs-fixer.js";
import { phpstan } from "../src/adapters/phpstan.js";
import { pint } from "../src/adapters/pint.js";
import { rubocop } from "../src/adapters/rubocop.js";
import { resolveConfig } from "../src/config/resolve.js";
import { buildPlan } from "../src/core/plan.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";
import { detectFromFiles, toPosix } from "../src/detect/languages.js";

// Every output below was recorded on 2026-10-18 (dotnet SDK 10.0.401,
// csharpier 1.3.0, rubocop 1.92.0, brakeman 8.1.0, phpstan 2.3.1,
// php-cs-fixer 3.95.27, Pint 1.32.1, Elixir 1.20.4, credo 1.7.19) against a
// fixture with the problem planted, then trimmed, `<WORK>` being the
// fixture's folder (docs/research/lint-toolchain/sota-2026-10-18/
// dotnet-ruby-php-elixir.md and its assets/).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

/** `files` (relative to `root`) with their contents. */
function project(files: Record<string, string>): string {
  const root = tmp("vk-dotnet-ruby-php-elixir-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-dotnet-ruby-php-elixir-scratch-");
  return { cwd, fix: false, extraArgs: [], tempDir: () => scratch, ...extra };
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

function env(root: string, more: Partial<PlanEnv> = {}): PlanEnv {
  return {
    projectRoot: root,
    scopedFiles: [],
    toolConfig: {},
    config: { ignore: [] },
    ...more,
  } as unknown as PlanEnv;
}

/** Each finding as [path below `root`, line, col, rule, severity]. */
function brief(adapter: ToolAdapter, raw: RawOutput, c: ToolContext) {
  return adapter
    .parseOutput(raw, c)
    .findings.map((f) => [
      f.file.slice(c.cwd.length + 1),
      f.line,
      f.col,
      f.ruleId,
      f.severity,
    ]);
}

const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';

/** dotnet format's report, where the task's scratch folder holds it. */
function writeReport(task: ToolContext, text: string): void {
  writeFileSync(join(task.tempDir?.() ?? "", "format-report.json"), text);
}

describe("dotnet format", () => {
  it("reports each change of its JSON report at its line and column, by the severity its description names", () => {
    const root = project({ "Fixture.csproj": CSPROJ });
    const options = (ignore: string[] = []) => ({
      workspace: `${root}/Fixture.csproj`,
      top: root,
      ignore,
    });
    const c = ctx(root, { options: options() });
    const report = [
      {
        FileName: "Greeter.cs",
        FilePath: "<WORK>/Greeter.cs",
        FileChanges: [
          {
            LineNumber: 3,
            CharNumber: 1,
            DiagnosticId: "WHITESPACE",
            FormatDescription:
              "Fix whitespace formatting. Replace 1 characters with '\\s\\s\\s\\s'.",
          },
        ],
      },
      {
        FileName: "Greeter.cs",
        FilePath: "<WORK>/Greeter.cs",
        FileChanges: [
          {
            LineNumber: 5,
            CharNumber: 9,
            DiagnosticId: "IDE0007",
            FormatDescription:
              "warning IDE0007: use 'var' instead of explicit type",
          },
        ],
      },
    ];
    writeReport(c, JSON.stringify(report).replaceAll("<WORK>", root));
    const { findings } = dotnetFormat.parseOutput(ran(2), c);
    expect(
      findings.map((f) => [f.line, f.col, f.ruleId, f.severity, f.message]),
    ).toEqual([
      [
        3,
        1,
        "WHITESPACE",
        "error",
        "Fix whitespace formatting. Replace 1 characters with '\\s\\s\\s\\s'.",
      ],
      [5, 9, "IDE0007", "warning", "use 'var' instead of explicit type"],
    ]);
    expect(findings[0]?.file).toBe(`${root}/Greeter.cs`);
    // A full run reads the whole workspace: a file the kit ignores is not
    // the project's, and its changes are no crash either.
    const ignored = ctx(root, { options: options(["Greeter.cs"]) });
    writeReport(ignored, JSON.stringify(report).replaceAll("<WORK>", root));
    expect(dotnetFormat.parseOutput(ran(2), ignored).findings).toEqual([]);
    // A clean run writes `[]`; no report at all is not clean, nor is exit 2
    // with nothing in it.
    writeReport(c, "[]");
    expect(dotnetFormat.parseOutput(ran(0), c).findings).toEqual([]);
    expect(() => dotnetFormat.parseOutput(ran(2), c)).toThrow(/lists none/);
    expect(() =>
      dotnetFormat.parseOutput(ran(0), ctx(root, { options: options() })),
    ).toThrow(/no format-report\.json/);
    expect(() =>
      dotnetFormat.parseOutput(
        ran(
          1,
          "",
          `Unhandled exception: System.IO.FileNotFoundException: The project file '${root}/nope.csproj' does not exist.\n   at Microsoft.CodeAnalysis.Tools.Workspaces.MSBuildWorkspaceFinder.FindFile(String workspacePath)\n`,
        ),
        c,
      ),
    ).toThrow(/does not exist/);
  });

  it("loads each workspace once, the solution only when it lists the project's own path", () => {
    const root = project({
      "App/App.csproj": CSPROJ,
      "App/Program.cs": "",
      "Lib/Lib.csproj": CSPROJ,
      "Lib/Util.cs": "",
      // Lists another project of the same name: not src/App's solution.
      "All.slnx":
        '<Solution>\n  <Project Path="App/App.csproj" />\n  <Project Path="legacy/Lib/Lib.csproj" />\n</Solution>\n',
      "Loose.cs": "",
    });
    const scopedFiles = ["App/Program.cs", "Lib/Util.cs", "Loose.cs"].map(
      (f) => `${root}/${f}`,
    );
    const plan = (more: Partial<PlanEnv> = {}) =>
      dotnetFormat.expand?.({ cwd: root }, env(root, { scopedFiles, ...more }));
    expect(plan()).toEqual([]);
    writeFileSync(
      join(root, ".editorconfig"),
      "[*.cs]\ncsharp_style_var_for_built_in_types = true:warning\n",
    );
    const options = (workspace: string) => ({
      workspace,
      top: root,
      ignore: [],
    });
    // A full run: each workspace whole; a file in no project, not at all.
    expect(plan()).toEqual([
      { cwd: root, options: options(`${root}/All.slnx`) },
      { cwd: `${root}/Lib`, options: options(`${root}/Lib/Lib.csproj`) },
    ]);
    // A changed-file run names its files.
    expect(plan({ changedPaths: ["App/Program.cs"] })).toEqual([
      {
        cwd: root,
        files: [`${root}/App/Program.cs`],
        options: options(`${root}/All.slnx`),
      },
    ]);
    const c = ctx(root, {
      files: [`${root}/App/Program.cs`],
      options: options(`${root}/All.slnx`),
    });
    const built = dotnetFormat.buildArgs(c);
    expect(built.args.slice(0, 3)).toEqual([
      "format",
      "All.slnx",
      "--verify-no-changes",
    ]);
    expect(built.args.slice(-2)).toEqual(["--include", "App/Program.cs"]);
    // Its restore writes into the scratch folder, and asks NuGet nothing.
    expect(built.env).toMatchObject({
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      NuGetAudit: "false",
      UseArtifactsOutput: "true",
      ArtifactsPath: `${c.tempDir?.() ?? ""}/artifacts`,
    });
    expect(
      dotnetFormat.buildArgs(
        ctx(root, { options: options(`${root}/All.slnx`) }),
      ).args,
    ).not.toContain("--include");
  });
});

/** The compiler's SARIF 2.1 log, trimmed (build.sarif.trimmed.json). */
const sarif = (root: string) =>
  JSON.stringify({
    $schema: "http://json.schemastore.org/sarif-2.1.0",
    version: "2.1.0",
    runs: [
      {
        results: [
          {
            ruleId: "CS8602",
            level: "warning",
            message: { text: "Dereference of a possibly null reference." },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: `file://${root}/Program.cs` },
                  region: {
                    startLine: 3,
                    startColumn: 19,
                    endLine: 3,
                    endColumn: 23,
                  },
                },
              },
            ],
          },
          {
            ruleId: "CA1822",
            level: "note",
            message: {
              text: "Member 'Add' does not access instance data and can be marked as static",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: `file://${root}/Greeter.cs` },
                  region: {
                    startLine: 3,
                    startColumn: 13,
                    endLine: 3,
                    endColumn: 16,
                  },
                },
              },
            ],
          },
        ],
        tool: { driver: { name: "Microsoft (R) Visual C# Compiler" } },
      },
    ],
  });

/** A dotnet build task's context for the project at `root`. */
const buildCtx = (root: string) =>
  ctx(root, { options: { workspace: `${root}/Fixture.csproj` } });

describe("dotnet build", () => {
  it("reports each compiler result of every SARIF log at its location once; a note does not gate", () => {
    const root = project({ "Fixture.csproj": CSPROJ });
    const c = buildCtx(root);
    writeFileSync(join(c.tempDir?.() ?? "", "a.sarif"), sarif(root));
    // The console prints it twice more, promoted to an error.
    const line = `${root}/Program.cs(3,19): error CS8602: Dereference of a possibly null reference. [${root}/Fixture.csproj]`;
    expect(
      brief(dotnetBuild, ran(1, `${line}\n\nBuild FAILED.\n\n${line}\n`), c),
    ).toEqual([
      ["Program.cs", 3, 19, "CS8602", "warning"],
      ["Greeter.cs", 3, 13, "CA1822", "info"],
    ]);
  });

  it("reports what only the console prints: MSBuild, NuGet and SDK diagnostics", () => {
    const root = project({ "Fixture.csproj": CSPROJ });
    // A target's <Warning Code="XY001"> under -warnaserror stops the build
    // before the compiler runs: no log.
    const xy = `${root}/Fixture.csproj(8,48): error XY001: custom warning [${root}/Fixture.csproj]`;
    expect(
      brief(
        dotnetBuild,
        ran(1, `${xy}\n\nBuild FAILED.\n\n${xy}\n`),
        buildCtx(root),
      ),
    ).toEqual([["Fixture.csproj", 8, 48, "XY001", "error"]]);
    expect(
      brief(
        dotnetBuild,
        ran(
          1,
          `${root}/Fixture.csproj : error NU1101: Unable to find package Nope. [${root}/Fixture.csproj]\n`,
        ),
        buildCtx(root),
      ),
    ).toEqual([["Fixture.csproj", 1, 1, "NU1101", "error"]]);
  });

  it("fails loud on a failed build nothing explains, and on a build that wrote no log", () => {
    const root = project({ "Fixture.csproj": CSPROJ });
    const c = buildCtx(root);
    expect(() =>
      dotnetBuild.parseOutput(ran(1, "\nBuild FAILED.\n"), c),
    ).toThrow(/failed with no finding: Build FAILED\./);
    expect(() => dotnetBuild.parseOutput(ran(0), c)).toThrow(/no SARIF/);
  });

  it("runs only when enabled, once per workspace a changed C# file is in, offline, its bin/obj in the scratch folder", () => {
    const root = project({
      "App/App.csproj": CSPROJ,
      "App/Program.cs": "",
      "App/Models/User.cs": "",
      "Lib/Lib.csproj": CSPROJ,
      "Lib/Util.cs": "",
    });
    const scopedFiles = [
      "App/Program.cs",
      "App/Models/User.cs",
      "Lib/Util.cs",
    ].map((f) => `${root}/${f}`);
    const plan = (more: Partial<PlanEnv>) =>
      dotnetBuild.expand?.({ cwd: root }, env(root, { scopedFiles, ...more }));
    expect(plan({})).toEqual([]);
    const on = { toolConfig: { enabled: true } };
    expect(plan(on)).toEqual([
      { cwd: `${root}/App`, options: { workspace: `${root}/App/App.csproj` } },
      { cwd: `${root}/Lib`, options: { workspace: `${root}/Lib/Lib.csproj` } },
    ]);
    expect(plan({ ...on, changedPaths: ["Lib/Util.cs", "README.md"] })).toEqual(
      [
        {
          cwd: `${root}/Lib`,
          options: { workspace: `${root}/Lib/Lib.csproj` },
        },
      ],
    );
    const c = ctx(`${root}/App`, {
      options: { workspace: `${root}/App/App.csproj` },
    });
    const built = dotnetBuild.buildArgs(c);
    const scratch = c.tempDir?.() ?? "";
    expect(built.args).toEqual([
      "build",
      "App.csproj",
      "--no-incremental",
      "-warnaserror",
      "-nologo",
      "-v",
      "q",
      "-p:UseArtifactsOutput=true",
      `-p:ArtifactsPath=${scratch}/artifacts`,
      `-p:CustomAfterMicrosoftCommonTargets=${scratch}/error-log.targets`,
      "-p:NuGetAudit=false",
    ]);
    expect(dotnetBuild.refuseArgs?.(["-p:ErrorLog=x.sarif"])).toMatch(/SARIF/);
  });
});

describe("csharpier", () => {
  const unformatted = [
    "Error ./Greeter.cs - Was not formatted.",
    "  ----------------------------- Expected: Around Line 3 -----------------------------",
    "  {",
    "      public int Add(int a, int b)",
    "  ----------------------------- Actual: Around Line 3 -----------------------------",
    "  {",
    "  \tpublic int Add(int a,int b)",
    "",
  ].join("\n");
  const syntax = [
    "Error ./bad.cs - Was not formatted due to syntax errors.",
    "  (1,7): error CS1001: Identifier expected",
    "  (1,8): error CS1519: Invalid token '{' in a member declaration",
  ].join("\n");

  it("reports each unformatted file around the line its diff starts, and each syntax error", () => {
    const root = tmp("vk-csharpier-");
    expect(
      brief(
        csharpier,
        ran(1, "Checked 3 files in 184ms.\n", unformatted),
        ctx(root),
      ),
    ).toEqual([["Greeter.cs", 3, 1, undefined, "warning"]]);
    expect(
      brief(
        csharpier,
        ran(1, "Checked 1 files in 106ms.\n", syntax),
        ctx(root),
      ),
    ).toEqual([
      ["bad.cs", 1, 7, "CS1001", "error"],
      ["bad.cs", 1, 8, "CS1519", "error"],
    ]);
    expect(
      csharpier.parseOutput(ran(0, "Checked 3 files in 118ms.\n"), ctx(root))
        .findings,
    ).toEqual([]);
  });

  it("tells a usage error from findings by its text, and wants its summary on a pass", () => {
    const root = tmp("vk-csharpier-");
    expect(() =>
      csharpier.parseOutput(
        ran(1, "", "There was no file or directory found at nope.cs\n"),
        ctx(root),
      ),
    ).toThrow(/no file or directory found at nope\.cs/);
    expect(() => csharpier.parseOutput(ran(0, ""), ctx(root))).toThrow(
      /summary/,
    );
  });

  it("runs from the folder of its config or of a tool manifest that lists it", () => {
    const root = project({ "src/A.cs": "", "other/B.cs": "" });
    const files = [`${root}/src/A.cs`, `${root}/other/B.cs`];
    const plan = () => csharpier.expand?.({ cwd: root, files }, env(root));
    expect(plan()).toEqual([]);
    writeFileSync(
      join(root, "src", "dotnet-tools.json"),
      '{"version":1,"isRoot":true,"tools":{"csharpier":{"version":"1.3.0","commands":["csharpier"]}}}',
    );
    expect(plan()).toEqual([
      { cwd: `${root}/src`, files: [`${root}/src/A.cs`] },
    ]);
    const built = csharpier.buildArgs(
      ctx(`${root}/src`, { files: [`${root}/src/A.cs`] }),
    );
    expect(built.args).toEqual(["csharpier", "check", "A.cs"]);
  });
});

/** One offense as rubocop 1.92 prints it in `--format json`. */
const offense = (
  severity: string,
  cop: string,
  line: number,
  column: number,
  safe: boolean,
) => ({
  severity,
  message: `${cop} message`,
  cop_name: cop,
  corrected: false,
  correctable: true,
  location: {
    start_line: line,
    start_column: column,
    last_line: line,
    last_column: column + 6,
    length: 7,
    line,
    column,
  },
  correction: { safe, edits: [] },
});
const rubocopJson = (offenses: unknown[]) =>
  JSON.stringify({
    metadata: { rubocop_version: "1.92.0" },
    files: [{ path: "lib.rb", offenses }],
    summary: { offense_count: offenses.length },
  });

describe("rubocop", () => {
  it("reports each offense at its 1-based position; conventions gate, a cop set to info does not; only safe corrections are fixable", () => {
    const root = tmp("vk-rubocop-");
    const { findings } = rubocop.parseOutput(
      ran(
        1,
        rubocopJson([
          offense("convention", "Style/StringLiterals", 4, 11, true),
          offense("warning", "Lint/UselessAssignment", 5, 3, true),
          offense("convention", "Style/ZeroLengthPredicate", 6, 30, false),
          offense("fatal", "Lint/Syntax", 1, 1, false),
          // `Severity: info` in the project's .rubocop.yml.
          offense("info", "Style/NumericPredicate", 6, 30, false),
        ]),
      ),
      ctx(root),
    );
    expect(
      findings.map((f) => [
        f.line,
        f.col,
        f.endCol,
        f.ruleId,
        f.severity,
        f.fixable,
      ]),
    ).toEqual([
      [4, 11, 18, "Style/StringLiterals", "warning", true],
      [5, 3, 10, "Lint/UselessAssignment", "warning", true],
      [6, 30, 37, "Style/ZeroLengthPredicate", "warning", false],
      [1, 1, 8, "Lint/Syntax", "error", false],
      [6, 30, 37, "Style/NumericPredicate", "info", false],
    ]);
    expect(findings[0]?.file).toBe(`${root}/lib.rb`);
    expect(
      rubocop.parseOutput(ran(0, rubocopJson([])), ctx(root)).findings,
    ).toEqual([]);
  });

  it("treats exit 2 as a crash even with JSON on stdout", () => {
    const root = tmp("vk-rubocop-");
    expect(() =>
      rubocop.parseOutput(
        ran(
          2,
          '{"metadata":{},"files":[],"summary":{"offense_count":0,"target_file_count":1,"inspected_file_count":0}}',
          `Error: No such file or directory: ${root}/nope.rb\n`,
        ),
        ctx(root),
      ),
    ).toThrow(/No such file or directory/);
  });

  it("runs where a .rubocop.yml or the Gemfile chose it, excluded files staying excluded", () => {
    const root = project({ "lib.rb": "", Gemfile: 'gem "rails"\n' });
    expect(rubocop.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "Gemfile"),
      'gem "rails"\ngem "rubocop-rails", require: false\n',
    );
    expect(rubocop.adoptedAt?.(root, root)).toBe(true);
    const other = project({ ".rubocop.yml": "AllCops:\n  NewCops: enable\n" });
    expect(rubocop.adoptedAt?.(other, other)).toBe(true);
    const built = rubocop.buildArgs(ctx(root, { files: [`${root}/lib.rb`] }));
    expect(built.args).toEqual([
      "--format",
      "json",
      "--force-exclusion",
      "--",
      "lib.rb",
    ]);
    expect(
      rubocop.buildArgs(ctx(root, { fix: true, files: [`${root}/lib.rb`] }))
        .args,
    ).toContain("--autocorrect");
    expect(rubocop.refuseArgs?.(["-A"])).toMatch(/safe/);
    // `rubocop --version` loads the .rubocop.yml where it runs: one that a
    // plugin or a cop breaks must fail the run, not skip the tool as missing.
    expect(rubocop.versionArgs).toEqual(["--version", "--config", devNull]);
  });
});

/** Brakeman's JSON, `scan_info` trimmed. */
const report = (warnings: unknown[], errors: unknown[] = []) =>
  JSON.stringify({
    scan_info: {
      app_path: "<WORK>",
      rails_version: "8.1",
      brakeman_version: "8.1.0",
    },
    warnings,
    ignored_warnings: [],
    errors,
    obsolete: [],
  });

describe("brakeman", () => {
  const sql = {
    warning_type: "SQL Injection",
    warning_code: 0,
    check_name: "SQL",
    message: "Possible SQL injection",
    file: "app/controllers/users_controller.rb",
    line: 3,
    link: "https://brakemanscanner.org/docs/warning_types/sql_injection/",
    code: "User.where(\"name = '#{params[:name]}'\")",
    user_input: "params[:name]",
    confidence: "Medium",
    cwe_id: [89],
  };

  it("reports each warning at its file and line, and a file it could not parse", () => {
    const root = tmp("vk-brakeman-");
    const { findings } = brakeman.parseOutput(ran(3, report([sql])), ctx(root));
    expect(findings).toMatchObject([
      {
        file: `${root}/app/controllers/users_controller.rb`,
        line: 3,
        ruleId: "SQL",
        severity: "error",
        message:
          "SQL Injection: Possible SQL injection from params[:name] (medium confidence)",
        url: "https://brakemanscanner.org/docs/warning_types/sql_injection/",
      },
    ]);
    expect(
      brief(
        brakeman,
        ran(
          7,
          report(
            [],
            [
              {
                error:
                  'app/models/broken.rb:2 :: parse error on value "$" ($end) While processing app/models/broken.rb',
                location: "ruby_parser.rb:41",
              },
            ],
          ),
        ),
        ctx(root),
      ),
    ).toEqual([["app/models/broken.rb", 2, 1, "parse-error", "error"]]);
    expect(
      brakeman.parseOutput(ran(0, report([])), ctx(root)).findings,
    ).toEqual([]);
  });

  it("fails loud on a folder that is not a Rails app and on a usage error", () => {
    const root = tmp("vk-brakeman-");
    expect(() =>
      brakeman.parseOutput(
        ran(
          4,
          "",
          `Please supply the path to a Rails application (looking in ${root}).\n  Use \`--force\` to run a scan anyway.\n`,
        ),
        ctx(root),
      ),
    ).toThrow(/Please supply the path to a Rails application/);
    expect(() =>
      brakeman.parseOutput(
        ran(
          255,
          "",
          "invalid option: --bogus-flag\nPlease see `brakeman --help` for valid options\n",
        ),
        ctx(root),
      ),
    ).toThrow(/invalid option/);
  });

  it("runs on each Rails app that chose it, when a file in it changed", () => {
    const root = project({
      "web/Gemfile": 'gem "rails", "~> 8.1"\n',
      "web/config/application.rb": "",
      "web/app/views/users/show.html.erb": "",
      "tool/Gemfile": 'gem "rake"\ngem "brakeman"\n',
      "tool/config/application.rb": "",
    });
    const scopedFiles = ["web/Gemfile", "tool/Gemfile"].map(
      (f) => `${root}/${f}`,
    );
    const plan = (changedPaths?: string[]) =>
      brakeman.expand?.(
        { cwd: root },
        env(root, { scopedFiles, ...(changedPaths ? { changedPaths } : {}) }),
      );
    // A Rails app alone does not choose it; brakeman in a non-Rails Gemfile
    // has no app to scan.
    expect(plan()).toEqual([]);
    writeFileSync(
      join(root, "web", "Gemfile"),
      'gem "rails", "~> 8.1"\ngroup :development do\n  gem "brakeman", require: false\nend\n',
    );
    expect(plan()).toEqual([{ cwd: `${root}/web` }]);
    expect(plan(["web/app/views/users/show.html.erb"])).toEqual([
      { cwd: `${root}/web` },
    ]);
    expect(plan(["tool/x.rb"])).toEqual([]);
  });
});

describe("phpstan", () => {
  const AGENT_NOTES =
    "Instructions for interpreting errors\n---------\n\nDo not add `@phpstan-ignore` comments, `@phpstan-ignore-next-line` comments, or baseline entries to suppress the error.\n";

  it("reports each error at its line with its identifier, and drops the agent instructions from stderr", () => {
    const root = tmp("vk-phpstan-");
    const stdout = `{"totals":{"errors":0,"file_errors":1},"files":{"${root}/src/Greeter.php":{"errors":1,"messages":[{"message":"Parameter #1 $a of method Greeter::add() expects int, string given.","line":14,"ignorable":true,"identifier":"argument.type"}]}},"errors":[]}`;
    const result = phpstan.parseOutput(
      ran(
        1,
        stdout,
        `Note: Using configuration file ${root}/phpstan.neon.\n${AGENT_NOTES}`,
      ),
      ctx(root),
    );
    expect(result.findings).toMatchObject([
      {
        file: `${root}/src/Greeter.php`,
        line: 14,
        col: 1,
        ruleId: "argument.type",
        severity: "error",
        url: "https://phpstan.org/error-identifiers/argument.type",
      },
    ]);
    expect(result.stderr).toBe(
      `Note: Using configuration file ${root}/phpstan.neon.\n`,
    );
    expect(
      phpstan.parseOutput(
        ran(
          0,
          '{"totals":{"errors":0,"file_errors":0},"files":{},"errors":[]}',
        ),
        ctx(root),
      ).findings,
    ).toEqual([]);
  });

  it("tells a crash (no JSON) from findings by its stdout", () => {
    const root = tmp("vk-phpstan-");
    expect(() =>
      phpstan.parseOutput(
        ran(
          1,
          "",
          `Note: Using configuration file ${root}/phpstan.neon.\nPath ${root}/nope does not exist\n`,
        ),
        ctx(root),
      ),
    ).toThrow(/Path .*nope does not exist/);
    expect(() =>
      phpstan.parseOutput(
        ran(
          1,
          "",
          '\n                                             \n  The "--bogus-flag" option does not exist.  \n                                             \n\nanalyse [-c|--configuration CONFIGURATION]\n',
        ),
        ctx(root),
      ),
    ).toThrow(/The "--bogus-flag" option does not exist\./);
  });

  it("runs from the folder holding its config, and only where there is one", () => {
    const root = project({ "app/composer.json": "{}" });
    const plan = (more: Partial<PlanEnv> = {}) =>
      phpstan.expand?.({ cwd: `${root}/app` }, env(root, more));
    expect(plan()).toEqual([]);
    // Enabled with no config, it has no paths to analyse: said, not crashed.
    const [unconfigured] = (plan({ toolConfig: { enabled: true } }) ??
      []) as TaskSeed[];
    expect(unconfigured?.cannotRun).toMatch(/no paths to analyse/);
    writeFileSync(
      join(root, "phpstan.neon.dist"),
      "parameters:\n    level: 5\n",
    );
    expect(plan()).toEqual([{ cwd: root }]);
    expect(phpstan.buildArgs(ctx(root)).args).toEqual([
      "analyse",
      "--error-format=json",
      "--no-progress",
    ]);
  });

  it("runs one analysis for two PHP roots under one config", async () => {
    const files = {
      "phpstan.neon": "parameters:\n    level: 5\n    paths: [packages]\n",
      "packages/a/composer.json": "{}",
      "packages/a/A.php": "<?php\n",
      "packages/b/composer.json": "{}",
      "packages/b/B.php": "<?php\n",
    };
    const root = project(files);
    const scoped = Object.keys(files).map((f) => `${root}/${f}`);
    const { config } = await resolveConfig(root);
    const tasks = await buildPlan(
      detectFromFiles(root, scoped),
      config,
      root,
      [phpstan],
      { scopedFiles: scoped },
    );
    expect(tasks.map((t) => t.cwd)).toEqual([root]);
  });
});

describe("php-cs-fixer", () => {
  const diff =
    "--- <WORK>/src/Util.php\n+++ <WORK>/src/Util.php\n@@ -6,11 +6,11 @@\n {\n     public function names(): array\n     {\n-        return array('a', 'b');\n+        return ['a', 'b'];\n     }\n \n     public function same(int $a, int $b): bool\n     {\n-        return $a == $b;\n+        return $a === $b;\n     }\n }\n";
  const json = JSON.stringify({
    about: "PHP CS Fixer 3.95.27 (730c761) Adalbertus",
    files: [{ name: "src/Util.php", diff }],
    time: { total: 0.003 },
    memory: 16,
  }).replaceAll("/", "\\/");

  it("reports each run of changed lines at its first line, with what it becomes", () => {
    const root = tmp("vk-php-cs-fixer-");
    const { findings } = phpCsFixer.parseOutput(ran(8, json), ctx(root));
    expect(findings.map((f) => [f.file, f.line, f.message])).toEqual([
      [
        `${root}/src/Util.php`,
        9,
        "php-cs-fixer would rewrite this as `return ['a', 'b'];`",
      ],
      [
        `${root}/src/Util.php`,
        14,
        "php-cs-fixer would rewrite this as `return $a === $b;`",
      ],
    ]);
  });

  it("reports a file it cannot lint (exit 12), and fails loud on a config error (exit 16)", () => {
    const root = tmp("vk-php-cs-fixer-");
    const stderr = `PHP CS Fixer 3.95.27\nRunning analysis on 15 cores with 10 files per process.\n\nFiles that were not fixed due to errors reported during linting before fixing:\n   1) ${root}/src/Broken.php\n`;
    expect(brief(phpCsFixer, ran(12, json, stderr), ctx(root))).toEqual([
      ["src/Util.php", 9, 1, undefined, "warning"],
      ["src/Util.php", 14, 1, undefined, "warning"],
      ["src/Broken.php", 1, 1, "syntax", "error"],
    ]);
    expect(() =>
      phpCsFixer.parseOutput(
        ran(
          16,
          "",
          'Loaded config default from ".php-cs-fixer.dist.php".\n\nIn ConfigurationResolver.php line 891:\n                                                     \n  The rules contain unknown fixers: "no_such_rule".  \n                                                     \n\nfix [--path-mode PATH-MODE]\n',
        ),
        ctx(root),
      ),
    ).toThrow(/exit 16\): The rules contain unknown fixers: "no_such_rule"\./);
  });

  it("runs from the folder of its config, on the files its finder matches, with no cache", () => {
    const root = project({ "src/Util.php": "", "lib/Other.php": "" });
    const files = [`${root}/src/Util.php`, `${root}/lib/Other.php`];
    const plan = (more: Partial<PlanEnv> = {}) =>
      phpCsFixer.expand?.({ cwd: root, files }, env(root, more));
    expect(plan()).toEqual([]);
    // Enabled with no config, more than one path is exit 16: said instead.
    const [unconfigured] = (plan({ toolConfig: { enabled: true } }) ??
      []) as TaskSeed[];
    expect(unconfigured?.cannotRun).toMatch(/needs one to check more than one/);
    writeFileSync(join(root, "src", ".php-cs-fixer.dist.php"), "<?php\n");
    expect(plan()).toEqual([
      { cwd: `${root}/src`, files: [`${root}/src/Util.php`] },
    ]);
    expect(
      phpCsFixer.buildArgs(
        ctx(`${root}/src`, { files: [`${root}/src/Util.php`] }),
      ).args,
    ).toEqual([
      "fix",
      "--dry-run",
      "--diff",
      "--format=json",
      "--no-interaction",
      "--using-cache=no",
      // More than one path needs it named.
      `--config=${root}/src/.php-cs-fixer.dist.php`,
      "--path-mode=intersection",
      "--",
      "Util.php",
    ]);
  });
});

describe("pint", () => {
  it("reports each rule each file breaks, and nothing on a pass", () => {
    const root = tmp("vk-pint-");
    expect(
      brief(
        pint,
        ran(
          1,
          '{"tool":"pint","result":"fail","files":[{"path":"src\\/Other.php","fixers":["single_line_empty_body"]},{"path":"src\\/Util.php","fixers":["array_syntax"]}]}',
        ),
        ctx(root),
      ),
    ).toEqual([
      ["src/Other.php", 1, 1, "single_line_empty_body", "warning"],
      ["src/Util.php", 1, 1, "array_syntax", "warning"],
    ]);
    expect(
      pint.parseOutput(ran(0, '{"tool":"pint","result":"passed"}'), ctx(root))
        .findings,
    ).toEqual([]);
  });

  it("fails loud on its errors, which it prints on stdout", () => {
    const root = tmp("vk-pint-");
    expect(() =>
      pint.parseOutput(
        ran(
          1,
          '\nIn ConfigurationResolver.php line 409:\n                                        \n  The path "nope.php" is not readable.  \n                                        \n\n',
        ),
        ctx(root),
      ),
    ).toThrow(/The path "nope\.php" is not readable\./);
  });

  it("runs where pint.json or composer.json chose it", () => {
    const root = project({
      "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}',
    });
    expect(pint.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "composer.json"),
      '{"require-dev":{"laravel/pint":"^1.32"}}',
    );
    expect(pint.adoptedAt?.(root, root)).toBe(true);
    expect(
      pint.buildArgs(ctx(root, { files: [`${root}/src/A.php`] })).args,
    ).toEqual(["--test", "--format=json", "src/A.php"]);
  });
});

describe("mix format", () => {
  const E = String.fromCharCode(27);

  it("reports each changed run of an unformatted file, ANSI stripped", () => {
    const root = tmp("vk-mix-format-");
    const stderr = `** (Mix) mix format failed due to --check-formatted.\nThe following files are not formatted:\n\n${E}[1m${E}[31m${root}/lib/ugly.ex\n${E}[0m\n     |\n2 2  |  @moduledoc false\n3 3  |\n4   -|  def  add(a,b),do: a+b\n  4 +|  def add(a, b), do: a + b\n5 5  |end\n6 6  |\n\n\n\n`;
    expect(brief(mixFormat, ran(1, "", stderr), ctx(root))).toEqual([
      ["lib/ugly.ex", 4, 1, undefined, "warning"],
    ]);
    expect(mixFormat.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
  });

  it("reports a file that does not parse, and fails loud on a missing file", () => {
    const root = tmp("vk-mix-format-");
    const syntax =
      "mix format failed for file: lib/broken.ex\n** (MismatchedDelimiterError) mismatched delimiter found on lib/broken.ex:3:1:\n    error: unexpected reserved word: end\n";
    expect(brief(mixFormat, ran(1, "", syntax), ctx(root))).toEqual([
      ["lib/broken.ex", 3, 1, "syntax", "error"],
    ]);
    expect(() =>
      mixFormat.parseOutput(
        ran(
          1,
          "",
          '** (Mix) Could not find a file to format. The files/patterns given to command line did not point to any existing file. Got: ["lib/nope.ex"]\n',
        ),
        ctx(root),
      ),
    ).toThrow(/Could not find a file to format/);
  });

  it("runs where a .formatter.exs is, and reads Mix's version past Erlang's banner", () => {
    const root = project({ "mix.exs": "" });
    expect(mixFormat.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(join(root, ".formatter.exs"), "[inputs: []]\n");
    expect(mixFormat.adoptedAt?.(root, root)).toBe(true);
    expect(
      mixFormat.parseVersion?.(
        "Erlang/OTP 29 [erts-17.1.1] [source] [64-bit]\n\nMix 1.20.4 (compiled with Erlang/OTP 29)\n",
      ),
    ).toBe("1.20.4");
  });

  it("says it cannot run when its .formatter.exs imports deps that are not fetched, or Hex is missing", () => {
    const root = project({
      "mix.exs": "",
      ".formatter.exs": '[\n  inputs: ["lib/**/*.ex"]\n]\n',
    });
    const mixHome = tmp("vk-mix-format-mix-home-");
    vi.stubEnv("MIX_HOME", mixHome);
    vi.stubEnv("MIX_ARCHIVES", undefined);
    try {
      const plan = () =>
        ((mixFormat.expand?.({ cwd: root }, env(root)) ?? []) as TaskSeed[])[0];
      // Without import_deps it needs neither (dotnet-ruby-php-elixir.md, 7).
      expect(plan()).toEqual({ cwd: root });
      writeFileSync(
        join(root, ".formatter.exs"),
        '[\n  import_deps: [:phoenix],\n  inputs: ["lib/**/*.ex"]\n]\n',
      );
      expect(plan()?.cannotRun).toMatch(/not fetched: run `mix deps\.get`/);
      mkdirSync(join(root, "deps"));
      expect(plan()?.cannotRun).toMatch(/mix local\.hex/);
      mkdirSync(join(mixHome, "archives", "hex-2.5.3"), { recursive: true });
      expect(plan()).toEqual({ cwd: root });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("credo", () => {
  const issues = `{
  "issues": [
    {
      "category": "warning",
      "check": "Credo.Check.Warning.IoInspect",
      "column": 5,
      "column_end": 15,
      "filename": "lib/fixture.ex",
      "line_no": 5,
      "message": "There should be no calls to \`IO.inspect/1\`.",
      "priority": 12,
      "scope": "Fixture.run",
      "trigger": "IO.inspect"
    },
    {
      "category": "readability",
      "check": "Credo.Check.Readability.SpaceAfterCommas",
      "column": 13,
      "column_end": 15,
      "filename": "lib/ugly.ex",
      "line_no": 4,
      "message": "Space missing after comma.",
      "priority": 2,
      "scope": "Ugly.add",
      "trigger": ",b"
    }
  ]
}
`;
  const cold =
    "\n01:30:39.741 [info] Compiling file system watcher for Mac...\n\n01:30:40.496 [info] Done.\n==> credo\nCompiling 257 files (.ex)\nGenerated credo app\n";

  it("reads the JSON after a cold run's compile output; readability gates as Credo's own run does", () => {
    const root = tmp("vk-credo-");
    expect(brief(credo, ran(20, cold + issues), ctx(root))).toEqual([
      ["lib/fixture.ex", 5, 5, "Credo.Check.Warning.IoInspect", "warning"],
      [
        "lib/ugly.ex",
        4,
        13,
        "Credo.Check.Readability.SpaceAfterCommas",
        "warning",
      ],
    ]);
    expect(
      brief(
        credo,
        ran(
          20,
          issues,
          "info: Some source files could not be parsed correctly and are excluded:\n\n   1) lib/broken.ex\n\n\n",
        ),
        ctx(root),
      ).at(-1),
    ).toEqual(["lib/broken.ex", 1, 1, "parse", "error"]);
    expect(
      credo.parseOutput(ran(0, '{\n  "issues": []\n}\n'), ctx(root)).findings,
    ).toEqual([]);
  });

  it("fails loud when there is no JSON (a missing file, a usage error)", () => {
    const root = tmp("vk-credo-");
    expect(() =>
      credo.parseOutput(
        ran(
          1,
          "\n01:30:47.395 [error] Task #PID<0.172.0> started from #PID<0.94.0> terminating\n",
          `** (EXIT from #PID<0.94.0>) an exception was raised:\n    ** (File.Error) could not read file "${root}/lib/nope.ex": no such file or directory\n`,
        ),
        ctx(root),
      ),
    ).toThrow(/File\.Error\) could not read file/);
    expect(() =>
      credo.parseOutput(
        ran(
          130,
          "",
          "** (credo) Unknown switch for `suggest` command: --bogus-flag\n",
        ),
        ctx(root),
      ),
    ).toThrow(/Unknown switch/);
  });

  it("runs where mix.exs (or its umbrella's) depends on credo, from there, and says so when it is not fetched or Hex is missing", () => {
    const root = project({
      "mix.exs": 'defp deps do\n  # {:credo, "~> 1.7"}\n  []\nend\n',
      "apps/foo/mix.exs": "deps: []\n",
    });
    const mixHome = tmp("vk-credo-mix-home-");
    vi.stubEnv("MIX_HOME", mixHome);
    vi.stubEnv("MIX_ARCHIVES", undefined);
    try {
      const plan = (cwd = root) => credo.expand?.({ cwd }, env(root));
      const cannot = (cwd = root) => ((plan(cwd) ?? []) as TaskSeed[])[0];
      expect(plan()).toEqual([]);
      writeFileSync(
        join(root, "mix.exs"),
        'defp deps do\n  [{:credo, "~> 1.7", only: [:dev, :test], runtime: false}]\nend\n',
      );
      expect(cannot()?.cannotRun).toMatch(/mix deps\.get/);
      mkdirSync(join(root, "deps", "credo"), { recursive: true });
      // No Hex archive: Mix would ask on stdin to install it, then fail.
      expect(cannot()?.cannotRun).toMatch(/mix local\.hex/);
      mkdirSync(join(mixHome, "archives", "hex-2.5.3"), { recursive: true });
      expect(plan()).toEqual([{ cwd: root }]);
      // An umbrella app's files run from the root that declares credo.
      expect(plan(`${root}/apps/foo`)).toEqual([{ cwd: root }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
