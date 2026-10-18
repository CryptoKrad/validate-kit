import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cargoDeny } from "../src/adapters/cargo-deny.js";
import { govulncheck, jsonStream } from "../src/adapters/govulncheck.js";
import { mypy } from "../src/adapters/mypy.js";
import { goModulePath, nilaway } from "../src/adapters/nilaway.js";
import { slither } from "../src/adapters/slither.js";
import { toPosix } from "../src/detect/languages.js";
import type { ToolContext } from "../src/core/types.js";

// Every stdout and stderr below was captured from a real run on 2026-10-10
// (nilaway devel, govulncheck 1.3.0, mypy 2.0.0, cargo-deny 0.19.0, slither
// 0.11.6) against a fixture with the bug planted, then trimmed.

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, options?: unknown): ToolContext {
  return { cwd, fix: false, extraArgs: [], ...(options ? { options } : {}) };
}

describe("nilaway", () => {
  const root = tmp("vk-nilaway-");
  const file = `${root}/main.go`;
  const diag = {
    posn: `${file}:16:14`,
    end: `${file}:16:14`,
    message:
      "Potential nil panic detected. Observed nil flow from source to dereference point: \n\t- go/main.go:11:9: literal `nil` returned from `get()` in position 0\n",
  };

  it("reports a nil flow in scope, one line, and drops one outside it", () => {
    const stdout = JSON.stringify({
      "example.com/nilt": {
        nilaway: [diag, { ...diag, posn: `${root}/other.go:3:1` }],
      },
    });
    const result = nilaway.parseOutput(
      { stdout, stderr: "", exitCode: 0 },
      ctx(root, { scope: [file], module: "example.com/nilt" }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file,
      line: 16,
      col: 14,
      ruleId: "nil-panic",
      severity: "warning",
    });
    expect(result.findings[0]?.message).not.toContain("\n");
    expect(result.findings[0]?.message).toContain("go/main.go:11:9");
  });

  it("reports a type error as a masking finding, and fails loud on an analyzer error", () => {
    const typeError = nilaway.parseOutput(
      {
        stdout: "",
        stderr: `${root}/bad.go:2:28: cannot use "x" (untyped string constant) as int value in return statement\n`,
        exitCode: 1,
      },
      ctx(root, { scope: [] }),
    );
    const [first] = typeError.findings;
    expect(first).toMatchObject({ ruleId: "typecheck", severity: "error" });
    expect(first && nilaway.masks?.(first)).toBe(true);
    expect(() =>
      nilaway.parseOutput(
        {
          stdout: JSON.stringify({
            p: { nilaway: { error: "failed prerequisites" } },
          }),
          stderr: "",
          exitCode: 0,
        },
        ctx(root, { scope: [] }),
      ),
    ).toThrow(/failed prerequisites/);
  });

  it("passes the module path, so dependencies are not reported", () => {
    writeFileSync(join(root, "go.mod"), "module example.com/nilt\n\ngo 1.25\n");
    expect(goModulePath(root)).toBe("example.com/nilt");
    const built = nilaway.buildArgs(
      ctx(root, { scope: [], module: "example.com/nilt" }),
    );
    expect(built.args).toEqual([
      "-json",
      "-pretty-print=false",
      "-include-pkgs",
      "example.com/nilt",
      "./...",
    ]);
  });

  it("is opt-in: not adopted without the kit's config or a step that runs it", () => {
    expect(nilaway.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(join(root, "justfile"), "lint:\n    nilaway ./...\n");
    expect(nilaway.adoptedAt?.(root, root)).toBe(true);
  });
});

describe("govulncheck", () => {
  const root = tmp("vk-govuln-");
  // Indented JSON values, one after another, as -format json prints them.
  const stream = [
    { config: { scanner_version: "v1.3.0", scan_level: "symbol" } },
    { SBOM: { roots: ["example.com/gv"] } },
    {
      osv: {
        id: "GO-2021-0113",
        summary: "Out-of-bounds read in golang.org/x/text/language",
        aliases: ["CVE-2021-38561"],
      },
    },
    // Module level: imported, not called. osv-scanner's to report.
    {
      finding: {
        osv: "GO-2026-6599",
        fixed_version: "v1.26.9",
        trace: [{ module: "stdlib", version: "v1.26.6" }],
      },
    },
    {
      finding: {
        osv: "GO-2021-0113",
        fixed_version: "v0.3.7",
        trace: [
          {
            module: "golang.org/x/text",
            package: "golang.org/x/text/language",
            function: "Parse",
            position: { filename: "language/parse.go", line: 33, column: 6 },
          },
          {
            module: "example.com/gv",
            package: "example.com/gv",
            function: "main",
            position: { filename: "main.go", line: 10, column: 24 },
          },
        ],
      },
    },
  ]
    .map((v) => JSON.stringify(v, null, 2))
    .join("\n");

  it("reads concatenated JSON values, braces inside strings included", () => {
    expect(
      jsonStream<{ a: string }>('{"a": "}{"}\n{\n  "a": "\\"{"\n}'),
    ).toEqual([{ a: "}{" }, { a: '"{' }]);
  });

  it("gates only a reachable call, at the module's own line", () => {
    const result = govulncheck.parseOutput(
      { stdout: stream, stderr: "", exitCode: 0 },
      ctx(root),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: `${root}/main.go`,
      line: 10,
      col: 24,
      ruleId: "GO-2021-0113",
      severity: "error",
    });
    expect(result.findings[0]?.message).toContain(
      "golang.org/x/text/language.Parse",
    );
    expect(result.findings[0]?.message).toContain("fixed in v0.3.7");
  });

  it("fails loud on output without an SBOM", () => {
    expect(() =>
      govulncheck.parseOutput(
        { stdout: '{"config": {}}', stderr: "", exitCode: 0 },
        ctx(root),
      ),
    ).toThrow(/SBOM/);
  });
});

