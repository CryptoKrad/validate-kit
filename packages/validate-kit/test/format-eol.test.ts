import "./isolated-git.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crlfCheckouts, listedFiles } from "../src/adapters/base.js";
import { gofmt } from "../src/adapters/gofmt.js";
import { gofumpt } from "../src/adapters/gofumpt.js";
import { goModTidy } from "../src/adapters/go-mod-tidy.js";
import type { RawOutput, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// A formatter that always writes LF reads the WORK TREE. Under core.autocrlf
// the work tree holds CRLF where the commit holds LF, so the formatter lists
// every such file as unformatted whatever its content. Found on a real repo
// (a Windows clone, core.autocrlf=true, no .gitattributes) where `gofmt -l`
// listed 41 Go files whose commits were all LF -- and those 41 hid the 2 that
// were really unformatted.
//
// The gofmt stdout below was captured from a real run on 2026-11-05 (go1.27.0
// windows/amd64, git 2.49.0.windows.1) against exactly the fixture repo()
// builds: gofmt lists all four files. The eol states are not assumed either:
// each test reads them back from git before trusting the fixture.
const GOFMT_LISTS_ALL =
  "clean.go\nugly.go\ncommitted_crlf.go\nuntracked_crlf.go\n";

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function ctx(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, fix: false, extraArgs: [], ...extra };
}

const ran = (exitCode: number, stdout = ""): RawOutput => ({
  stdout,
  stderr: "",
  exitCode,
});

/**
 * Four files, one per case:
 *   clean.go          LF in the commit, gofmt-clean, CRLF on checkout
 *   ugly.go           LF in the commit, NOT gofmt-clean, CRLF on checkout
 *   committed_crlf.go CRLF in the commit itself
 *   untracked_crlf.go CRLF on disk, never committed
 */
function repo(): string {
  const root = tmp("vk-eol-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  // Store exactly the bytes written, then let checkout convert.
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "clean.go"), "package a\n\nfunc A() {}\n");
  writeFileSync(join(root, "ugly.go"), "package a\n\nfunc   B(){}\n");
  writeFileSync(
    join(root, "committed_crlf.go"),
    "package a\r\n\r\nfunc C() {}\r\n",
  );
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git("config", "core.autocrlf", "true");
  rmSync(join(root, "clean.go"));
  rmSync(join(root, "ugly.go"));
  git("checkout", "--", "clean.go", "ugly.go");
  writeFileSync(
    join(root, "untracked_crlf.go"),
    "package a\r\n\r\nfunc D() {}\r\n",
  );
  return root;
}

/** git's own reading of each file, so a fixture that did not convert fails loudly. */
function eolStates(root: string): Record<string, string> {
  const out = execFileSync("git", ["ls-files", "--eol", "-z"], { cwd: root })
    .toString()
    .split("\0");
  const states: Record<string, string> = {};
  for (const entry of out) {
    const m = /^i\/(\S*)\s+w\/(\S*)\s+attr\/[^\t]*\t(.*)$/s.exec(entry);
    if (m?.[3]) states[m[3]] = `i/${m[1]} w/${m[2]}`;
  }
  return states;
}

const rel = (root: string, file: string) => file.slice(root.length + 1);

describe("formatters on a core.autocrlf checkout", () => {
  it("builds the fixture it claims to (the instrument, before the measurement)", () => {
    expect(eolStates(repo())).toEqual({
      "clean.go": "i/lf w/crlf",
      "committed_crlf.go": "i/crlf w/crlf",
      "ugly.go": "i/lf w/crlf",
    });
  });

  it("gofmt says a CRLF checkout of an LF commit is the checkout, and keeps every other finding", () => {
    const root = repo();
    const { findings } = gofmt.parseOutput(ran(0, GOFMT_LISTS_ALL), ctx(root));
    expect(
      findings.map((f) => [
        rel(root, f.file),
        f.ruleId ?? "",
        f.severity,
        f.fixable,
      ]),
    ).toEqual([
      // Proven LF in the commit and CRLF on disk: reported as such.
      ["clean.go", "crlf-checkout", "warning", false],
      // Indistinguishable from clean.go by line endings, so its formatting
      // verdict is DEFERRED, not excused: after the re-checkout it is listed
      // again as unformatted, which is what happened on the repo that found
      // this (41 checkout findings, then the 2 real ones).
      ["ugly.go", "crlf-checkout", "warning", false],
      // The commit itself is CRLF: that is a real gofmt finding. Kept.
      ["committed_crlf.go", "", "warning", true],
      // Never committed: no proof of anything, so the finding stands.
      ["untracked_crlf.go", "", "warning", true],
    ]);
    const deferred = findings.find((f) => f.ruleId === "crlf-checkout");
    expect(deferred?.message).toMatch(/\*\.go text eol=lf/);
    expect(deferred?.message).toMatch(/cannot judge/);
    // Never claims the file is formatted.
    expect(deferred?.message).not.toMatch(/\bis formatted\b|\bclean\b/i);
    // The unproven findings are byte-for-byte what they were.
    expect(
      findings.find((f) => rel(root, f.file) === "committed_crlf.go")?.message,
    ).toBe("File is not gofmt-formatted");
  });

  it("gofumpt, gofmt's printer, does the same", () => {
    const root = repo();
    const { findings } = gofumpt.parseOutput(
      ran(0, GOFMT_LISTS_ALL),
      ctx(root),
    );
    expect(findings.map((f) => [rel(root, f.file), f.ruleId ?? ""])).toEqual([
      ["clean.go", "crlf-checkout"],
      ["ugly.go", "crlf-checkout"],
      ["committed_crlf.go", ""],
      ["untracked_crlf.go", ""],
    ]);
    expect(findings[0]?.message).toMatch(/gofumpt writes LF/);
  });

  it("listedFiles, the shared formatter path, applies it and still lists nothing in a fix pass", () => {
    const root = repo();
    const read = (fix: boolean) =>
      listedFiles(
        "somefmt",
        ran(0, "clean.go\ncommitted_crlf.go\n"),
        ctx(root, { fix }),
        {
          files: /\.go$/,
          message: "unformatted",
        },
      );
    expect(
      read(false).map((f) => [rel(root, f.file), f.ruleId ?? "", f.message]),
    ).toEqual([
      ["clean.go", "crlf-checkout", expect.stringMatching(/somefmt writes LF/)],
      ["committed_crlf.go", "", "unformatted"],
    ]);
    expect(read(true)).toEqual([]);
  });

  it("changes nothing without git, and only ever looks at files the formatter listed", () => {
    const bare = tmp("vk-eol-nogit-");
    writeFileSync(join(bare, "a.go"), "package a\r\n");
    expect(
      gofmt
        .parseOutput(ran(0, "a.go\n"), ctx(bare))
        .findings.map((f) => f.ruleId ?? ""),
    ).toEqual([""]);
    const root = repo();
    // clean.go is i/lf w/crlf, but gofmt did not list it here: not reported.
    expect(crlfCheckouts(root, [])).toEqual(new Set());
    expect([...crlfCheckouts(root, [`${root}/committed_crlf.go`])]).toEqual([]);
    expect(gofmt.parseOutput(ran(0, ""), ctx(root)).findings).toEqual([]);
  });
});

