import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aderyn } from "../src/adapters/aderyn.js";
import { forgeFmt } from "../src/adapters/forge-fmt.js";
import { htmlValidate } from "../src/adapters/html-validate.js";
import { solhint } from "../src/adapters/solhint.js";
import { stylelint } from "../src/adapters/stylelint.js";
import type {
  Finding,
  PlanEnv,
  RawOutput,
  ToolContext,
} from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// Every output below was captured from a real run on 2026-10-18 (stylelint
// 17.16.0, html-validate 11.16.4, solhint 6.2.3, forge 1.8.5, aderyn 0.6.8)
// against a fixture with the problem planted, then trimmed, with the run's
// folder (<TMP>/w) replaced by the test's
// (docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md and its
// assets). Outputs marked "run here" were recorded for these adapters.

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-websol-scratch-");
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

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const brief = (root: string, findings: Finding[]) =>
  findings.map((f) => [
    f.file.slice(root.length + 1),
    f.line,
    f.col,
    f.ruleId,
    f.severity,
    f.message,
  ]);

describe("stylelint", () => {
  it("reads its JSON report from stderr, one finding per warning", () => {
    const root = tmp("vk-stylelint-");
    // bad-json.stderr, exit 2.
    const stderr = `[{"source":"${root}/bad.css","deprecations":[],"invalidOptionWarnings":[],"parseErrors":[],"errored":true,"warnings":[{"line":6,"column":3,"endLine":6,"endColumn":5,"rule":"block-no-empty","severity":"error","text":"Empty block (block-no-empty)"},{"line":4,"column":3,"endLine":4,"endColumn":9,"rule":"property-no-unknown","severity":"error","text":"Unknown property \\"colour\\" (property-no-unknown)"}]}]`;
    const result = stylelint.parseOutput(ran(2, "", stderr), ctx(root));
    expect(brief(root, result.findings)).toEqual([
      ["bad.css", 6, 3, "block-no-empty", "error", "Empty block"],
      [
        "bad.css",
        4,
        3,
        "property-no-unknown",
        "error",
        'Unknown property "colour"',
      ],
    ]);
    expect(result.findings[1]).toMatchObject({
      endLine: 4,
      endCol: 9,
      url: "https://stylelint.io/user-guide/rules/property-no-unknown",
    });
    // clean-json.stderr, exit 0.
    const clean = `[{"source":"${root}/clean.css","deprecations":[],"invalidOptionWarnings":[],"parseErrors":[],"errored":false,"warnings":[]}]`;
    expect(
      stylelint.parseOutput(ran(0, "", clean), ctx(root)).findings,
    ).toEqual([]);
  });

  it("fails loud on a config it cannot use and on output that is not its report", () => {
    const root = tmp("vk-stylelint-");
    // Run here: a rule given an option it does not take, exit 2.
    const invalid = `[{"source":"${root}/a.css","deprecations":[],"invalidOptionWarnings":[{"text":"Unexpected option value \\"bogus\\" for rule \\"color-no-invalid-hex\\""}],"parseErrors":[],"errored":true,"warnings":[]}]`;
    expect(() => stylelint.parseOutput(ran(2, "", invalid), ctx(root))).toThrow(
      /config is invalid: Unexpected option value "bogus"/,
    );
    expect(() =>
      stylelint.parseOutput(
        ran(2, "", "Error: Cannot resolve custom syntax module"),
        ctx(root),
      ),
    ).toThrow(/no JSON report on exit 2: Error: Cannot resolve/);
    // 1 (no files), 64 (usage) and 78 (config) are crashes for the runner.
    const built = stylelint.buildArgs(ctx(root, { files: [`${root}/a.css`] }));
    expect(built.okExitCodes).toEqual([0, 2]);
    expect(built.args).toContain("--allow-empty-input");
  });

  it("runs from each file's config folder, on the syntaxes that config names", () => {
    const root = tmp("vk-stylelint-");
    const [a, b, c] = [
      `${root}/a.css`,
      `${root}/web/b.css`,
      `${root}/web/c.scss`,
    ];
    write(root, { "a.css": "", "web/b.css": "", "web/c.scss": "" });
    const plan = (more: Partial<PlanEnv> = {}) =>
      stylelint.expand?.({ cwd: root, files: [a, b, c] }, env(root, more));
    expect(plan()).toEqual([]);
    // The package's own copy and .stylelintignore are found from there; a
    // .scss file is CSS to it unless the config names a SCSS syntax.
    write(root, {
      "web/.stylelintrc.json": '{"extends":["stylelint-config-standard"]}',
    });
    expect(plan()).toEqual([{ cwd: `${root}/web`, files: [b] }]);
    write(root, {
      "web/.stylelintrc.json": '{"extends":["stylelint-config-standard-scss"]}',
    });
    expect(plan()).toEqual([{ cwd: `${root}/web`, files: [b, c] }]);
    expect(plan({ toolConfig: { enabled: true } })).toEqual([
      { cwd: root, files: [a] },
      { cwd: `${root}/web`, files: [b, c] },
    ]);
    write(root, { "package.json": '{"stylelint":{"rules":{}}}' });
    expect(plan()).toEqual([
      { cwd: root, files: [a] },
      { cwd: `${root}/web`, files: [b, c] },
    ]);
  });
});

