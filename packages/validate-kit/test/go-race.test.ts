import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goRace } from "../src/adapters/go-race.js";
import type { PlanEnv, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// `go test -race -json ./...` on go 1.25.11 against a module with a race in
// a subtest, a failing test, a panicking test, a package that does not
// compile and a passing one; its start/run/pass events and timings trimmed,
// and the module's path replaced by ROOT
// (docs/research/lint-toolchain/go-race.md, assets/go-race-2026-10-14/).
const RECORDED = [
  String.raw`{"ImportPath":"ag4/broken [ag4/broken.test]","Action":"build-output","Output":"# ag4/broken [ag4/broken.test]\n"}`,
  String.raw`{"ImportPath":"ag4/broken [ag4/broken.test]","Action":"build-output","Output":"broken/b.go:3:23: cannot use \"x\" (untyped string constant) as int value in return statement\n"}`,
  String.raw`{"ImportPath":"ag4/broken [ag4/broken.test]","Action":"build-fail"}`,
  String.raw`{"Action":"output","Package":"ag4/broken","Output":"FAIL\tag4/broken [build failed]\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/broken","FailedBuild":"ag4/broken [ag4/broken.test]"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace","Output":"=== RUN   TestSubRace\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"=== RUN   TestSubRace/shared\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"==================\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"WARNING: DATA RACE\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"Read at 0x00c0000102e8 by goroutine 9:\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.bump.func1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:14 +0x6c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"Previous write at 0x00c0000102e8 by goroutine 10:\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.bump.func1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:14 +0x7c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"Goroutine 9 (running) created at:\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.bump()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:12 +0x54\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.TestSubRace.func1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:23 +0x3c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  testing.tRunner()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      /usr/local/go/src/testing/testing.go:1934 +0x164\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  testing.(*T).Run.gowrap1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      /usr/local/go/src/testing/testing.go:1997 +0x3c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"Goroutine 10 (finished) created at:\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.bump()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:12 +0x54\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  ag4/cases.TestSubRace.func1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      ROOT/cases/cases_test.go:23 +0x3c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  testing.tRunner()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      /usr/local/go/src/testing/testing.go:1934 +0x164\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"  testing.(*T).Run.gowrap1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"      /usr/local/go/src/testing/testing.go:1997 +0x3c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"==================\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"    testing.go:1617: race detected during execution of test\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace/shared","Output":"--- FAIL: TestSubRace/shared (0.00s)\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/cases","Test":"TestSubRace/shared"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestSubRace","Output":"--- FAIL: TestSubRace (0.00s)\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/cases","Test":"TestSubRace"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestWrong","Output":"=== RUN   TestWrong\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestWrong","Output":"    cases_test.go:29: got 2, want 3\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestWrong","Output":"--- FAIL: TestWrong (0.00s)\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/cases","Test":"TestWrong"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"=== RUN   TestPanics\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"--- FAIL: TestPanics (0.00s)\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"panic: assignment to entry in nil map [recovered, repanicked]\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"goroutine 34 [running]:\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"testing.tRunner.func1.2({0x100a5e4a0, 0x100b9ef00})\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\t/usr/local/go/src/testing/testing.go:1872 +0x2b4\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"testing.tRunner.func1()\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\t/usr/local/go/src/testing/testing.go:1875 +0x460\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"panic({0x100a5e4a0?, 0x100b9ef00?})\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\t/usr/local/go/src/runtime/panic.go:783 +0x120\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"ag4/cases.TestPanics(0xc0001a21c0?)\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\tROOT/cases/cases_test.go:35 +0x3c\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"testing.tRunner(0xc0001a21c0, 0x100a87de8)\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\t/usr/local/go/src/testing/testing.go:1934 +0x168\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"created by testing.(*T).Run in goroutine 1\n"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Test":"TestPanics","Output":"\t/usr/local/go/src/testing/testing.go:1997 +0x6e4\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/cases","Test":"TestPanics"}`,
  String.raw`{"Action":"output","Package":"ag4/cases","Output":"FAIL\tag4/cases\t0.222s\n"}`,
  String.raw`{"Action":"fail","Package":"ag4/cases"}`,
].join("\n");

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

/** Each recorded case (go 1.25.11, go-race.md) as [file, line, rule, message]. */
function recorded(name: string): (string | number | undefined)[][] {
  const cases = JSON.parse(
    readFileSync(new URL("./go-race-recorded.json", import.meta.url), "utf8"),
  ) as Record<string, { module: string; stdout: string }>;
  const c = cases[name];
  if (!c) throw new Error(`no recorded case ${name}`);
  const root = tmp("vk-race-");
  writeFileSync(join(root, "go.mod"), `module ${c.module}\n`);
  return goRace
    .parseOutput(
      { stdout: c.stdout.replaceAll("ROOT", root), stderr: "", exitCode: 1 },
      ctx(root),
    )
    .findings.map((f) => [
      f.file.slice(root.length + 1),
      f.line,
      f.ruleId,
      f.message,
    ]);
}

function ctx(cwd: string): ToolContext {
  return { cwd, fix: false, extraArgs: [], tempDir: () => cwd };
}

describe("go-race", () => {
  it("reports each race, failed test, panic and compile error where it happened", () => {
    const root = tmp("vk-race-");
    writeFileSync(join(root, "go.mod"), "module ag4\n\ngo 1.25\n");
    const result = goRace.parseOutput(
      { stdout: RECORDED.replaceAll("ROOT", root), stderr: "", exitCode: 1 },
      ctx(root),
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.message,
      ]),
    ).toEqual([
      [
        "broken/b.go",
        3,
        "build-failed",
        'does not compile, so its tests did not run: cannot use "x" (untyped string constant) as int value in return statement',
      ],
      [
        "cases/cases_test.go",
        14,
        "data-race",
        "data race in TestSubRace/shared: read by goroutine 9 at cases/cases_test.go:14; previous write by goroutine 10 at cases/cases_test.go:14",
      ],
      [
        "cases/cases_test.go",
        29,
        "test-failed",
        "TestWrong failed: got 2, want 3",
      ],
      [
        "cases/cases_test.go",
        35,
        "test-failed",
        "TestPanics failed: panic: assignment to entry in nil map [recovered, repanicked]",
      ],
    ]);
  });

  it("names a package that fails outside any test", () => {
    const root = tmp("vk-race-");
    const stdout = [
      '{"Action":"output","Package":"m/p","Output":"init failed: no config\\n"}',
      '{"Action":"output","Package":"m/p","Output":"FAIL\\tm/p\\t0.1s\\n"}',
      '{"Action":"fail","Package":"m/p"}',
    ].join("\n");
    expect(
      goRace
        .parseOutput({ stdout, stderr: "", exitCode: 1 }, ctx(root))
        .findings.map((f) => [
          f.file.slice(root.length + 1),
          f.ruleId,
          f.message,
        ]),
    ).toEqual([
      [
        "go.mod",
        "package-failed",
        "m/p failed outside any test: init failed: no config",
      ],
    ]);
  });

  it("names every test the detector failed, reads -trimpath frames, and places a race in a dependency", () => {
    const parallel = recorded("parallel-trimpath");
    expect(parallel).toEqual([
      [
        "p/p_test.go",
        16,
        "data-race",
        "data race in TestChatty, TestRacy: read by goroutine 8 at p/p_test.go:16; previous write by goroutine 9 at p/p_test.go:16",
      ],
    ]);
    // The accesses are in the dependency; the module's call into it.
    expect(recorded("dep-race")).toEqual([
      [
        "p/p_test.go",
        9,
        "data-race",
        "data race in TestDepRace: read by goroutine 8 at dep9/dep.go:11; previous write by goroutine 7 at dep9/dep.go:11",
      ],
    ]);
  });

  it("reports the failing line after a t.Log, a timeout's test, a build that never ran, vet and TestMain", () => {
    expect(recorded("tlog")).toEqual([
      [
        "p/p_test.go",
        9,
        "test-failed",
        "TestLogThenFail failed: got 2, want 3",
      ],
    ]);
    expect(recorded("timeout")).toEqual([
      [
        "p/p_test.go",
        8,
        "test-unfinished",
        "TestSlow did not finish: panic: test timed out after 2s",
      ],
    ]);
    const [noCompiler] = recorded("no-cc");
    expect(noCompiler?.slice(0, 3)).toEqual(["go.mod", 1, "build-failed"]);
    expect(noCompiler?.[3]).toMatch(
      /did not build.*C compiler "\/nonexistent\/gcc" not found/,
    );
    expect(recorded("vet")).toEqual([
      [
        "p/p_test.go",
        8,
        "vet-failed",
        'go vet (run by go test) fails, so its tests did not run: fmt.Printf format %d has arg "s" of wrong type string',
      ],
    ]);
    expect(recorded("testmain")).toEqual([
      [
        "go.mod",
        1,
        "package-failed",
        "f4/p failed outside any test (TestMain's exit code?)",
      ],
    ]);
  });

  it("runs in each module with tests that ./... would reach, its packages before any extra args", () => {
    const root = tmp("vk-race-");
    const env = { projectRoot: root, scopedFiles: [] } as unknown as PlanEnv;
    const seed = { cwd: root };
    writeFileSync(join(root, "go.mod"), "module m\n");
    expect(goRace.expand?.(seed, env)).toEqual([]);
    writeFileSync(join(root, "a_test.go"), "package m\n");
    expect(goRace.expand?.(seed, env)).toEqual([seed]);
    // A module under testdata/ is a fixture `./...` skips.
    const fixture = join(root, "testdata", "fx");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "go.mod"), "module fx\n");
    writeFileSync(join(fixture, "fx_test.go"), "package fx\n");
    expect(goRace.expand?.({ cwd: toPosix(fixture) }, env)).toEqual([]);
    const built = goRace.buildArgs({
      ...ctx(root),
      extraArgs: ["-run", "TestX", "-args", "-v"],
    });
    expect(built.args).toEqual([
      "test",
      "-race",
      "-json",
      "./...",
      "-run",
      "TestX",
      "-args",
      "-v",
    ]);
    expect(built.processGroup).toBe(true);
    expect(goRace.tier).toBe("deep");
    expect(goRace.refuseArgs?.(["-race=false"])).toMatch(/kit's/);
  });
});
