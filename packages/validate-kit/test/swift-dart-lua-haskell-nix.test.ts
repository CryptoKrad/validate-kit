import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batchThenEach, eachRun, type EachRun } from "../src/adapters/base.js";
import { buildifier } from "../src/adapters/buildifier.js";
import { dartAnalyze, dartFormat } from "../src/adapters/dart.js";
import { deadnix } from "../src/adapters/deadnix.js";
import { hlint } from "../src/adapters/hlint.js";
import { nixfmt } from "../src/adapters/nixfmt.js";
import { ocamlformat } from "../src/adapters/ocamlformat.js";
import { ormolu } from "../src/adapters/ormolu.js";
import { selene } from "../src/adapters/selene.js";
import { statix } from "../src/adapters/statix.js";
import { stylua } from "../src/adapters/stylua.js";
import { swiftFormat } from "../src/adapters/swift-format.js";
import { swiftlint } from "../src/adapters/swiftlint.js";
import type {
  Finding,
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolAdapter,
  ToolConfig,
  ToolContext,
} from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// Every output below was recorded from a real run on 2026-10-18 against a
// fixture with one problem planted, then trimmed: swift-format 604.0.0,
// SwiftLint 0.65.1, Dart 3.13.5, StyLua 2.6.0, selene 0.32.0, hlint 3.10,
// ormolu 0.9.0.0, ocamlformat 0.29.0, nixfmt 1.5.0, statix 0.5.8, deadnix
// 1.3.1, buildifier 10.1.0
// (docs/research/lint-toolchain/sota-2026-10-18/swift-dart-lua-haskell-nix.md;
// the bytes are in docs/research/lint-toolchain/assets/sota-2026-10-18/).

/** A new folder, by its real path (tmpdir is a symlink on macOS). */
function tmp(): string {
  return toPosix(realpathSync(mkdtempSync(join(tmpdir(), "vk-sdlhn-"))));
}

/** Writes each file (relative to `root`), "" for an empty one. */
function files(root: string, entries: Record<string, string>): string[] {
  return Object.entries(entries).map(([path, text]) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return toPosix(file);
  });
}