describe("html-validate", () => {
  it("reports each message at its line and column", () => {
    const root = tmp("vk-htmlvalidate-");
    // bad-json.stdout, exit 1 (`source` trimmed).
    const stdout = `[{"filePath":"${root}/bad.html","messages":[{"ruleId":"no-implicit-close","severity":2,"message":"Element <p> is implicitly closed by adjacent <div>","offset":75,"line":7,"column":2,"size":1,"selector":"html > body > p","ruleUrl":"https://html-validate.org/rules/no-implicit-close.html"},{"ruleId":"close-order","severity":2,"message":"Stray end tag '</p>'","offset":104,"line":7,"column":31,"size":2,"selector":null,"ruleUrl":"https://html-validate.org/rules/close-order.html"},{"ruleId":"no-dup-id","severity":2,"message":"Duplicate ID \\"dup\\"","offset":142,"line":9,"column":11,"size":3,"selector":"html > body > span:nth-child(4)","ruleUrl":"https://html-validate.org/rules/no-dup-id.html"}],"errorCount":3,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"source":""}]`;
    const result = htmlValidate.parseOutput(ran(1, stdout), ctx(root));
    expect(brief(root, result.findings)).toEqual([
      [
        "bad.html",
        7,
        2,
        "no-implicit-close",
        "error",
        "Element <p> is implicitly closed by adjacent <div>",
      ],
      ["bad.html", 7, 31, "close-order", "error", "Stray end tag '</p>'"],
      ["bad.html", 9, 11, "no-dup-id", "error", 'Duplicate ID "dup"'],
    ]);
    expect(result.findings[2]?.url).toBe(
      "https://html-validate.org/rules/no-dup-id.html",
    );
    // clean-json.stdout, exit 0.
    expect(htmlValidate.parseOutput(ran(0, "[]"), ctx(root)).findings).toEqual(
      [],
    );
  });

  it("fails loud on a bad config, naming the error under the stack", () => {
    const root = tmp("vk-htmlvalidate-");
    // bad-config-schema.stderr, exit 1, trimmed.
    const stderr = [
      "file://<TMP>/deps/node_modules/html-validate/dist/esm/core.js:13010",
      "      throw new SchemaValidationError(",
      "            ^",
      "",
      "SchemaValidationError: Invalid configuration: /rules/no-dup-id must be equal to one of the allowed values: 0, 1, 2, off, warn, error",
      "    at Config.validate (file://<TMP>/deps/node_modules/html-validate/dist/esm/core.js:13010:13)",
    ].join("\n");
    expect(() =>
      htmlValidate.parseOutput(ran(1, "", stderr), ctx(root)),
    ).toThrow(/exit 1: SchemaValidationError: Invalid configuration/);
  });

  it("runs from each file's config folder, naming every file literally", () => {
    const root = tmp("vk-htmlvalidate-");
    const files = [`${root}/a.html`, `${root}/site/b[1].htm`];
    write(root, { "a.html": "", "site/b[1].htm": "" });
    const plan = (more: Partial<PlanEnv> = {}) =>
      htmlValidate.expand?.({ cwd: root, files }, env(root, more));
    expect(plan()).toEqual([]);
    write(root, { "site/.htmlvalidate.json": "{}" });
    expect(plan()).toEqual([
      { cwd: `${root}/site`, files: [`${root}/site/b[1].htm`] },
    ]);
    // It globs each name: unescaped, `b[1].htm` names `b1.htm`.
    const built = htmlValidate.buildArgs(
      ctx(`${root}/site`, { files: [`${root}/site/b[1].htm`] }),
    );
    expect(built.args.at(-1)).toBe(`${root}/site/b[[]1[]].htm`);
    expect(() =>
      htmlValidate.buildArgs(ctx(root, { files: [`${root}/{a,b}.html`] })),
    ).toThrow(/cannot be given .*\{a,b\}\.html/);
  });

  it("passes when its ignore file leaves nothing, and fails loud on an unknown rule", () => {
    const root = tmp("vk-htmlvalidate-");
    // Run here: .htmlvalidateignore listing the only file, exit 1.
    expect(
      htmlValidate.parseOutput(
        ran(1, "", "No files matching patterns [ 'a.html' ]\n"),
        ctx(root),
      ).findings,
    ).toEqual([]);
    // Run here: `"no-such-rule": "error"`, exit 1 (the real file's result cut).
    const unknown = `[{"filePath":"undefined","messages":[{"ruleId":"no-such-rule","severity":2,"message":"Definition for rule 'no-such-rule' was not found","offset":0,"line":1,"column":1,"size":1,"selector":null}],"errorCount":1,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"source":null}]`;
    expect(() => htmlValidate.parseOutput(ran(1, unknown), ctx(root))).toThrow(
      /config is invalid: Definition for rule 'no-such-rule' was not found/,
    );
  });
});