describe("mypy", () => {
  const root = tmp("vk-mypy-");

  it("maps JSON lines to 1-based findings and skips notes", () => {
    const stdout = [
      '{"file": "a.py", "line": 4, "column": 9, "end_line": 4, "end_column": 12, "message": "Incompatible types in assignment (expression has type \\"str\\", variable has type \\"int\\")", "hint": null, "code": "assignment", "severity": "error"}',
      '{"file": "a.py", "line": 5, "column": 0, "end_line": 5, "end_column": 1, "message": "Cannot find implementation or library stub for module named \\"notapkg\\"", "hint": "See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports", "code": "import-not-found", "severity": "error"}',
      '{"file": "a.py", "line": 5, "column": 0, "message": "Hint", "hint": null, "code": null, "severity": "note"}',
    ].join("\n");
    const result = mypy.parseOutput(
      { stdout, stderr: "", exitCode: 1 },
      ctx(root),
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      file: `${root}/a.py`,
      line: 4,
      col: 10,
      endCol: 13,
      ruleId: "assignment",
      severity: "error",
    });
    expect(result.findings[1]?.message).toContain("missing-imports");
  });

  it("reports a file it cannot parse (exit 2, text) as masking", () => {
    const result = mypy.parseOutput(
      {
        stdout:
          "b.py:1: error: Invalid syntax  [syntax]\nFound 1 error in 1 file (errors prevented further checking)\n",
        stderr: "",
        exitCode: 2,
      },
      ctx(root),
    );
    const [first] = result.findings;
    expect(first).toMatchObject({
      file: `${root}/b.py`,
      line: 1,
      ruleId: "syntax",
    });
    expect(first && mypy.masks?.(first)).toBe(true);
    expect(() =>
      mypy.parseOutput(
        {
          stdout: "",
          stderr: "mypy: error: unrecognized arguments",
          exitCode: 2,
        },
        ctx(root),
      ),
    ).toThrow(/mypy exited 2/);
  });

  it("is a crash when a blocking error with no line stopped it, whatever else it found", () => {
    // mypy 2.0.0 on src/pkg/m.py imported as both pkg.m and src.pkg.m.
    const stdout = [
      'src/pkg/m.py:1: error: Library stubs not installed for "requests"  [import-untyped]',
      'src/pkg/m.py:1: note: Hint: "python3 -m pip install types-requests"',
      'src/pkg/m.py: error: Source file found twice under different module names: "pkg.m" and "src.pkg.m"',
      "src/pkg/m.py: note: See https://mypy.readthedocs.io/en/stable/running_mypy.html#mapping-file-paths-to-modules for more info",
      "Found 2 errors in 1 file (errors prevented further checking)",
      "",
    ].join("\n");
    expect(() =>
      mypy.parseOutput({ stdout, stderr: "", exitCode: 2 }, ctx(root)),
    ).toThrow(/before checking the code: .*Source file found twice/);
  });

  it("reads a syntax error under `pretty = true`, whose echoed source line may hold `: error: `", () => {
    // mypy 2.0.0 --pretty: the failing line, indented, and a caret under it.
    const stdout = [
      "b.py:1: error: Invalid syntax  [syntax]",
      '    x = "parse: error: bad" +',
      "                            ^",
      "Found 1 error in 1 file (errors prevented further checking)",
      "",
    ].join("\n");
    expect(
      mypy.parseOutput({ stdout, stderr: "", exitCode: 2 }, ctx(root)).findings,
    ).toMatchObject([{ ruleId: "syntax", line: 1 }]);
    expect(() =>
      mypy.parseOutput({ stdout: "", stderr: "", exitCode: 2 }, ctx(root)),
    ).toThrow(/mypy exited 2/);
  });

  it("runs where the project configured it, with its virtualenv's interpreter", () => {
    expect(mypy.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\nname = "p"\n\n[tool.mypy]\nstrict = true\n',
    );
    expect(mypy.adoptedAt?.(root, root)).toBe(true);
    mkdirSync(join(root, ".venv", "bin"), { recursive: true });
    writeFileSync(join(root, ".venv", "bin", "python"), "");
    const { args } = mypy.buildArgs(ctx(root));
    expect(args).toContain("--python-executable");
    expect(args).toContain(join(root, ".venv", "bin", "python"));
  });
});