function ctx(
  cwd: string,
  list: string[],
  extra: Partial<ToolContext> = {},
): ToolContext {
  return { cwd, files: list, fix: false, extraArgs: [], ...extra };
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

function expand(
  adapter: ToolAdapter,
  root: string,
  seedFiles: string[],
  toolConfig: ToolConfig = {},
  seedCwd = root,
): TaskSeed[] {
  const env = {
    projectRoot: root,
    scopedFiles: [],
    toolConfig,
  } as unknown as PlanEnv;
  return adapter.expand?.(
    { cwd: seedCwd, files: seedFiles },
    env,
  ) as TaskSeed[];
}

/** file (relative to root), line, col, rule, severity. */
const brief = (root: string, findings: Finding[]) =>
  findings.map((f) => [
    f.file.slice(root.length + 1),
    f.line,
    f.col,
    f.ruleId,
    f.severity,
  ]);

describe("the per-config tools run where the project chose them", () => {
  // [adapter, a file it checks, its config file]
  const cases: [ToolAdapter, string, string][] = [
    [swiftFormat, "Sources/A.swift", ".swift-format"],
    [stylua, "src/a.lua", "stylua.toml"],
    [selene, "src/a.lua", "selene.toml"],
    [hlint, "src/A.hs", ".hlint.yaml"],
    [ormolu, "src/A.hs", ".ormolu"],
    [ocamlformat, "src/a.ml", ".ocamlformat"],
    [statix, "src/a.nix", "statix.toml"],
  ];
  it.each(cases)("%s", (adapter, path, config) => {
    const root = tmp();
    const [file = ""] = files(root, { [path]: "x\n" });
    const missing = `${root}/src/gone${path.slice(path.lastIndexOf("."))}`;
    expect(expand(adapter, root, [file, missing])).toEqual([]);
    expect(expand(adapter, root, [file], { enabled: true })).toEqual([
      { cwd: root, files: [file] },
    ]);
    // Its config one folder up from the file: it runs from that folder,
    // and never on a file that does not exist.
    files(root, { [`${path.split("/")[0] ?? ""}/${config}`]: "" });
    expect(expand(adapter, root, [file, missing])).toEqual([
      { cwd: `${root}/${path.split("/")[0] ?? ""}`, files: [file] },
    ]);
  });

  it("nixfmt and deadnix only when enabled; statix one file per task", () => {
    const root = tmp();
    const list = files(root, { "a.nix": "", "b.nix": "" });
    for (const adapter of [nixfmt, deadnix]) {
      expect(expand(adapter, root, list)).toEqual([]);
      expect(expand(adapter, root, list, { enabled: true })).toEqual([
        { cwd: root, files: list },
      ]);
    }
    expect(expand(statix, root, list, { enabled: true })).toEqual(
      list.map((f) => ({ cwd: root, files: [f] })),
    );
  });
});

describe("swift-format", () => {
  it("reports each finding of `lint --strict` and a file that does not parse", () => {
    const root = tmp();
    const result = swiftFormat.parseOutput(
      ran(
        1,
        "",
        "Sources/Bad.swift:1:6: error: [Spacing] remove 2 spaces\n" +
          "Sources/Bad.swift:2:14: error: [Spacing] add 1 space\n" +
          "Broken.swift:1:6: error: expected identifier in function\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["Sources/Bad.swift", 1, 6, "Spacing", "warning"],
      ["Sources/Bad.swift", 2, 14, "Spacing", "warning"],
      ["Broken.swift", 1, 6, "syntax-error", "error"],
    ]);
    expect(result.findings.map((f) => [f.message, f.fixable])).toEqual([
      ["remove 2 spaces", true],
      ["add 1 space", true],
      ["expected identifier in function", false],
    ]);
    expect(() =>
      swiftFormat.parseOutput(
        ran(
          1,
          "",
          "<unknown>: error: Unable to read configuration: The file “nope.json” couldn’t be opened because there is no such file.\n",
        ),
        ctx(root, []),
      ),
    ).toThrow(/Unable to read configuration/);
    const [file = ""] = files(root, { "Sources/A.swift": "" });
    expect(swiftFormat.buildArgs(ctx(root, [file])).args).toEqual([
      "lint",
      "--strict",
      "--no-color-diagnostics",
      "Sources/A.swift",
    ]);
    expect(
      swiftFormat.buildArgs(ctx(root, [file], { fix: true })).args.slice(0, 2),
    ).toEqual(["format", "--in-place"]);
  });

  it("counts columns in characters, maps the real path, and knows what format fixes", () => {
    const root = tmp();
    files(root, { "a.swift": 'let s = "ééé";\nvar Bad_Name = 2\n' });
    // A symlinked spelling of the folder: swift-format prints the real one.
    const link = `${tmp()}/link`;
    symlinkSync(root, link);
    const result = swiftFormat.parseOutput(
      ran(
        1,
        "",
        `${root}/a.swift:1:17: error: [DoNotUseSemicolons] remove ';'\n` +
          `${root}/a.swift:2:5: error: [AlwaysUseLowerCamelCase] rename the variable 'Bad_Name' using lowerCamelCase\n`,
      ),
      ctx(link, []),
    );
    expect(
      result.findings.map((f) => [f.file, f.line, f.col, f.fixable]),
    ).toEqual([
      [`${link}/a.swift`, 1, 14, true],
      [`${link}/a.swift`, 2, 5, false],
    ]);
  });
});

describe("swiftlint", () => {
  it("reports each violation at its severity; all files excluded is no finding", () => {
    const root = tmp();
    const json = `[
  {
    "character" : 6,
    "file" : "${root}/Sources/Bad.swift",
    "line" : 5,
    "reason" : "Colons should be next to the identifier when specifying a type and next to the key in dictionary literals",
    "rule_id" : "colon",
    "severity" : "Warning",
    "type" : "Colon Spacing"
  },
  {
    "character" : 5,
    "file" : "${root}/Sources/Bad.swift",
    "line" : 5,
    "reason" : "Variable name 'x' should be between 3 and 40 characters long",
    "rule_id" : "identifier_name",
    "severity" : "Error",
    "type" : "Identifier Name"
  }
]
`;
    const result = swiftlint.parseOutput(ran(2, json), ctx(root, []));
    expect(brief(root, result.findings)).toEqual([
      ["Sources/Bad.swift", 5, 6, "colon", "warning"],
      ["Sources/Bad.swift", 5, 5, "identifier_name", "error"],
    ]);
    expect(
      swiftlint.parseOutput(ran(0, "[\n\n]\n"), ctx(root, [])).findings,
    ).toEqual([]);
    // Recorded by the builder: `--force-exclude` on a path in `excluded`.
    expect(
      swiftlint.parseOutput(
        ran(
          1,
          "",
          "Error: No lintable files found at paths: 'Sources/Bad.swift'\n",
        ),
        ctx(root, []),
      ).rawExitCode,
    ).toBe(0);
    expect(() =>
      swiftlint.parseOutput(
        ran(1, "", "Error: SCRIPT_INPUT_FILE_COUNT variable not set\n"),
        ctx(root, []),
      ),
    ).toThrow(/SCRIPT_INPUT_FILE_COUNT/);
    expect(swiftlint.refuseArgs?.(["--config", "x.yml"])).toMatch(/configPath/);
  });

  it("runs from the highest .swiftlint.yml above the file", () => {
    const root = tmp();
    const [file = ""] = files(root, { "app/Sources/A.swift": "" });
    expect(expand(swiftlint, root, [file])).toEqual([]);
    files(root, { "app/Sources/.swiftlint.yml": "", "app/.swiftlint.yml": "" });
    expect(expand(swiftlint, root, [file])).toEqual([
      { cwd: `${root}/app`, files: [file] },
    ]);
  });

  // SwiftLint never exits (past kill -9) on a config it cannot read: it is
  // never spawned on one. The review's swl7 config, then the configs it may
  // name.
  it.each([
    ["identifier_name:\n  min_length: 1\n  bad: [unclosed\n", /does not parse/],
    ["- a\n- b\n", /is not a mapping/],
    ["parent_config: https://example.com/swiftlint.yml\n", /URL/],
    ["parent_config: ../gone.yml\n", /gone\.yml does not exist/],
  ])("cannot run on the config %j", (config, why) => {
    const root = tmp();
    const [file = ""] = files(root, {
      "app/Sources/A.swift": "",
      "app/.swiftlint.yml": "",
      "app/Sources/.swiftlint.yml": config,
    });
    expect(expand(swiftlint, root, [file])[0]?.cannotRun).toMatch(why);
  });
});

describe("dart", () => {
  it("dart analyze: each diagnostic at its severity, INFO not gating", () => {
    const root = tmp();
    const json = `{"version":1,"diagnostics":[{"code":"invalid_assignment","severity":"ERROR","type":"COMPILE_TIME_ERROR","location":{"file":"${root}/lib/bad.dart","range":{"start":{"offset":36,"line":3,"column":11},"end":{"offset":42,"line":3,"column":17}}},"problemMessage":"A value of type 'String' can't be assigned to a variable of type 'int'.","correctionMessage":"Try changing the type of the variable, or casting the right-hand type to 'int'.","documentation":"https://dart.dev/diagnostics/invalid_assignment"},{"code":"prefer_single_quotes","severity":"INFO","type":"LINT","location":{"file":"${root}/lib/info.dart","range":{"start":{"offset":22,"line":2,"column":9},"end":{"offset":26,"line":2,"column":13}}},"problemMessage":"Unnecessary use of double quotes.","correctionMessage":"Try using single quotes unless the string contains single quotes.","documentation":"https://dart.dev/diagnostics/prefer_single_quotes"}]}\n`;
    const result = dartAnalyze.parseOutput(ran(3, json), ctx(root, []));
    expect(brief(root, result.findings)).toEqual([
      ["lib/bad.dart", 3, 11, "invalid_assignment", "error"],
      ["lib/info.dart", 2, 9, "prefer_single_quotes", "info"],
    ]);
    expect(
      dartAnalyze.parseOutput(
        ran(0, '{"version":1,"diagnostics":[]}\n'),
        ctx(root, []),
      ).findings,
    ).toEqual([]);
    expect(() =>
      dartAnalyze.parseOutput(
        ran(0, '{"version":2,"diagnostics":[]}\n'),
        ctx(root, []),
      ),
    ).toThrow(/version 1/);
  });

  it("dart analyze: dependencies never fetched cannot run", () => {
    const root = tmp();
    const [file = ""] = files(root, {
      "pubspec.yaml":
        "name: demo\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  path: ^1.9.0\n",
      "lib/d.dart": "",
    });
    expect(expand(dartAnalyze, root, [file])[0]?.cannotRun).toMatch(
      /run `dart pub get`/,
    );
    files(root, { ".dart_tool/package_config.json": "{}" });
    expect(expand(dartAnalyze, root, [file])[0]?.cannotRun).toBeUndefined();
    expect(dartAnalyze.adoptedAt?.(root, root)).toBe(false);
    files(root, { "analysis_options.yaml": "" });
    expect(dartAnalyze.adoptedAt?.(root, root)).toBe(true);
    // A package below one that was fetched: its own were not (review d5),
    // unless it is a member of that pub workspace.
    const [example = ""] = files(root, {
      "example/pubspec.yaml":
        "name: example\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  path: ^1.9.0\n",
      "example/lib/main.dart": "",
    });
    const nested = (cwd: string) =>
      expand(dartAnalyze, root, [example], {}, cwd)[0]?.cannotRun;
    expect(nested(`${root}/example`)).toMatch(/run `dart pub get`/);
    files(root, {
      "example/pubspec.yaml":
        "name: example\nresolution: workspace\ndependencies:\n  path: ^1.9.0\n",
    });
    expect(nested(`${root}/example`)).toBeUndefined();
  });

  it("dart analyze: names each file's analysis_options.yaml, whose parse error exits 3 with no diagnostic", () => {
    const root = tmp();
    const [file = ""] = files(root, {
      "lib/a.dart": "",
      "pubspec.yaml": "name: demo\n",
      "analysis_options.yaml": "bad: [unclosed\n",
    });
    const [task] = expand(dartAnalyze, root, [file]);
    const run = ctx(root, task?.files ?? [], { options: task?.options });
    expect(dartAnalyze.buildArgs(run).args.slice(-2)).toEqual([
      "lib/a.dart",
      "analysis_options.yaml",
    ]);
    // Recorded on the review's d7: `{"version":1,"diagnostics":[]}`, exit 3.
    expect(() =>
      dartAnalyze.parseOutput(ran(3, '{"version":1,"diagnostics":[]}\n'), run),
    ).toThrow(/analysis_options\.yaml does not parse/);
  });

  it("dart format: each changed file, each parse error, and a silent miss is a crash", () => {
    const root = tmp();
    const result = dartFormat.parseOutput(
      ran(
        1,
        "Changed lib/bad.dart\nFormatted 2 files (1 changed) in 0.01 seconds.\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["lib/bad.dart", 1, 1, "format", "warning"],
    ]);
    const broken = dartFormat.parseOutput(
      ran(
        65,
        "Formatted no files in 0.00 seconds.\n",
        "Could not format because the source could not be parsed:\n\nline 1, column 13 of lib/broken.dart: Expected an identifier.\n  ╷\n1 │ void main( {\n  │             ^\n  ╵\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, broken.findings)).toEqual([
      ["lib/broken.dart", 1, 13, "syntax-error", "error"],
    ]);
    // An unparsable file listed before a changed one: exit 1, not 65 (d2).
    const both = dartFormat.parseOutput(
      ran(
        1,
        "Changed lib/bad.dart\nFormatted 2 files (1 changed) in 0.01 seconds.\n",
        "Could not format because the source could not be parsed:\n\nline 2, column 1 of lib/a_broken.dart: Expected an identifier.\n  ╷\n2 │ \n  │ ^\n  ╵\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, both.findings)).toEqual([
      ["lib/bad.dart", 1, 1, "format", "warning"],
      ["lib/a_broken.dart", 2, 1, "syntax-error", "error"],
    ]);
    expect(() =>
      dartFormat.parseOutput(
        ran(
          0,
          "Formatted no files in 0.00 seconds.\n",
          'No file or directory found at "nope".\n',
        ),
        ctx(root, []),
      ),
    ).toThrow(/No file or directory found/);
  });
});

describe("stylua", () => {
  it("reports each hunk (0-based lines) and the parse errors it prints on stderr", () => {
    const root = tmp();
    const result = stylua.parseOutput(
      ran(
        1,
        '{"file":"bad.lua","mismatches":[{"expected":"local x = 1\\n","expected_end_line":2,"expected_start_line":0,"original":"local x   =   1\\n","original_end_line":2,"original_start_line":0}]}\n',
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["bad.lua", 1, 1, "format", "warning"],
    ]);
    // JSON mode: a syntax error exits 0.
    const broken = stylua.parseOutput(
      ran(
        0,
        "",
        '[{"filename":"broken.lua","location":{"end":9,"end_column":10,"end_line":1,"start":8,"start_column":9,"start_line":1},"message":"unexpected token `=`: expected an expression","type":"parse_error"}]',
      ),
      ctx(root, []),
    );
    expect(brief(root, broken.findings)).toEqual([
      ["broken.lua", 1, 9, "syntax-error", "error"],
    ]);
    // Two files that do not parse: two arrays back to back (recorded on
    // the review's st1).
    const two = stylua.parseOutput(
      ran(
        0,
        "",
        '[{"filename":"broken[2].lua","location":{"end":18,"end_column":1,"end_line":2,"start":18,"start_column":1,"start_line":2},"message":"unexpected token ``: expected a parameter name or `)`","type":"parse_error"}][{"filename":"broken one.lua","location":{"end":9,"end_column":10,"end_line":1,"start":8,"start_column":9,"start_line":1},"message":"unexpected token `=`: expected an expression","type":"parse_error"}]',
      ),
      ctx(root, []),
    );
    expect(brief(root, two.findings)).toEqual([
      ["broken[2].lua", 2, 1, "syntax-error", "error"],
      ["broken one.lua", 1, 9, "syntax-error", "error"],
    ]);
    expect(() =>
      stylua.parseOutput(
        ran(0, "", '[{"filename":"a.lua"}] trailing'),
        ctx(root, []),
      ),
    ).toThrow(/invalid JSON/);
    expect(() =>
      stylua.parseOutput(
        ran(0, "", "error: Found argument '--bogus' which wasn't expected\n"),
        ctx(root, []),
      ),
    ).toThrow(/--bogus/);
  });
});

describe("selene", () => {
  it("reports each diagnostic (0-based positions); stderr or no summary is a crash", () => {
    const root = tmp();
    const out =
      '{"type":"Diagnostic","severity":"Warning","code":"unused_variable","message":"unused is assigned a value, but never used","primary_label":{"filename":"bad.lua","span":{"start":6,"start_line":0,"start_column":6,"end":12,"end_line":0,"end_column":12},"message":""},"notes":[],"secondary_labels":[]}\n' +
      '{"type":"Diagnostic","severity":"Error","code":"undefined_variable","message":"`undefined_thing` is not defined","primary_label":{"filename":"bad.lua","span":{"start":23,"start_line":1,"start_column":6,"end":38,"end_line":1,"end_column":21},"message":""},"notes":[],"secondary_labels":[]}\n' +
      '{"type":"Summary","errors":1,"warnings":1,"parse_errors":0}\n';
    expect(
      brief(root, selene.parseOutput(ran(1, out), ctx(root, [])).findings),
    ).toEqual([
      ["bad.lua", 1, 7, "unused_variable", "warning"],
      ["bad.lua", 2, 7, "undefined_variable", "error"],
    ]);
    expect(() =>
      selene.parseOutput(
        ran(
          1,
          '{"type":"Summary","errors":1,"warnings":0,"parse_errors":0}\n',
          "ERROR: Error getting metadata of nope.lua: No such file or directory (os error 2)\n",
        ),
        ctx(root, []),
      ),
    ).toThrow(/Error getting metadata/);
    expect(() => selene.parseOutput(ran(0, ""), ctx(root, []))).toThrow(
      /no summary/,
    );
  });

  it("cannot run where std would be downloaded (Roblox), unless pinned", () => {
    const root = tmp();
    const [file = ""] = files(root, {
      "a.lua": "print(game)\n",
      "selene.toml": 'std = "roblox+testez"\n',
    });
    expect(expand(selene, root, [file])[0]?.cannotRun).toMatch(
      /selene generate-roblox-std/,
    );
    files(root, {
      "selene.toml": 'std = "roblox"\nroblox-std-source = "pinned"\n',
    });
    expect(expand(selene, root, [file])[0]?.cannotRun).toBeUndefined();
  });
});

describe("hlint", () => {
  it("reports each idea; a parse error is one; a missing file is a crash", () => {
    const root = tmp();
    const out =
      '[{"module":["Bad"],"decl":["foo"],"severity":"Warning","hint":"Avoid lambda","file":"Bad.hs","startLine":4,"startColumn":14,"endLine":4,"endColumn":28,"from":"(\\\\ x -> succ x)","to":"succ","note":[],"refactorings":"[]"}\n' +
      ',{"module":[],"decl":[],"severity":"Error","hint":"Parse error: on input `=\'","file":"Broken.hs","startLine":2,"startColumn":7,"endLine":2,"endColumn":8,"from":"  module Broken where\\n> foo = = 1\\n","to":null,"note":[],"refactorings":"[]"}]\n';
    const result = hlint.parseOutput(ran(1, out), ctx(root, []));
    expect(brief(root, result.findings)).toEqual([
      ["Bad.hs", 4, 14, "Avoid lambda", "warning"],
      ["Broken.hs", 2, 7, "parse-error", "error"],
    ]);
    expect(result.findings[0]?.message).toBe("Avoid lambda: use `succ`");
    expect(() =>
      hlint.parseOutput(
        ran(1, "", "Couldn't find file: Nope.hs\n"),
        ctx(root, []),
      ),
    ).toThrow(/Couldn't find file/);
  });
});

/** batchThenEach's report: each file's own run, as its wrapper prints it. */
const each = (exitCode: number, runs: EachRun[]): RawOutput =>
  ran(exitCode, JSON.stringify(runs));

describe("batchThenEach", () => {
  it("runs every file at once, and each alone only when that fails", () => {
    const root = tmp();
    const [tool = ""] = files(root, {
      // A stand-in tool: options, then files; a file named bad* fails.
      "tool.sh":
        '#!/bin/sh\necho "$*" >> calls.log\nfor f; do case $f in bad*) echo "$f: no" >&2; exit 4;; esac; done\n',
    });
    chmodSync(tool, 0o755);
    const call = (list: string[]) => {
      const cmd = batchThenEach(tool, ["--check"], list);
      const out = spawnSync(cmd.bin, cmd.args, { cwd: root, encoding: "utf8" });
      return eachRun("tool", {
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.status ?? -1,
      });
    };
    expect(call(["a.ml", "b.ml"])).toEqual([]);
    expect(call(["a.ml", "bad.ml"])).toEqual([
      { file: "a.ml", status: 0, out: "" },
      { file: "bad.ml", status: 4, out: "bad.ml: no\n" },
    ]);
  });
});

describe("ormolu", () => {
  it("reports each file's hunks at their first changed line, and a GHC parse error", () => {
    const root = tmp();
    const result = ormolu.parseOutput(
      each(100, [
        {
          file: "Bad.hs",
          status: 100,
          out: "Bad.hs\n@@ -1,4 +1,5 @@\n  module Bad where\n- foo::Int->Int\n- foo x   =   x+1\n\n+ foo :: Int -> Int\n+ foo x = x + 1\n+\n",
        },
        {
          file: "Broken.hs",
          status: 3,
          out: "Broken.hs:2:7\n  The GHC parser (in Haddock mode) failed:\n  [GHC-58481] parse error on input `='\n",
        },
        { file: "Good.hs", status: 0, out: "" },
      ]),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["Bad.hs", 2, 1, "format", "warning"],
      ["Broken.hs", 2, 7, "syntax-error", "error"],
    ]);
    expect(ormolu.parseOutput(ran(0), ctx(root, [])).findings).toEqual([]);
    expect(() =>
      ormolu.parseOutput(
        each(1, [
          {
            file: "Nope.hs",
            status: 1,
            out: "ormolu: Uncaught exception ghc-internal:GHC.Internal.IO.Exception.IOException:\n",
          },
        ]),
        ctx(root, []),
      ),
    ).toThrow(/ormolu failed on Nope.hs \(exit 1\)/);
  });
});

describe("ocamlformat", () => {
  it("exit 1 with no output is the file; any other text is a crash", () => {
    const root = tmp();
    files(root, { "utf.ml": 'let s = "ééé" = = 1\n' });
    expect(
      brief(
        root,
        ocamlformat.parseOutput(
          each(1, [
            { file: "bad.ml", status: 1, out: "" },
            {
              file: "utf.ml",
              status: 1,
              // `characters` counts bytes: the second `=` is character 17.
              out: 'ocamlformat: ignoring "utf.ml" (syntax error)\nFile "utf.ml", line 1, characters 19-20:\n1 | let s = "ééé" = = 1\n                       ^\nError: Syntax error\n',
            },
            { file: "good.ml", status: 0, out: "" },
          ]),
          ctx(root, []),
        ).findings,
      ),
    ).toEqual([
      ["bad.ml", 1, 1, "format", "warning"],
      ["utf.ml", 1, 17, "syntax-error", "error"],
    ]);
    expect(() =>
      ocamlformat.parseOutput(
        each(1, [
          {
            file: "bad.ml",
            status: 1,
            out: 'ocamlformat: Error while parsing\n             /x/.ocamlformat:\n             Project should be formatted using ocamlformat version "0.1.0",\n',
          },
        ]),
        ctx(root, []),
      ),
    ).toThrow(/version "0.1.0"/);
    // No .ocamlformat in the file's own project: it checked nothing.
    expect(() =>
      ocamlformat.parseOutput(
        each(0, [
          {
            file: "bad.ml",
            status: 0,
            out: 'File "bad.ml", line 1:\nWarning: Ocamlformat disabled because [--enable-outside-detected-project] is not set and no [.ocamlformat] was found within the project (root: ..)\n',
          },
        ]),
        ctx(root, []),
      ),
    ).toThrow(/Ocamlformat disabled/);
    expect(ocamlformat.buildArgs(ctx(root, [`${root}/bad.ml`])).env).toEqual({
      OCAMLFORMAT: "",
    });
  });

  it("stops looking for .ocamlformat at the file's project root, as ocamlformat does", () => {
    const root = tmp();
    const [top = "", sub = ""] = files(root, {
      "b.ml": "",
      "sub/a.ml": "",
      ".ocamlformat": "profile = default\n",
      "dune-project": "",
      "sub/dune-project": "",
    });
    // The review's oc2: sub/ is its own dune project with no .ocamlformat.
    expect(expand(ocamlformat, root, [top, sub])).toEqual([
      { cwd: root, files: [top] },
    ]);
  });
});

describe("nixfmt, statix, deadnix", () => {
  it("nixfmt: a file not formatted and a parse error; any other line is a crash", () => {
    const root = tmp();
    const result = nixfmt.parseOutput(
      ran(
        1,
        "",
        'bad.nix: not formatted\nbroken.nix:1:7:\n  |\n1 | { a = ; }\n  |       ^^^\nunexpected "; }<newline>"\nexpecting expression\n\n',
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["bad.nix", 1, 1, "format", "warning"],
      ["broken.nix", 1, 7, "syntax-error", "error"],
    ]);
    expect(result.findings[1]?.message).toBe(
      'unexpected "; }<newline>": expecting expression',
    );
    expect(() =>
      nixfmt.parseOutput(
        ran(
          1,
          "",
          "nixfmt: Uncaught exception ghc-internal:GHC.Internal.IO.Exception.IOException:\n",
        ),
        ctx(root, []),
      ),
    ).toThrow(/Uncaught exception/);
  });

  it("statix: errfmt lines; a missing path (exit 0, stderr) is a crash", () => {
    const root = tmp();
    const result = statix.parseOutput(
      ran(
        1,
        "./bad.nix>7:10:W:1:Comparing `a` with boolean literal `true`\nbroken.nix>1:7:E:0:Unexpected TOKEN_SEMICOLON at 6..7\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["bad.nix", 7, 10, "W01", "warning"],
      ["broken.nix", 1, 7, "syntax-error", "error"],
    ]);
    expect(() =>
      statix.parseOutput(
        ran(0, "", "config error: path error: file not found: nope.nix\n"),
        ctx(root, []),
      ),
    ).toThrow(/file not found/);
  });

  // The review's nx2/a.nix and sx2/all.nix, as statix and deadnix printed them.
  const NX2 =
    '{ unused }:\nlet\n  s = "ééé"; a = 1; d = 2;\nin { x = "ééé" + (if a == true then "y" else "z"); }\n';

  it("statix: byte columns as characters; one finding for a lint's several places", () => {
    const root = tmp();
    files(root, { "nx2/a.nix": NX2 });
    const result = statix.parseOutput(
      ran(
        1,
        "nx2/a.nix>4:25:W:1:Comparing `a` with boolean literal `true`\n" +
          "sx2/all.nix>12:9:W:20:The key `k` is first assigned here ...\n" +
          "sx2/all.nix>12:18:W:20:... repeated here ...\n" +
          "sx2/all.nix>12:27:W:20:... and here. Try `k = { b=...; c=...; d=...; }` instead.\n",
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["nx2/a.nix", 4, 22, "W01", "warning"],
      ["sx2/all.nix", 12, 9, "W20", "warning"],
    ]);
    expect(result.findings[1]?.message).toBe(
      "The key `k` is first assigned here, repeated here, and here. Try `k = { b=...; c=...; d=...; }` instead.",
    );
  });

  it("deadnix: each unused name; a parse error masks; a file it cannot read is a crash", () => {
    const root = tmp();
    files(root, { "nx2/a.nix": NX2, "broken.nix": "{ a = ; }\n" });
    const result = deadnix.parseOutput(
      ran(
        1,
        '{"file":"nx2/a.nix","results":[{"column":3,"endColumn":9,"line":1,"message":"Unused lambda pattern: unused"},{"column":24,"endColumn":25,"line":3,"message":"Unused let binding: d"}]}\n' +
          // Exit 0 even with --fail.
          '{"file":"broken.nix","results":[{"message":"unexpected TOKEN_SEMICOLON at 6..7, wanted any of [TOKEN_L_PAREN, TOKEN_REC, TOKEN_L_BRACE, TOKEN_L_BRACK, TOKEN_STRING_START, TOKEN_IDENT]"},{"message":"unexpected end of file"}]}\n',
      ),
      ctx(root, []),
    );
    expect(brief(root, result.findings)).toEqual([
      ["nx2/a.nix", 1, 3, "unused-lambda-pattern", "warning"],
      ["nx2/a.nix", 3, 21, "unused-let-binding", "warning"],
      ["broken.nix", 1, 7, "syntax-error", "error"],
    ]);
    expect(deadnix.masks?.(result.findings[2] as Finding)).toBe(true);
    expect(() =>
      deadnix.parseOutput(
        ran(
          0,
          '{"file":"nope.nix","results":[{"message":"No such file or directory (os error 2)"}]}\n',
        ),
        ctx(root, []),
      ),
    ).toThrow(/could not check nope.nix: No such file/);
  });
});

describe("buildifier", () => {
  it("reads the JSON (its exit is always 0): format, warnings, parse errors, missing files", () => {
    const root = tmp();
    const out =
      '{"success":false,"files":[{"filename":"BUILD","formatted":false,"valid":true,"warnings":[{"start":{"line":2,"column":1},"end":{"line":2,"column":2},"category":"unused-variable","actionable":true,"autoFixable":false,"message":"Variable \\"x\\" is unused. Please remove it.","url":"https://github.com/bazel-contrib/buildtools/blob/main/WARNINGS.md#unused-variable"}]}]}\n';
    const result = buildifier.parseOutput(
      ran(0, out),
      ctx(root, [`${root}/BUILD`]),
    );
    expect(brief(root, result.findings)).toEqual([
      ["BUILD", 1, 1, "format", "warning"],
      ["BUILD", 2, 1, "unused-variable", "warning"],
    ]);
    const broken = buildifier.parseOutput(
      ran(
        0,
        '{"success":false,"files":[{"filename":"BUILD","formatted":false,"valid":false,"warnings":[]}]}\n',
        "BUILD:3:1: syntax error\n",
      ),
      ctx(root, [`${root}/BUILD`]),
    );
    expect(brief(root, broken.findings)).toEqual([
      ["BUILD", 3, 1, "syntax-error", "error"],
    ]);
    expect(() =>
      buildifier.parseOutput(
        ran(
          0,
          '{"success":true,"files":[]}\n',
          "buildifier: open nope: no such file or directory\n",
        ),
        ctx(root, [`${root}/nope`]),
      ),
    ).toThrow(/no such file/);
  });

  it("is on in a Bazel workspace, and formats only under --fix", () => {
    const root = tmp();
    const [file = ""] = files(root, { BUILD: "" });
    expect(expand(buildifier, root, [file])).toEqual([]);
    expect(expand(buildifier, root, [file], { enabled: true })).toHaveLength(1);
    files(root, { "MODULE.bazel": "" });
    expect(expand(buildifier, root, [file])).toEqual([
      { cwd: root, files: [file] },
    ]);
    expect(buildifier.buildArgs(ctx(root, [file], { fix: true })).args).toEqual(
      ["-mode=fix", "-lint=off", "-format=", "BUILD"],
    );
  });
});