describe("solhint", () => {
  const root = tmp("vk-solhint-");

  it("reports each problem, not the summary after them", () => {
    // bad-json.stdout, exit 1.
    const bad =
      '[{"line":12,"column":16,"severity":"Error","message":"Avoid to use tx.origin","ruleId":"avoid-tx-origin","fix":null,"filePath":"src/Bad.sol"},{"conclusion":"1 problem/s (1 error/s)"}]\n';
    expect(
      brief(root, solhint.parseOutput(ran(1, bad), ctx(root)).findings),
    ).toEqual([
      [
        "src/Bad.sol",
        12,
        16,
        "avoid-tx-origin",
        "error",
        "Avoid to use tx.origin",
      ],
    ]);
    // warn-only.stdout, exit 0.
    const warn = bad.replace('"Error"', '"Warning"');
    expect(
      solhint.parseOutput(ran(0, warn), ctx(root)).findings[0]?.severity,
    ).toBe("warning");
    // clean-json.stdout.
    expect(solhint.parseOutput(ran(0, "[]\n"), ctx(root)).findings).toEqual([]);
  });

  it("reports a file that does not parse at its 1-based column", () => {
    // Run here: `contract { ` on line 2, exit 1 (message trimmed).
    const stdout =
      '[{"line":2,"column":9,"severity":"Error","message":"Parse error: missing Identifier at \'{\'","filePath":"src/Syn.sol"},{"conclusion":"1 problem/s (1 error/s)"}]\n';
    const [f] = solhint.parseOutput(ran(1, stdout), ctx(root)).findings;
    expect(f).toMatchObject({ line: 2, col: 10, ruleId: "parse-error" });
    expect(f && solhint.masks?.(f)).toBe(true);
  });

  it("passes when its ignore file leaves nothing, and fails loud without a config", () => {
    // Run here: .solhintignore listing the only file, exit 255.
    const ignored = `No files to lint! check glob arguments "src/Bad.sol" and ignore files.\n`;
    expect(
      solhint.parseOutput(
        ran(255, "", ignored),
        ctx(root, { options: { ignorable: true } }),
      ).findings,
    ).toEqual([]);
    // With nothing that ignores files, it matched nothing it was named.
    expect(() =>
      solhint.parseOutput(
        ran(255, "", ignored),
        ctx(root, { options: { ignorable: false } }),
      ),
    ).toThrow(/exit 255: No files to lint/);
    // no-config.stderr, exit 255.
    expect(() =>
      solhint.parseOutput(
        ran(255, "", "Failed to load a solhint's config file.\n"),
        ctx(root),
      ),
    ).toThrow(/exit 255: Failed to load a solhint's config file/);
    // bogus-flag.stderr, exit 1: no JSON.
    expect(() =>
      solhint.parseOutput(
        ran(1, "", "error: unknown option '--bogus'\n"),
        ctx(root),
      ),
    ).toThrow(/unknown option '--bogus'/);
    expect(
      solhint.buildArgs(
        ctx(root, {
          files: [`${root}/src/Bad[1].sol`],
          options: { config: `${root}/.solhintrc.json`, ignorable: false },
        }),
      ).args,
    ).toEqual([
      "--disc",
      "--formatter",
      "json",
      "--config",
      `${root}/.solhintrc.json`,
      `${root}/src/Bad[[]1[]].sol`,
    ]);
  });

  it("fails loud on a config warning: that rule is off", () => {
    // Run here: a misspelt level for avoid-tx-origin, exit 0; unknown-rule.stderr.
    for (const stderr of [
      "[solhint] Warning: invalid configuration for rule 'avoid-tx-origin': ENUM must be equal to one of the allowed values\n",
      "[solhint] Warning: Rule 'nope' doesn't exist\n",
    ])
      expect(() =>
        solhint.parseOutput(ran(0, "[]\n", stderr), ctx(root)),
      ).toThrow(
        /solhint's config is invalid: (invalid configuration|Rule 'nope')/,
      );
  });

  it("names the config its own search finds for a file no .solhint.json reaches", () => {
    const top = tmp("vk-solhint-adopt-");
    const file = `${top}/contracts/src/A.sol`;
    write(top, { "contracts/foundry.toml": "", "contracts/src/A.sol": "" });
    expect(solhint.adoptedAt?.(`${top}/contracts`, top)).toBe(false);
    const plan = () =>
      solhint.expand?.({ cwd: `${top}/contracts`, files: [file] }, env(top));
    // solhint takes rules only from .solhint.json files between the file and
    // where it runs: one above that, or any other name, it would not read.
    write(top, { ".solhint.json": "{}" });
    expect(solhint.adoptedAt?.(`${top}/contracts`, top)).toBe(true);
    expect(plan()).toEqual([
      {
        cwd: `${top}/contracts`,
        files: [file],
        options: { ignorable: false, config: `${top}/.solhint.json` },
      },
    ]);
    write(top, { "contracts/src/.solhint.json": "{}" });
    expect(plan()).toEqual([
      { cwd: `${top}/contracts`, files: [file], options: { ignorable: false } },
    ]);
  });
});

describe("forge fmt", () => {
  const root = tmp("vk-forgefmt-");
  // bad.stdout, exit 1.
  const bad = [
    "Diff in src/Bad.sol:",
    "1   1    | // SPDX-License-Identifier: MIT",
    "2   2    | pragma solidity ^0.8.24;",
    "    3    |+",
    "3   4    | contract Bad {",
    "4        |-  uint256 public x;",
    "6   10   | }",
    "",
  ].join("\n");

  it("reports each file with a diff once, at its first changed line", () => {
    // unknown-fmt-key.stdout: the first change is a removed line.
    const removed = [
      "Diff in src/T.sol:",
      "2   2    | pragma solidity ^0.8.24;",
      "3   3    | ",
      "4   4    | contract T {",
      "5        |-  uint256 public x;",
      "    5    |+    uint256 public x;",
      "6   6    | }",
      "",
    ].join("\n");
    const result = forgeFmt.parseOutput(ran(1, bad + removed), ctx(root));
    expect(brief(root, result.findings)).toEqual([
      [
        "src/Bad.sol",
        3,
        1,
        undefined,
        "warning",
        "Code is not forge-fmt-formatted: run `forge fmt`",
      ],
      [
        "src/T.sol",
        5,
        1,
        undefined,
        "warning",
        "Code is not forge-fmt-formatted: run `forge fmt`",
      ],
    ]);
    expect(forgeFmt.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
  });

  it("reports a file that does not parse, and fails loud on a missing one", () => {
    // syntax-only.stderr, exit 1.
    const syntax = [
      "Error: solar reported errors:",
      "",
      "error: expected identifier, found `{`",
      "  ╭▸ src/Syn.sol:1:10",
      "  │",
      "1 │ contract { ",
      "  ╰╴         ━",
      "",
    ].join("\n");
    const [f] = forgeFmt.parseOutput(ran(1, "", syntax), ctx(root)).findings;
    expect(f).toMatchObject({
      file: `${root}/src/Syn.sol`,
      line: 1,
      col: 10,
      ruleId: "syntax-error",
      severity: "error",
    });
    expect(f && forgeFmt.masks?.(f)).toBe(true);
    // missing.stderr, exit 1.
    expect(() =>
      forgeFmt.parseOutput(
        ran(
          1,
          "",
          "Error: solar reported errors:\n\nerror: file src/Nope.sol not found\n",
        ),
        ctx(root),
      ),
    ).toThrow(/error: file src\/Nope.sol not found/);
  });

  it("checks with each file's nearest foundry.toml, and writes only in a fix", () => {
    const file = `${root}/src/Bad.sol`;
    expect(forgeFmt.buildArgs(ctx(root, { files: [file] })).args).toEqual([
      "fmt",
      "--check",
      "--nearest",
      file,
    ]);
    expect(
      forgeFmt.buildArgs(ctx(root, { files: [file], fix: true })).args,
    ).toEqual(["fmt", "--nearest", file]);
  });

  it("leaves out the libs folders foundry.toml names", () => {
    const top = tmp("vk-forgefmt-libs-");
    const [own, vendored, deps] = [
      `${top}/src/A.sol`,
      `${top}/lib/oz/B.sol`,
      `${top}/deps/C.sol`,
    ];
    const plan = () =>
      forgeFmt.expand?.({ cwd: top, files: [own, vendored, deps] }, env(top));
    write(top, { "foundry.toml": '[profile.default]\nsrc = "src"\n' });
    expect(plan()).toEqual([{ cwd: top, files: [own, deps] }]);
    write(top, { "foundry.toml": '[profile.default]\nlibs = ["deps"]\n' });
    expect(plan()).toEqual([{ cwd: top, files: [own, vendored] }]);
  });

  it("is adopted by a foundry.toml", () => {
    const top = tmp("vk-forgefmt-adopt-");
    write(top, { "hardhat/hardhat.config.ts": "" });
    expect(forgeFmt.adoptedAt?.(`${top}/hardhat`, top)).toBe(false);
    write(top, { "foundry.toml": "" });
    expect(forgeFmt.adoptedAt?.(`${top}/hardhat`, top)).toBe(true);
  });
});

// aderyn/fixture/src/Bad.sol.
const aderynSource = [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity 0.8.24;",
  "",
  "contract Bad {",
  "    address public owner;",
  "",
  "    constructor() {",
  "        owner = msg.sender;",
  "    }",
  "",
  "    function withdraw() external {",
  '        require(tx.origin == owner, "not owner");',
  "        payable(msg.sender).transfer(address(this).balance);",
  "    }",
  "}",
  "",
].join("\n");
const aderynIssue = (
  title: string,
  detector: string,
  path: string,
  line: number,
  src: string,
) => ({
  title,
  description: `${title} description.`,
  detector_name: detector,
  instances: [{ contract_path: path, line_no: line, src, src_char: src }],
});
// The shape of bad-json.report.json: descriptions shortened, detectors_used emptied.
const aderynReport = (high: unknown[], low: unknown[]) => ({
  files_summary: { total_source_units: 1, total_sloc: 11 },
  files_details: {
    files_details: [{ file_path: "src/Bad.sol", n_sloc: 11 }],
  },
  issue_count: { high: high.length, low: low.length },
  high_issues: { issues: high },
  low_issues: { issues: low },
  detectors_used: [],
});

function runAderyn(root: string, json: unknown, base = root) {
  const c = ctx(root, {
    options: { scope: [`${base}/src/Bad.sol`], base },
  });
  const built = aderyn.buildArgs(c);
  const out = built.args[built.args.indexOf("--output") + 1] ?? "";
  if (json !== undefined) writeFileSync(out, JSON.stringify(json));
  return { out, result: () => aderyn.parseOutput(ran(0), c) };
}

describe("aderyn", () => {
  it("reads its report from the scratch folder: high is an error, low a warning", () => {
    const root = tmp("vk-aderyn-");
    write(root, { "src/Bad.sol": aderynSource, "lib/Dep.sol": "" });
    const { out, result } = runAderyn(
      root,
      aderynReport(
        [
          aderynIssue(
            "Use of `tx.origin` for authentication",
            "tx-origin-used-for-auth",
            "src/Bad.sol",
            12,
            "197:40",
          ),
        ],
        [
          aderynIssue(
            "State Variable Could Be Immutable",
            "state-variable-could-be-immutable",
            "src/Bad.sol",
            5,
            "91:5",
          ),
          aderynIssue(
            "Unsafe ERC20 Operation",
            "unsafe-erc20-operation",
            "lib/Dep.sol",
            3,
            "10:5",
          ),
        ],
      ),
    );
    expect(out.startsWith(root)).toBe(false);
    expect(brief(root, result().findings)).toEqual([
      [
        "src/Bad.sol",
        12,
        9,
        "tx-origin-used-for-auth",
        "error",
        "Use of `tx.origin` for authentication: Use of `tx.origin` for authentication description.",
      ],
      [
        "src/Bad.sol",
        5,
        20,
        "state-variable-could-be-immutable",
        "warning",
        "State Variable Could Be Immutable: State Variable Could Be Immutable description.",
      ],
    ]);
    expect(runAderyn(root, aderynReport([], [])).result().findings).toEqual([]);
  });

  it("fails loud without a report, with a third bucket, or on a crash", () => {
    const root = tmp("vk-aderyn-");
    expect(() => runAderyn(root, undefined).result()).toThrow(
      /without writing its report/,
    );
    expect(() =>
      runAderyn(root, {
        ...aderynReport([], []),
        medium_issues: { issues: [] },
      }).result(),
    ).toThrow(/medium_issues/);
    // A path that is not there: read against the wrong root.
    expect(() =>
      runAderyn(
        root,
        aderynReport(
          [
            aderynIssue(
              "T",
              "tx-origin-used-for-auth",
              "src/Bad.sol",
              1,
              "0:1",
            ),
          ],
          [],
        ),
      ).result(),
    ).toThrow(
      /not at .*src\/Bad\.sol: the kit read its paths against the wrong root/,
    );
    const c = ctx(root, { options: { scope: [], base: root } });
    // missing-root.stderr, exit 1.
    expect(() =>
      aderyn.parseOutput(
        ran(1, "", "Error making context: Non existent root\n"),
        c,
      ),
    ).toThrow(/Non existent root/);
    // no-solidity.stderr, exit 1: every file is in a folder it skips.
    expect(
      aderyn.parseOutput(
        ran(
          1,
          "",
          "No solidity files found in given scope!\nError making context: No solidity files found in given scope!\n",
        ),
        c,
      ).findings,
    ).toEqual([]);
  });

  it("reads paths against the root its aderyn.toml names", () => {
    const root = tmp("vk-aderyn-");
    write(root, { "contracts/src/Bad.sol": aderynSource });
    const [f] = runAderyn(
      root,
      aderynReport(
        [
          aderynIssue(
            "T",
            "tx-origin-used-for-auth",
            "src/Bad.sol",
            12,
            "197:40",
          ),
        ],
        [],
      ),
      `${root}/contracts`,
    )
      .result()
      .findings.map((x) => [x.file, x.line, x.col]);
    expect(f).toEqual([`${root}/contracts/src/Bad.sol`, 12, 9]);
  });

  it("runs only where the project opted in, from its aderyn.toml's folder, in the deep tier", () => {
    const top = tmp("vk-aderyn-adopt-");
    write(top, { "contracts/foundry.toml": "" });
    expect(aderyn.adoptedAt?.(`${top}/contracts`, top)).toBe(false);
    write(top, { "aderyn.toml": 'version = 1\nroot = "contracts"\n' });
    expect(aderyn.adoptedAt?.(`${top}/contracts`, top)).toBe(true);
    // aderyn reads aderyn.toml only from where it runs.
    expect(
      aderyn.expand?.(
        { cwd: `${top}/contracts` },
        env(top, { scopedFiles: [] }),
      ),
    ).toEqual([{ cwd: top, options: { scope: [], base: `${top}/contracts` } }]);
    // It downloads a missing solc: never in the hook's profile. It compiles
    // through a Foundry or Hardhat root, with its remappings.
    expect(aderyn.tier).toBe("deep");
    expect(aderyn.rootedAtMarker).toBe(true);
  });
});
