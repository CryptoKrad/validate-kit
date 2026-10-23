import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { capslock } from "../src/adapters/capslock.js";
import { RUSTUP_BIN } from "../src/adapters/cargo.js";
import { cargoHack } from "../src/adapters/cargo-hack.js";
import { cargoSemverChecks } from "../src/adapters/cargo-semver-checks.js";
import { goArchLint } from "../src/adapters/go-arch-lint.js";
import { gorelease } from "../src/adapters/gorelease.js";
import { kani } from "../src/adapters/kani.js";
import { miri } from "../src/adapters/miri.js";
import { toPosix } from "../src/detect/languages.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";

// Outputs captured from real runs on 2026-10-18 (cargo-hack 0.6.45,
// cargo-semver-checks 0.51.0, Kani 0.68.0, Miri on nightly 2026-10-09,
// capslock v0.3.4, gorelease x/exp 20261014, go-arch-lint v1.19.0) against
// fixtures with one problem planted, then trimmed
// (docs/research/lint-toolchain/sota-2026-10-18/rust-go.md). The
// go-arch-lint not-matched, config-error and deep-scan reports were recorded
// for this test the same way, on the same fixture.

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

/** A folder holding `files` (path to text). */
function project(prefix: string, files: Record<string, string>): string {
  const root = tmp(prefix);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  const scratch = tmp("vk-rust-go-scratch-");
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
    config: { ignore: [], tools: {} },
    ...more,
  } as unknown as PlanEnv;
}

/** `adapter.expand` for one seed at `root`, its tool settings `tool`. */
function expand(
  adapter: ToolAdapter,
  root: string,
  tool: { enabled?: boolean; options?: unknown } = {},
  more: Partial<PlanEnv> = {},
): TaskSeed[] {
  return adapter.expand?.(
    { cwd: root },
    env(root, {
      toolConfig: tool,
      config: { ignore: [], tools: { [adapter.id]: tool } },
      ...more,
    } as Partial<PlanEnv>),
  ) as TaskSeed[];
}

/**
 * A cargo tool's context at `cwd`, a crate in the workspace at
 * `workspaceRoot` (by default its own).
 */
function crate(
  cwd: string,
  workspaceRoot = cwd,
  extra: Partial<ToolContext> = {},
): ToolContext {
  return ctx(cwd, {
    options: { workspaceRoot, atRoot: workspaceRoot === cwd },
    ...extra,
  });
}

/** A context whose scratch folder holds this Kani report. */
function withReport(
  root: string,
  json: unknown,
  workspaceRoot = root,
): ToolContext {
  const c = crate(root, workspaceRoot);
  writeFileSync(join(c.tempDir?.() ?? "", "kani.json"), JSON.stringify(json));
  return c;
}

/** cargo-semver-checks' task for the one crate at `root`. */
const semverTask = (root: string) => ({
  base: "d445dce",
  crates: [{ name: "semverfix", dir: root }],
  prefix: "",
});

/** A git repository at `root` whose commands run with a fixed author. */
const gitIn =
  (root: string) =>
  (...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=n", ...args],
      { cwd: root, encoding: "utf8" },
    ).trim();

/** The crate's lib.rs as the run's scope. */
const scoped = (root: string) => ({ scopedFiles: [`${root}/src/lib.rs`] });

/** The capslock fixture module, with a baseline file. */
const module = () =>
  project("vk-caps-", {
    "go.mod": "module example.com/capfix\n\ngo 1.25\n",
    "main.go":
      'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/capfix/runner"\n)\n\nfunc main() { fmt.Println(runner.Version()) }\n',
    "runner/runner.go":
      'package runner\n\nimport "os/exec"\n\n// Version shells out: planted use of os/exec.\nfunc Version() string {\n\tout, _ := exec.Command("git", "--version").Output()\n\treturn string(out)\n}\n',
    "capslock.json": "{}\n",
  });

/** A go-arch-lint `models.Check` report with these warnings; the rest empty. */
const archReport = (payload: Record<string, unknown>) =>
  JSON.stringify({
    Type: "models.Check",
    Payload: {
      ExecutionWarnings: [],
      ArchHasWarnings: true,
      ArchWarningsDeps: [],
      ArchWarningsNotMatched: [],
      ArchWarningsDeepScan: [],
      OmittedCount: 0,
      ModuleName: "example.com/archfix",
      ...payload,
    },
  });