/** A crate in cargo-deny's graph JSON. */
function crateNode(name: string): string {
  return `{"Krate":{"name":"${name}","version":"0.1.0"}}`;
}

describe("cargo-deny", () => {
  const root = tmp("vk-deny-");
  const stderr = [
    '{"fields":{"code":"rejected","graphs":[{"Krate":{"name":"rs","version":"0.1.0"}}],"labels":[{"column":10,"line":5,"message":"","span":"MIT"},{"column":10,"line":5,"message":"rejected: license is not explicitly allowed","span":"MIT"}],"message":"failed to satisfy license requirements","notes":["MIT - MIT License:"],"severity":"error"},"type":"diagnostic"}',
    '{"fields":{"code":"banned","graphs":[{"Krate":{"name":"libc","version":"0.2.190"},"parents":[{"Krate":{"name":"rs","version":"0.1.0"}}]}],"labels":[{"column":20,"line":4,"message":"banned here","span":"libc"}],"message":"crate \'libc = 0.2.190\' is explicitly banned","severity":"error"},"type":"diagnostic"}',
    '{"fields":{"bans":{"errors":1,"helps":0,"notes":0,"warnings":0},"licenses":{"errors":1,"helps":1,"notes":0,"warnings":0},"sources":{"errors":0,"helps":0,"notes":0,"warnings":0}},"type":"summary"}',
  ].join("\n");

  it("places each diagnostic on the crate's Cargo.toml, naming the crate", () => {
    const result = cargoDeny.parseOutput(
      { stdout: "", stderr, exitCode: 6 },
      ctx(root),
    );
    expect(result.findings.map((f) => f.ruleId)).toEqual([
      "rejected",
      "banned",
    ]);
    expect(result.findings[1]).toMatchObject({
      file: `${root}/Cargo.toml`,
      severity: "error",
      message:
        "libc@0.2.190: crate 'libc = 0.2.190' is explicitly banned (banned here)",
    });
  });

  it("places a [bans] layer rule where each workspace crate declares the banned one", () => {
    // deny.toml: deny = [{ crate = "shop-db", wrappers = ["shop-api"],
    // reason = "the web layer goes through the API", use-instead =
    // "shop-api" }]; shop-web (under a renamed key) and shop-cli depend on
    // shop-db directly (cargo-deny 0.19.0, layer-rules.md).
    const ws = tmp("vk-deny-ws-");
    const manifests: Record<string, string> = {
      "db/Cargo.toml": '[package]\nname = "shop-db"\nversion = "0.1.0"\n',
      "api/Cargo.toml":
        '[package]\nname = "shop-api"\nversion = "0.1.0"\n\n[dependencies]\nshop-db = { path = "../db" }\n',
      "web/Cargo.toml":
        '[package]\nname = "shop-web"\nversion = "0.1.0"\n\n[dependencies]\nshop-api = { path = "../api" }\ndb = { package = "shop-db", path = "../db" }\n',
      // `authors` before `name`.
      "cli/Cargo.toml":
        '[package]\nauthors = ["a [at] b"]\nname = "shop-cli"\nversion = "0.1.0"\n\n[dependencies]\nshop-db = { path = "../db" }\n',
      // A vendored copy is not the workspace's crate.
      "vendor/web/Cargo.toml":
        '[package]\nname = "shop-web"\nversion = "0.1.0"\n\n[dependencies]\nshop-db = "1"\n',
    };
    for (const [path, text] of Object.entries(manifests)) {
      mkdirSync(join(ws, path, ".."), { recursive: true });
      writeFileSync(join(ws, path), text);
    }
    const graph = `"graphs":[{"Krate":{"name":"shop-db","version":"0.1.0"},"parents":[${crateNode("shop-api")},${crateNode("shop-web")},${crateNode("shop-cli")}]}],"labels":[{"column":20,"line":6,"message":"banned here","span":"shop-db"},{"column":65,"line":6,"message":"reason","span":"the web layer goes through the API"},{"column":117,"line":6,"message":"use instead","span":"shop-api"}]`;
    const unwrapped = (parent: string) =>
      `{"fields":{"code":"unmatched-wrapper",${graph},"message":"direct parent '${parent} = 0.1.0' of banned crate 'shop-db = 0.1.0' was not marked as a wrapper","severity":"warning"},"type":"diagnostic"}`;
    const bans = [
      unwrapped("shop-web"),
      unwrapped("shop-cli"),
      `{"fields":{"code":"banned",${graph},"message":"crate 'shop-db = 0.1.0' is explicitly banned","severity":"error"},"type":"diagnostic"}`,
      '{"fields":{"bans":{"errors":1,"helps":0,"notes":2,"warnings":2}},"type":"summary"}',
    ].join("\n");
    const result = cargoDeny.parseOutput(
      { stdout: "", stderr: bans, exitCode: 2 },
      ctx(ws),
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(ws.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["web/Cargo.toml", 7, "unmatched-wrapper", "warning"],
      ["cli/Cargo.toml", 7, "unmatched-wrapper", "warning"],
      ["web/Cargo.toml", 7, "banned", "error"],
    ]);
    expect(result.findings[2]?.message).toBe(
      "shop-db@0.1.0: crate 'shop-db = 0.1.0' is explicitly banned (the web layer goes through the API; use shop-api instead)",
    );
  });

  it("fails loud without a summary, or on a failing exit with no error", () => {
    expect(() =>
      cargoDeny.parseOutput(
        { stdout: "", stderr: "error: failed to parse deny.toml", exitCode: 1 },
        ctx(root),
      ),
    ).toThrow(/no summary/);
    const summaryOnly = stderr.split("\n").at(-1) ?? "";
    expect(() =>
      cargoDeny.parseOutput(
        { stdout: "", stderr: summaryOnly, exitCode: 2 },
        ctx(root),
      ),
    ).toThrow(/without an error/);
  });

  it("runs bans, licenses and sources unless the project names checks", () => {
    expect(cargoDeny.buildArgs(ctx(root)).args.slice(-3)).toEqual([
      "bans",
      "licenses",
      "sources",
    ]);
    expect(
      cargoDeny.buildArgs({ ...ctx(root), extraArgs: ["all"] }).args.at(-1),
    ).toBe("all");
    expect(cargoDeny.adoptedAt?.(root, root)).toBe(false);
    writeFileSync(join(root, "deny.toml"), "[bans]\n");
    expect(cargoDeny.adoptedAt?.(root, root)).toBe(true);
  });
});