// The same checkout, one adapter over: `go mod tidy -diff` reads go.sum off
// the disk too, so a CRLF go.sum is "not what tidy would write" and the
// kit's only ERROR on the repo that found this. Unlike a formatter's file
// list, tidy's diff is evidence: the kit can see the change is line endings
// and nothing else. Captured on 2026-11-05 (go1.27.0 windows/amd64) as a
// 241-line diff over a 118-line go.sum, every `-` line ending in a carriage
// return; trimmed here to its first two lines, which are real.
const SUM = [
  "github.com/andybalholm/brotli v1.2.0 h1:ukwgCxwYrmACq68yiUqwIWnGY0cTPox/M94sVwToPjQ=",
  "github.com/andybalholm/brotli v1.2.0/go.mod h1:rzTDkvFWvIrjDXZHkuS16NPggd91W3kUSvPlQ1pLaKY=",
];

/** `go mod tidy -diff` as go prints it: LF lines, the file's own CRs kept. */
const tidyDiff = (minus: string[], plus: string[]): string =>
  [
    "diff current/go.sum tidy/go.sum",
    "--- current/go.sum",
    "+++ tidy/go.sum",
    `@@ -1,${minus.length} +1,${plus.length} @@`,
    ...minus.map((line) => `-${line}`),
    ...plus.map((line) => `+${line}`),
    "",
  ].join("\n");

/** A module whose go.sum is committed with `committed` endings, checked out CRLF. */
function moduleRepo(committed: "lf" | "crlf"): string {
  const root = tmp("vk-eol-mod-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  const eol = committed === "lf" ? "\n" : "\r\n";
  writeFileSync(join(root, "go.mod"), "module example.com/m\n\ngo 1.23\n");
  writeFileSync(join(root, "go.sum"), SUM.join(eol) + eol);
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git("config", "core.autocrlf", "true");
  rmSync(join(root, "go.sum"));
  git("checkout", "--", "go.sum");
  return root;
}

describe("go-mod-tidy on a core.autocrlf checkout", () => {
  const cr = SUM.map((line) => `${line}\r`);

  it("builds the fixtures it claims to", () => {
    expect(eolStates(moduleRepo("lf"))["go.sum"]).toBe("i/lf w/crlf");
    expect(eolStates(moduleRepo("crlf"))["go.sum"]).toBe("i/crlf w/crlf");
  });

  it("calls an LF commit whose only diff is line endings tidy, as a warning about the checkout", () => {
    const root = moduleRepo("lf");
    const { findings } = goModTidy.parseOutput(
      ran(1, tidyDiff(cr, SUM)),
      ctx(root),
    );
    expect(
      findings.map((f) => [rel(root, f.file), f.ruleId, f.severity, f.fixable]),
    ).toEqual([["go.sum", "crlf-checkout", "warning", false]]);
    expect(findings[0]?.message).toMatch(/go\.sum is tidy/);
    expect(findings[0]?.message).toMatch(/go\.sum text eol=lf/);
  });

  it("keeps the error when tidy would really change something, CRLF or not", () => {
    const root = moduleRepo("lf");
    // tidy drops the second line: a require nothing imports.
    const { findings } = goModTidy.parseOutput(
      ran(1, tidyDiff(cr, SUM.slice(0, 1))),
      ctx(root),
    );
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["untidy", "error"],
    ]);
  });

  it("keeps the error when the commit itself is CRLF: CI's checkout is not clean then", () => {
    const root = moduleRepo("crlf");
    const { findings } = goModTidy.parseOutput(
      ran(1, tidyDiff(cr, SUM)),
      ctx(root),
    );
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["untidy", "error"],
    ]);
  });
});