describe("cargo-hack", () => {
  // finding-keepgoing: the E0425 line and its failure note, trimmed to the
  // fields the kit reads, in the two failing combinations of seven.
  const error = JSON.stringify({
    reason: "compiler-message",
    package_id: "path+file://<ROOT>/fixture#hackfix@0.1.0",
    message: {
      $message_type: "diagnostic",
      level: "error",
      message: "cannot find function `from_a` in this scope",
      spans: [
        {
          column_end: 32,
          column_start: 26,
          file_name: "src/lib.rs",
          is_primary: true,
          label: "not found in this scope",
          line_end: 6,
          line_start: 6,
        },
      ],
      code: { code: "E0425" },
    },
  });
  const note = JSON.stringify({
    reason: "compiler-message",
    message: {
      $message_type: "diagnostic",
      level: "failure-note",
      message:
        "For more information about this error, try `rustc --explain E0425`.",
      spans: [],
      code: null,
    },
  });
  const ok = '{"reason":"build-finished","success":true}';
  const failed = '{"reason":"build-finished","success":false}';
  const stdout = [ok, error, note, failed, ok, error, note, failed, ok, ok, ok]
    .join("\n")
    .concat("\n");
  const stderr = [
    "",
    "--no-default-features --features b,c",
    "--no-default-features --features a",
    "--no-default-features --features b",
    "--no-default-features --features a,b",
    "--no-default-features --features c",
    "--no-default-features --features a,c",
  ]
    .map(
      (flags, i) =>
        `info: running \`cargo check --message-format=json ${flags || "--no-default-features"}\` on hackfix (${i + 1}/7)\n    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 0.00s\n`,
    )
    .join("\n")
    .concat(
      "\nerror: failed to run 2 commands\n\nfailed commands:\n    hackfix:\n        `cargo check --message-format=json --manifest-path Cargo.toml --no-default-features --features b,c`\n",
    );

  it("reports a compile error once, at its span, naming each combination it fails in", () => {
    const root = tmp("vk-hack-");
    const { findings } = cargoHack.parseOutput(
      ran(1, stdout, stderr),
      crate(root),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: `${root}/src/lib.rs`,
      line: 6,
      col: 26,
      endCol: 32,
      ruleId: "E0425",
      severity: "error",
      message:
        "cannot find function `from_a` in this scope (fails to build: hackfix with features b,c; hackfix with features b): gate the code on every feature it uses",
    });
    // Run in a member's folder, rustc still names the file from the
    // workspace root.
    expect(
      cargoHack.parseOutput(
        ran(1, stdout, stderr),
        crate(`${root}/crates/m`, root),
      ).findings[0]?.file,
    ).toBe(`${root}/src/lib.rs`);
    // The clean twin: seven blocks that all built.
    expect(
      cargoHack.parseOutput(ran(0, `${ok}\n`.repeat(7), ""), crate(root))
        .findings,
    ).toEqual([]);
  });

  it("is a crash when a combination fails before compiling, even beside a compile error", () => {
    const root = tmp("vk-hack-");
    // The reviewer's hack2: build.rs panics under feature c, `b` has E0425.
    const panics =
      "info: running `cargo check --message-format=json --no-default-features --features c` on hackrev2 (6/7)\n   Compiling hackrev2 v0.1.0 (<ROOT>)\nerror: failed to run custom build command for `hackrev2 v0.1.0 (<ROOT>)`\n\nCaused by:\n  process didn't exit successfully: `<TARGET>/debug/build/hackrev2-1/build-script-build` (exit status: 101)\n  --- stderr\n  thread 'main' panicked at build.rs:3:9:\n  feature c needs a system library that is missing\nerror: process didn't exit successfully: `cargo check --message-format=json --manifest-path Cargo.toml --no-default-features --features c` (exit status: 101)\n";
    expect(() =>
      cargoHack.parseOutput(ran(1, stdout, `${stderr}${panics}`), crate(root)),
    ).toThrow(
      "cargo-hack: hackrev2 with features c failed before compiling, so it was not checked: error: failed to run custom build command for `hackrev2 v0.1.0 (<ROOT>)`",
    );
  });

  it("is a crash naming cargo's own error when it fails with no compile error", () => {
    const root = tmp("vk-hack-");
    // usage-error.stderr, missing-manifest.stderr
    expect(() =>
      cargoHack.parseOutput(
        ran(
          1,
          "",
          "info: running `cargo check --bogus-flag --no-default-features` on hackfix (1/8)\nerror: unexpected argument '--bogus-flag' found\n\nUsage: cargo check [OPTIONS]\n\nFor more information, try '--help'.\nerror: process didn't exit successfully: `<HOME>/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo check --bogus-flag --manifest-path Cargo.toml --no-default-features` (exit status: 1)\n",
        ),
        crate(root),
      ),
    ).toThrow("error: unexpected argument '--bogus-flag' found");
    expect(() =>
      cargoHack.parseOutput(
        ran(
          1,
          "",
          "error: process didn't exit successfully: `<HOME>/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo metadata --format-version=1 --manifest-path nope/Cargo.toml --no-deps` (exit status: 101)\n--- stderr\nerror: manifest path `nope/Cargo.toml` does not exist\n\n",
        ),
        crate(root),
      ),
    ).toThrow("error: manifest path `nope/Cargo.toml` does not exist");
  });

  it("runs where Cargo.toml has its metadata table, with its own target dir and rustup first on PATH", () => {
    const pkg = project("vk-hack-", {
      "Cargo.toml":
        '[package]\nname = "a"\nversion = "0.1.0"\n\n[package.metadata.cargo-hack]\ngroup-features = [["a", "b"]]\n',
    });
    const workspace = project("vk-hack-", {
      "Cargo.toml":
        '[workspace]\nmembers = ["a"]\n\n[workspace.metadata.cargo-hack]\nexclude-features = ["x"]\n',
    });
    const plain = project("vk-hack-", {
      "Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\n',
    });
    expect(cargoHack.adoptedAt?.(pkg, pkg)).toBe(true);
    expect(cargoHack.adoptedAt?.(workspace, workspace)).toBe(true);
    expect(cargoHack.adoptedAt?.(plain, plain)).toBe(false);
    const c = crate(pkg, tmp("vk-hack-ws-"));
    const cmd = cargoHack.buildArgs(c);
    expect(cmd.args).toEqual([
      "hack",
      "check",
      "--feature-powerset",
      "--depth",
      "2",
      "--keep-going",
      "--message-format=json",
    ]);
    expect(cmd.env?.CARGO_TARGET_DIR).toBe(join(c.tempDir?.() ?? "", "target"));
    expect(cmd.env?.PATH?.split(delimiter)[0]).toBe(RUSTUP_BIN);
    // The project's own depth replaces the kit's.
    expect(
      cargoHack.buildArgs(
        crate(pkg, tmp("vk-hack-ws-"), { extraArgs: ["--depth", "3"] }),
      ).args,
    ).toEqual([
      "hack",
      "check",
      "--feature-powerset",
      "--keep-going",
      "--message-format=json",
      "--depth",
      "3",
    ]);
    expect(cargoHack.refuseArgs?.(["--message-format=human"])).toBeDefined();
  });

  it("covers every member at a workspace root, and only the members that chose it themselves", () => {
    // At the root of a workspace with a root package, without --workspace
    // cargo checks the root package alone (the reviewer's hackws).
    expect(cargoHack.buildArgs(crate(tmp("vk-hack-"))).args).toContain(
      "--workspace",
    );
    // A virtual workspace whose member has its own table (hackvws).
    const virtual = project("vk-hack-", {
      "Cargo.toml": '[workspace]\nmembers = ["crates/m"]\n',
      "crates/m/Cargo.toml":
        '[package]\nname = "hackvmember"\nversion = "0.1.0"\n\n[package.metadata.cargo-hack]\n',
      "crates/m/src/lib.rs": "",
      "crates/n/Cargo.toml": '[package]\nname = "other"\nversion = "0.1.0"\n',
    });
    expect(cargoHack.adoptedAt?.(virtual, virtual)).toBe(true);
    const [task] = expand(cargoHack, virtual);
    expect(
      cargoHack.buildArgs(ctx(virtual, { options: task?.options })).args,
    ).toEqual([
      "hack",
      "check",
      "-p",
      "hackvmember",
      "--feature-powerset",
      "--depth",
      "2",
      "--keep-going",
      "--message-format=json",
    ]);
  });
});