/** One Slither detector result, as `--json -` prints it. */
function detector(check: string, impact: string, file: string) {
  return {
    check,
    impact,
    confidence: "Medium",
    description: `${check} in Bad.withdraw() (${file}#6-11):\n\tExternal calls:\n`,
    elements: [
      {
        source_mapping: {
          filename_relative: file,
          lines: [6, 7, 8],
          starting_column: 5,
        },
      },
    ],
    reference: `https://github.com/crytic/slither/wiki/Detector-Documentation#${check}`,
  };
}

describe("slither", () => {
  const root = tmp("vk-slither-");
  const bad = `${root}/src/Bad.sol`;

  it("maps impact to severity and keeps only files in scope", () => {
    const stdout = JSON.stringify({
      success: true,
      error: null,
      results: {
        detectors: [
          detector("reentrancy-eth", "High", "src/Bad.sol"),
          detector("timestamp", "Low", "src/Bad.sol"),
          detector("low-level-calls", "Informational", "src/Bad.sol"),
          detector("reentrancy-eth", "High", "test/Bad.t.sol"),
        ],
      },
    });
    const result = slither.parseOutput(
      { stdout, stderr: "", exitCode: 255 },
      ctx(root, { scope: [bad] }),
    );
    expect(result.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["reentrancy-eth", "error"],
      ["timestamp", "warning"],
      ["low-level-calls", "info"],
    ]);
    expect(result.findings[0]).toMatchObject({
      file: bad,
      line: 6,
      endLine: 8,
      col: 5,
    });
    expect(result.findings[0]?.message).not.toContain("\n");
  });

  it("fails loud on a failed compile", () => {
    expect(() =>
      slither.parseOutput(
        {
          stdout:
            '{"success": false, "error": "forge build failed", "results": {}}',
          stderr: "",
          exitCode: 255,
        },
        ctx(root, { scope: [] }),
      ),
    ).toThrow(/forge build failed/);
  });

  it("never cleans the project's build", () => {
    expect(slither.buildArgs(ctx(root, { scope: [] })).args).toContain(
      "--skip-clean",
    );
  });
});