describe("cargo-semver-checks", () => {
  // removed.stdout / removed.stderr (exit 100)
  const stdout = `
--- failure function_missing: pub fn removed or renamed ---

Description:
A publicly-visible function cannot be imported by its prior path. A \`pub use\` may have been removed, or the function itself may have been renamed or removed entirely.
        ref: https://doc.rust-lang.org/cargo/reference/semver.html#item-remove
       impl: https://github.com/obi1kenobi/cargo-semver-checks/tree/v0.51.0/src/lints/function_missing.ron

Failed in:
  function semverfix::sub, previously in file <TMP>/target/semver-checks/git-HEAD_1/d445dce9ed6bb37651c6e275b8e99587d9fb6224/src/lib.rs:2
`;
  const stderr = `     Cloning HEAD~1
    Checking semverfix v0.1.0 -> v0.1.0 (no change; assume minor)
     Checked [   0.004s] 202 checks: 201 pass, 1 fail, 0 warn, 58 skip

     Summary semver requires new major version: 1 major and 0 minor checks failed
    Finished [   0.477s] semverfix
`;

  it("reports a removed item on its crate's Cargo.toml, the item in the rule, with the version it needs", () => {
    const root = tmp("vk-semver-");
    const { findings } = cargoSemverChecks.parseOutput(
      ran(100, stdout, stderr),
      ctx(root, { options: semverTask(root) }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        file: `${root}/Cargo.toml`,
        line: 1,
        // Unlocated: a baseline that accepts this removal accepts no other.
        ruleId: "function_missing:function semverfix::sub",
        severity: "error",
        message:
          "pub fn removed or renamed: function semverfix::sub, previously at src/lib.rs:2; semverfix needs a new major version: restore it, or release that version",
        url: "https://doc.rust-lang.org/cargo/reference/semver.html#item-remove",
      }),
    ]);
    // unchanged / clean-addition: exit 0, nothing on stdout.
    expect(
      cargoSemverChecks.parseOutput(
        ran(0, "", ""),
        ctx(root, { options: semverTask(root) }),
      ).findings,
    ).toEqual([]);
    expect(() =>
      cargoSemverChecks.parseOutput(
        ran(100, "something else\n", stderr),
        ctx(root, { options: semverTask(root) }),
      ),
    ).toThrow("printed no `--- failure` block");
  });

  it("puts each crate's items where they are now, with that crate's own version need", () => {
    // The reviewer's semws: sema removes `sub` (major), semb adds
    // #[must_use] (minor); the items it still has are named in place.
    const root = tmp("vk-semver-");
    const out = `--- failure function_missing: pub fn removed or renamed ---
Failed in:
  function sema::sub, previously in file <TMP>/target/semver-checks/git-9381f3f/9381f3f8e6d640654a9423a3c7e5ebf60db00850/crates/a/src/lib.rs:2
--- failure function_must_use_added: function #[must_use] added ---
Failed in:
  function semb::mul in ${root}/crates/b/src/lib.rs:2
--- failure struct_must_use_added: struct #[must_use] added ---
Failed in:
  struct S in ${root}/crates/b/src/lib.rs:4
`;
    const err = `    Checking sema v1.0.0 -> v1.0.0 (no change; assume patch)
     Summary semver requires new major version: 1 major and 0 minor checks failed
    Checking semb v1.0.0 -> v1.0.1 (patch change)
     Summary semver requires new minor version: 0 major and 3 minor checks failed
`;
    const { findings } = cargoSemverChecks.parseOutput(
      ran(100, out, err),
      ctx(root, {
        options: {
          base: "9381f3f",
          crates: [
            { name: "sema", dir: `${root}/crates/a` },
            { name: "semb", dir: `${root}/crates/b` },
          ],
          prefix: "",
        },
      }),
    );
    expect(
      findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.message.split("; ")[1],
      ]),
    ).toEqual([
      [
        "crates/a/Cargo.toml",
        1,
        "function_missing:function sema::sub",
        "sema needs a new major version: restore it, or release that version",
      ],
      [
        "crates/b/src/lib.rs",
        2,
        "function_must_use_added",
        "semb needs a new minor version: restore it, or release that version",
      ],
      [
        "crates/b/src/lib.rs",
        4,
        "struct_must_use_added",
        "semb needs a new minor version: restore it, or release that version",
      ],
    ]);
  });

  it("runs for a library crate that chose it, against the merge base with origin's default branch", () => {
    const lib = project("vk-semver-", {
      "Cargo.toml":
        '[package]\nname = "a"\nversion = "0.1.0"\n\n[package.metadata.cargo-semver-checks.lints]\nfunction_missing = "deny"\n',
      "src/lib.rs": "pub fn add() {}\n",
    });
    const bin = project("vk-semver-", {
      "Cargo.toml": '[package]\nname = "b"\nversion = "0.1.0"\n',
      "src/main.rs": "fn main() {}\n",
    });
    // A workspace of binaries only (the reviewer's sembin).
    const bins = project("vk-semver-", {
      "Cargo.toml":
        '[workspace]\nmembers = ["crates/app"]\n\n[workspace.metadata.cargo-semver-checks]\n',
      "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "1.0.0"\n',
      "crates/app/src/main.rs": "fn main() {}\n",
    });
    expect(cargoSemverChecks.adoptedAt?.(lib, lib)).toBe(true);
    expect(cargoSemverChecks.adoptedAt?.(bin, bin)).toBe(false);
    expect(expand(cargoSemverChecks, bin, { enabled: true })).toEqual([]);
    expect(expand(cargoSemverChecks, bins)).toEqual([]);
    const g = gitIn(lib);
    g("init", "-q");
    g("add", ".");
    g("commit", "-qm", "v1");
    // No origin: it cannot run, which leaves a ci run incomplete.
    const [unbased] = expand(cargoSemverChecks, lib);
    expect(unbased?.cannotRun).toMatch(/^no merge base of HEAD/);
    expect(unbased?.options).toBeUndefined();
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    const head = g("rev-parse", "HEAD");
    const options = {
      base: head,
      crates: [{ name: "a", dir: lib }],
      prefix: "",
    };
    expect(expand(cargoSemverChecks, lib)).toEqual([{ cwd: lib, options }]);
    const cmd = cargoSemverChecks.buildArgs(ctx(lib, { options }));
    expect(cmd.args).toEqual([
      "semver-checks",
      "--baseline-rev",
      head,
      "--color",
      "never",
      "-p",
      "a",
    ]);
    expect(cmd.okExitCodes).toEqual([0, 100]);
  });

  it("skips a crate the main branch does not have yet: the change that adds it", () => {
    // The reviewer's semnew: main has only a README.
    const root = project("vk-semver-", { README: "readme\n" });
    const g = gitIn(root);
    g("init", "-q");
    g("add", ".");
    g("commit", "-qm", "v1");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "semnew"\nversion = "0.1.0"\n\n[package.metadata.cargo-semver-checks]\n',
    );
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "lib.rs"), "pub fn add() {}\n");
    g("add", ".");
    g("commit", "-qm", "crate");
    expect(expand(cargoSemverChecks, root)).toEqual([]);
  });
});

describe("kani", () => {
  // finding-report.json, trimmed to the keys the kit reads.
  const report = {
    harness_metadata: [
      {
        pretty_name: "proofs::double_small_ok",
        source: { file: "src/lib.rs", start_line: 17, end_line: 21 },
      },
      {
        pretty_name: "proofs::double_overflows",
        source: { file: "src/lib.rs", start_line: 11, end_line: 14 },
      },
    ],
    verification_results: {
      summary: {
        total_harnesses: 2,
        executed: 2,
        status: "completed",
        successful: 1,
        failed: 1,
        duration_ms: 14,
      },
      results: [
        {
          harness_id: "proofs::double_small_ok",
          status: "Success",
          checks: [
            {
              id: 1,
              function: "double",
              status: "Success",
              description: "attempt to multiply with overflow",
              category: "assertion",
              location: { file: "src/lib.rs", line: "2", column: "5" },
            },
          ],
        },
        {
          harness_id: "proofs::double_overflows",
          status: "Failure",
          checks: [
            {
              id: 1,
              function: "double",
              status: "Failure",
              description: "attempt to multiply with overflow",
              category: "assertion",
              location: { file: "src/lib.rs", line: "2", column: "5" },
            },
          ],
        },
      ],
    },
  };

  it("reports each failed check where it fails, from the JSON even when the exit code says 0", () => {
    const root = tmp("vk-kani-");
    const expected = [
      expect.objectContaining({
        file: `${root}/src/lib.rs`,
        line: 2,
        col: 5,
        ruleId: "assertion",
        severity: "error",
        message:
          "attempt to multiply with overflow in double: harness proofs::double_overflows reaches it for some input",
      }),
    ];
    expect(kani.parseOutput(ran(1), withReport(root, report)).findings).toEqual(
      expected,
    );
    // finding-quiet: `-q` exits 0 with a failing harness.
    expect(kani.parseOutput(ran(0), withReport(root, report)).findings).toEqual(
      expected,
    );
    // A check inside the standard library is placed at its harness.
    const inStd = structuredClone(report);
    const failing = inStd.verification_results.results[1]?.checks[0];
    if (failing)
      failing.location.file = "/rustc/abc/library/core/src/num/mod.rs";
    expect(
      kani.parseOutput(ran(1), withReport(root, inStd)).findings[0],
    ).toMatchObject({ file: `${root}/src/lib.rs`, line: 11 });
    // Run in a member's folder, Kani names files from the workspace root
    // (the reviewer's kaniws: `File: "crates/k/src/lib.rs"`).
    const inMember = structuredClone(report);
    const member = inMember.verification_results.results[1]?.checks[0];
    if (member) member.location.file = "crates/k/src/lib.rs";
    expect(
      kani.parseOutput(ran(1), withReport(`${root}/crates/k`, inMember, root))
        .findings[0]?.file,
    ).toBe(`${root}/crates/k/src/lib.rs`);
  });

  it("is a crash when nothing was verified: no report, or no harness in it", () => {
    const root = tmp("vk-kani-");
    // compile-error.stdout: no report is written.
    expect(() =>
      kani.parseOutput(
        ran(
          1,
          "Kani Rust Verifier 0.68.0 (cargo plugin)\nCBMC 6.11.0\nerror[E0425]: cannot find function `undefined` in this scope\n --> src/lib.rs:1:30\nerror: Failed to execute cargo (exit status: 101). Found 1 compilation errors.\n",
        ),
        crate(root),
      ),
    ).toThrow(
      "kani wrote no report (exit 1): error[E0425]: cannot find function `undefined` in this scope",
    );
    const none = {
      harness_metadata: [],
      verification_results: {
        summary: { total_harnesses: 0, executed: 0 },
        results: [],
      },
    };
    expect(() => kani.parseOutput(ran(0), withReport(root, none))).toThrow(
      "kani verified no harness",
    );
    expect(() =>
      kani.parseOutput(ran(0), withReport(root, { verification_results: {} })),
    ).toThrow("its output format may have changed");
  });

  it("runs where a crate in scope has a proof harness, with the report in scratch", () => {
    const proven = project("vk-kani-", {
      "Cargo.toml": '[package]\nname = "k"\nversion = "0.1.0"\n',
      "src/lib.rs":
        "pub fn double(x: u8) -> u8 { x * 2 }\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn p() {}\n}\n",
    });
    const plain = project("vk-kani-", {
      "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub fn double(x: u8) -> u8 { x * 2 }\n",
    });
    // A harness only under cfg_attr (the reviewer's kanicfgattr).
    const attr = project("vk-kani-", {
      "Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\n',
      "src/lib.rs":
        "#[cfg_attr(kani, kani::proof)]\nfn p() { let x: u8 = kani::any(); }\n",
    });
    expect(expand(kani, proven, {}, scoped(proven))).toEqual([
      { cwd: proven, options: { workspaceRoot: proven, atRoot: true } },
    ]);
    expect(expand(kani, plain, {}, scoped(plain))).toEqual([]);
    expect(expand(kani, attr, {}, scoped(attr))).toHaveLength(1);
    // Enabled, it runs (and fails loud if there is no harness).
    expect(expand(kani, plain, { enabled: true }, scoped(plain))).toHaveLength(
      1,
    );
    const c = crate(proven, tmp("vk-kani-ws-"));
    const cmd = kani.buildArgs(c);
    expect(cmd.args.slice(0, 3)).toEqual(["kani", "--output-format", "terse"]);
    // At a workspace root, every member (kaniws: the root's own harness passed
    // while a member's failed unchecked).
    expect(kani.buildArgs(crate(proven)).args).toContain("--workspace");
    expect(cmd.args).not.toContain("--workspace");
    expect(cmd.args.slice(-4)).toEqual([
      "-Z",
      "unstable-options",
      "--export-json",
      join(c.tempDir?.() ?? "", "kani.json"),
    ]);
    expect(kani.refuseArgs?.(["--concrete-playback=inplace"])).toBeDefined();
  });
});

describe("miri", () => {
  // finding-json-diagnostics.stderr, the UB diagnostic trimmed to the
  // fields the kit reads.
  const ub = JSON.stringify({
    $message_type: "diagnostic",
    message:
      "Undefined Behavior: memory access failed: attempting to access 4 bytes, but got alloc46659+0x8 which is at or beyond the end of the allocation of size 8 bytes",
    code: null,
    level: "error",
    spans: [
      {
        file_name: "src/lib.rs",
        line_start: 3,
        line_end: 3,
        column_start: 14,
        column_end: 32,
        is_primary: true,
        label: "Undefined Behavior occurred here",
      },
    ],
    children: [
      {
        message:
          "this indicates a bug in the program: it performed an invalid operation, and caused Undefined Behavior",
        level: "help",
        spans: [],
      },
      {
        message: "this is on thread `tests::reads_past_the_end`",
        level: "note",
        spans: [],
      },
      {
        message:
          "stack backtrace:\n0: third\n    at src/lib.rs:3:14: 3:32\n1: tests::reads_past_the_end\n    at src/lib.rs:13:20: 13:29\n2: tests::reads_past_the_end::{closure#0}\n    at src/lib.rs:11:28: 11:28",
        level: "note",
        spans: [],
      },
    ],
  });
  const stderr = [
    "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.00s",
    "     Running unittests src/lib.rs (<TARGET>/miri/aarch64-apple-darwin/debug/build/mirifix/8fb3a8cb53f45a6f/out/mirifix-8fb3a8cb53f45a6f)",
    ub,
    '{"$message_type":"diagnostic","message":"some details are omitted, run with `MIRIFLAGS=-Zmiri-backtrace=full` for a verbose backtrace","code":null,"level":"note","spans":[],"children":[],"rendered":"note: some details are omitted, run with `MIRIFLAGS=-Zmiri-backtrace=full` for a verbose backtrace\\n\\n"}',
    '{"$message_type":"diagnostic","message":"aborting due to 1 previous error","code":null,"level":"error","spans":[],"children":[],"rendered":"error: aborting due to 1 previous error\\n\\n"}',
    "error: test failed, to rerun pass `--lib`",
    "",
  ].join("\n");
  const stdout =
    "WARNING: Ignoring `RUSTC_WRAPPER` environment variable, Miri does not support wrapping.\n\nrunning 2 tests\ntest tests::plain_ok ... ok\ntest tests::reads_past_the_end ... ";

  it("reports undefined behaviour at its span, naming the test", () => {
    const root = tmp("vk-miri-");
    const { findings } = miri.parseOutput(ran(1, stdout, stderr), crate(root));
    expect(findings).toEqual([
      expect.objectContaining({
        file: `${root}/src/lib.rs`,
        line: 3,
        col: 14,
        endCol: 32,
        ruleId: "undefined-behavior",
        severity: "error",
        message:
          "Undefined Behavior: memory access failed: attempting to access 4 bytes, but got alloc46659+0x8 which is at or beyond the end of the allocation of size 8 bytes (test tests::reads_past_the_end)",
      }),
    ]);
    // In the standard library: its first frame in the crate.
    const inStd = stderr.replace(
      '"file_name":"src/lib.rs"',
      '"file_name":"/home/u/.rustup/toolchains/nightly/lib/rustlib/src/rust/library/core/src/ptr/mod.rs"',
    );
    expect(
      miri.parseOutput(ran(1, stdout, inStd), crate(root)).findings[0],
    ).toMatchObject({ file: `${root}/src/lib.rs`, line: 3, col: 14 });
    // Run in a member's folder: from the workspace root (miriws).
    expect(
      miri.parseOutput(ran(1, stdout, stderr), crate(`${root}/crates/m`, root))
        .findings[0]?.file,
    ).toBe(`${root}/src/lib.rs`);
    // A doc test: rustdoc prints its stderr, the diagnostic, on stdout
    // (the reviewer's miridoc).
    const doctest = `\nrunning 1 test\ntest src/lib.rs - third (line 3) ... FAILED\n\nfailures:\n\n---- src/lib.rs - third (line 3) stdout ----\nTest executable failed (exit status: 1).\n\nstderr:\n${ub}\n`;
    expect(
      miri.parseOutput(
        ran(101, doctest, "error: doctest failed, to rerun pass `--doc`\n"),
        crate(root),
      ).findings,
    ).toHaveLength(1);
  });

  it("is a crash when it fails without a diagnostic, or ran no test", () => {
    const root = tmp("vk-miri-");
    // bad-miri-flag.stderr
    expect(() =>
      miri.parseOutput(
        ran(
          1,
          "WARNING: Ignoring `RUSTC_WRAPPER` environment variable, Miri does not support wrapping.\n",
          "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.00s\nerror: unknown unstable option: `miri-nope`\n\nerror: test failed, to rerun pass `--lib`\n",
        ),
        crate(root),
      ),
    ).toThrow("miri failed: error: unknown unstable option: `miri-nope`");
    // test-filter-no-match.stdout: exit 0, nothing ran.
    expect(() =>
      miri.parseOutput(
        ran(
          0,
          "\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.03s\n\n",
        ),
        crate(root),
      ),
    ).toThrow("miri ran no test");
    // clean.stdout
    expect(
      miri.parseOutput(
        ran(
          0,
          "\nrunning 2 tests\ntest tests::plain_ok ... ok\ntest tests::reads_past_the_end ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s\n\n\nrunning 0 tests\n",
        ),
        crate(root),
      ).findings,
    ).toEqual([]);
  });

  it("runs only where enabled, every test binary and member, with JSON diagnostics and its own target dir", () => {
    const root = tmp("vk-miri-");
    expect(expand(miri, root)).toEqual([]);
    expect(expand(miri, root, { enabled: true })).toEqual([
      { cwd: root, options: { workspaceRoot: root, atRoot: true } },
    ]);
    const cmd = miri.buildArgs(crate(root, tmp("vk-miri-ws-")));
    // Without --no-fail-fast the first failing test binary hides the rest.
    expect(cmd.args).toEqual(["+nightly", "miri", "test", "--no-fail-fast"]);
    expect(miri.buildArgs(crate(root)).args).toContain("--workspace");
    expect(cmd.env?.MIRIFLAGS).toMatch(/--error-format=json$/);
    expect(cmd.env?.PATH?.split(delimiter)[0]).toBe(RUSTUP_BIN);
  });
});

describe("capslock", () => {
  // compare-new.stdout / compare-removed.stdout (exit 1)
  const path = `                example.com/capfix.main
main.go:9:41    example.com/capfix/runner.Version
runner.go:7:24  os/exec.Command
`;

  it("reports a new capability as an error where the module calls out, a removed one as info", () => {
    const root = module();
    const added = capslock.parseOutput(
      ran(
        1,
        `Package example.com/capfix has new capability EXEC compared to the baseline.\n${path}`,
      ),
      ctx(root),
    );
    expect(added.findings).toEqual([
      expect.objectContaining({
        file: `${root}/runner/runner.go`,
        line: 7,
        col: 24,
        ruleId: "EXEC",
        severity: "error",
        message:
          "example.com/capfix gained capability EXEC, which the baseline does not have (example.com/capfix.main -> example.com/capfix/runner.Version -> os/exec.Command): remove the call, or record the baseline again if it is intended",
      }),
    ]);
    const removed = capslock.parseOutput(
      ran(
        1,
        `Package example.com/capfix no longer has capability EXEC which was in the baseline.\n${path}`,
      ),
      ctx(root),
    );
    expect(removed.findings).toEqual([
      expect.objectContaining({ ruleId: "EXEC", severity: "info" }),
    ]);
    // compare-same: exit 0, empty.
    expect(capslock.parseOutput(ran(0), ctx(root)).findings).toEqual([]);
    expect(() =>
      capslock.parseOutput(ran(1, "Something else changed.\n"), ctx(root)),
    ).toThrow("its output format may have changed");
  });

  it("runs only where enabled with a committed baseline", () => {
    const root = module();
    expect(expand(capslock, root)).toEqual([]);
    expect(() => expand(capslock, root, { enabled: true })).toThrow(
      "tools.capslock.options.baseline",
    );
    expect(
      expand(capslock, root, {
        enabled: true,
        options: { baseline: "missing.json" },
      })[0]?.cannotRun,
    ).toMatch(/^no capslock baseline at missing\.json/);
    const [task] = expand(capslock, root, {
      enabled: true,
      options: { baseline: "capslock.json" },
    });
    expect(task?.options).toEqual({ baseline: join(root, "capslock.json") });
    expect(
      capslock.buildArgs(ctx(root, { options: task?.options })).args,
    ).toEqual([
      "-output=compare",
      "-force_local_module",
      join(root, "capslock.json"),
    ]);
  });
});

describe("gorelease", () => {
  const task = { base: "v1.0.0" };

  it("reports each incompatible change on go.mod, and a proposed version that does not fit", () => {
    const root = tmp("vk-gorel-");
    // removed.stdout
    expect(
      gorelease.parseOutput(
        ran(
          1,
          "# example.com/relfix\n## incompatible changes\nBye: removed\n\n# summary\nCannot suggest a release version.\nIncompatible changes were detected.\n\n",
        ),
        ctx(root, { options: task }),
      ).findings,
    ).toEqual([
      expect.objectContaining({
        file: `${root}/go.mod`,
        line: 1,
        // No line: the symbol keys the baseline, so accepting the removal of
        // Bye does not accept the removal of Hello (the reviewer's gorel).
        ruleId: "incompatible-change:example.com/relfix.Bye",
        severity: "error",
        message:
          "example.com/relfix.Bye: removed, incompatible with v1.0.0: restore it, or release a new major version",
      }),
    ]);
    // clean-addition-version-patch.stdout
    expect(
      gorelease
        .parseOutput(
          ran(
            1,
            "# example.com/relfix\n## compatible changes\nHi: added\n\n# summary\nv1.0.1 is not a valid semantic version for this release.\nThere are compatible changes, but the minor version is not incremented\nover the base version (v1.0.0).\n",
          ),
          ctx(root, { options: task }),
        )
        .findings.map((f) => [f.ruleId, f.message]),
    ).toEqual([
      [
        "release-version:v1.0.1",
        "v1.0.1 is not a valid semantic version for this release. There are compatible changes, but the minor version is not incremented over the base version (v1.0.0).",
      ],
    ]);
    // unchanged.stdout
    expect(
      gorelease.parseOutput(
        ran(0, "# summary\nSuggested version: v1.0.1\n"),
        ctx(root, { options: task }),
      ).findings,
    ).toEqual([]);
  });

  it("is a crash with gorelease's own error: a tree with uncommitted changes", () => {
    const root = tmp("vk-gorel-");
    // dirty-tree.stderr
    expect(() =>
      gorelease.parseOutput(
        ran(1, "", "gorelease: repo <TMP>/repo has uncommitted changes\n"),
        ctx(root, { options: task }),
      ),
    ).toThrow("gorelease: repo <TMP>/repo has uncommitted changes");
    expect(() =>
      gorelease.parseOutput(ran(1, "\n"), ctx(root, { options: task })),
    ).toThrow("its output format may have changed");
  });

  it("runs only where enabled with a base version", () => {
    const root = tmp("vk-gorel-");
    expect(expand(gorelease, root)).toEqual([]);
    expect(() => expand(gorelease, root, { enabled: true })).toThrow(
      "tools.gorelease.options.base",
    );
    const [seed] = expand(gorelease, root, {
      enabled: true,
      options: { base: "v1.0.0" },
    });
    expect(
      gorelease.buildArgs(ctx(root, { options: seed?.options })).args,
    ).toEqual(["-base=v1.0.0"]);
  });

  it("runs in a clone of HEAD, so an untracked file in the work tree is not a refusal", () => {
    // The reviewer's gorel: a Cargo.lock another tool left made it refuse.
    const repo = project("vk-gorel-", {
      "mod/go.mod": "module example.com/relfix\n",
      "mod/lib.go": "package relfix\n",
    });
    const g = gitIn(repo);
    g("init", "-q");
    g("add", ".");
    g("commit", "-qm", "v1");
    writeFileSync(join(repo, "mod", "untracked.txt"), "");
    const c = ctx(`${repo}/mod`, { options: task });
    const { cwd } = gorelease.buildArgs(c);
    expect(cwd).toBe(join(c.tempDir?.() ?? "", "head", "mod/"));
    expect(existsSync(join(cwd ?? "", "lib.go"))).toBe(true);
    expect(existsSync(join(cwd ?? "", "untracked.txt"))).toBe(false);
  });
});

describe("go-arch-lint", () => {
  it("reports a forbidden import, a file in no component and an injection at their places", () => {
    const root = tmp("vk-gal-");
    // finding-json.stdout
    const deps = goArchLint.parseOutput(
      ran(
        1,
        archReport({
          ArchWarningsDeps: [
            {
              ComponentName: "handler",
              FileRelativePath: "/handler/handler.go",
              FileAbsolutePath: `${root}/handler/handler.go`,
              ResolvedImportName: "example.com/archfix/repo",
              Reference: {
                Valid: true,
                File: `${root}/handler/handler.go`,
                Line: 4,
                Offset: 2,
              },
            },
          ],
        }),
      ),
      ctx(root),
    );
    expect(deps.findings).toEqual([
      expect.objectContaining({
        file: `${root}/handler/handler.go`,
        line: 4,
        col: 2,
        ruleId: "forbidden-dependency",
        severity: "error",
        message:
          "component handler may not depend on example.com/archfix/repo: remove the import, or allow it under deps.handler in the arch file",
      }),
    ]);
    const other = goArchLint.parseOutput(
      ran(
        1,
        archReport({
          ArchWarningsNotMatched: [
            {
              FileRelativePath: "/extra/e.go",
              FileAbsolutePath: `${root}/extra/e.go`,
            },
          ],
          ArchWarningsDeepScan: [
            {
              Gate: {
                ComponentName: "service",
                MethodName: "Use",
                Definition: {
                  Valid: true,
                  File: `${root}/service/service.go`,
                  Line: 5,
                  Offset: 10,
                },
              },
              Dependency: {
                ComponentName: "repo",
                Name: "repo.R",
                InjectionAST: "repo.R{}",
                Injection: {
                  Valid: true,
                  File: `${root}/handler/handler.go`,
                  Line: 8,
                  Offset: 43,
                },
              },
              Target: {
                Definition: {
                  Valid: true,
                  File: `${root}/repo/repo.go`,
                  Line: 3,
                  Offset: 1,
                },
              },
            },
          ],
        }),
      ),
      ctx(root),
    );
    expect(
      other.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.col,
        f.ruleId,
      ]),
    ).toEqual([
      ["extra/e.go", 1, 1, "unmatched-file"],
      ["handler/handler.go", 8, 43, "forbidden-injection"],
    ]);
    expect(other.findings[1]?.message).toBe(
      "service.Use is given repo.R from component repo, which service may not depend on: pass an implementation from an allowed component, or allow the dependency in the arch file",
    );
    // clean-json.stdout
    expect(
      goArchLint.parseOutput(
        ran(0, archReport({ ArchHasWarnings: false })),
        ctx(root),
      ).findings,
    ).toEqual([]);
  });

  it("is a crash when it prints text, not a report: every failure exits 1", () => {
    const root = tmp("vk-gal-");
    // missing-archfile.stderr
    expect(() =>
      goArchLint.parseOutput(
        ran(
          1,
          "",
          "failed to assemble project info: not found archfile in '<ROOT>/nope.yml'\n",
        ),
        ctx(root),
      ),
    ).toThrow(
      "go-arch-lint failed: failed to assemble project info: not found archfile in '<ROOT>/nope.yml'",
    );
    expect(() =>
      goArchLint.parseOutput(ran(1, archReport({})), ctx(root)),
    ).toThrow("its output format may have changed");
  });

  it("is a crash, never a finding a baseline accepts, when the arch file has errors", () => {
    const root = tmp("vk-gal-");
    // The reviewer's gal1 (`repo: {}`, which hides the real import) and an
    // arch file that does not parse, whose error names no file.
    expect(() =>
      goArchLint.parseOutput(
        ran(
          1,
          archReport({
            ArchHasWarnings: false,
            ExecutionWarnings: [
              {
                Text: "should have ref in 'mayDependOn'/'canUse' or at least one flag of ['anyProjectDeps', 'anyVendorDeps']",
                File: `${root}/.go-arch-lint.yml`,
                Line: 12,
                Offset: 9,
              },
              {
                Text: "($.deps) deps is required",
                File: "",
                Line: 0,
                Offset: 0,
              },
            ],
          }),
        ),
        ctx(root),
      ),
    ).toThrow(
      "go-arch-lint: the arch file has errors, so it checked nothing: .go-arch-lint.yml:12:9: should have ref in 'mayDependOn'/'canUse' or at least one flag of ['anyProjectDeps', 'anyVendorDeps']; ($.deps) deps is required",
    );
  });

  it("runs where the module root has a .go-arch-lint.yml, not one above it", () => {
    const top = project("vk-gal-", {
      ".go-arch-lint.yml": "version: 3\n",
      "go.mod": "module example.com/a\n",
      "sub/go.mod": "module example.com/b\n",
    });
    expect(goArchLint.adoptedAt?.(top, top)).toBe(true);
    expect(goArchLint.adoptedAt?.(`${top}/sub`, top)).toBe(false);
    expect(goArchLint.buildArgs(ctx(top)).args).toEqual(["check", "--json"]);
  });
});
