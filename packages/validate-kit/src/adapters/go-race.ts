import { readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { globSync } from "tinyglobby";
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
import { hiddenFolder } from "../detect/go-packages.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/** One `go test -json` event (cmd/test2json). */
interface Event {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Output?: string;
  FailedBuild?: string;
}

/** `Read at 0x... by goroutine 8:`, `Previous write at ... by main goroutine:` */
const ACCESS = /^(Read|Write|Previous read|Previous write) at \S+ by (.+):$/;
/**
 * A frame's position line: `      /abs/file.go:17 +0x6c`, or under
 * -trimpath `      example.com/m/p/file.go:17 +0x6c`.
 */
const FRAME = /^\s+(\S+?\.go):(\d+)(?: \+0x[0-9a-f]+)?$/;
/** A `t.Errorf`/`t.Fatalf` line: `    counter_test.go:9: got 3`. */
const LOGGED = /^\s+(\S+_test\.go):(\d+): (.*)$/;
/** A compile or vet error: `broken/b.go:3:23: cannot use ...`. */
const COMPILE = /^(.+?\.go):(\d+):(\d+): (.*)$/;
/** The line the race detector adds to the test that raced. */
const RACE_DETECTED = "race detected during execution of test";

/** A test's (or, with no test, its package's) key in the maps below. */
function key(pkg: string, test = ""): string {
  return `${pkg}\0${test}`;
}

/** The module path go.mod declares, `""` without one. */
function modulePath(root: string): string {
  try {
    return (
      /^module\s+(\S+)/m.exec(
        readFileSync(join(root, "go.mod"), "utf8"),
      )?.[1] ?? ""
    );
  } catch {
    return "";
  }
}

/** The module's own `*_test.go` files, in folders `./...` covers. */
function hasTests(root: string): boolean {
  return globSync("**/*_test.go", {
    cwd: root,
    ignore: ["**/vendor/**", "**/node_modules/**"],
    followSymbolicLinks: false,
  }).some((file) => {
    const dir = posix.dirname(file);
    return dir === "." || !hiddenFolder(dir);
  });
}

/**
 * go-race — the module's tests under the race detector (`go test -race`):
 * a data race in a worker or in shared state shows up only when two
 * goroutines touch the same memory, which no linter can see. It runs the
 * whole test suite and is 2-20x slower than `go test`, so it is in the
 * `deep` tier (the `ci` profile: pre-push and CI), where a module has tests;
 * `go test` caches a package whose code did not change, so a push that does
 * not touch Go reruns nothing. A race is an error at its first frame in the
 * module; a test that fails, panics or times out, a package that does not
 * build, and one that fails outside any test are reported too, since the
 * race detector checked nothing past them. Recorded on go 1.25.11:
 * docs/research/lint-toolchain/go-race.md.
 */
export const goRace: ToolAdapter = {
  id: "go-race",
  layer: "behavior",
  languages: ["go"],
  bin: "go",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  // test2json's build-output and FailedBuild events are from go 1.24.
  minVersion: "1.24.0",
  installHint: "https://go.dev/dl/ (the race detector ships with go)",
  versionArgs: ["version"],
  parseVersion: (out) => /go(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1],
  tier: "deep",
  timeoutMs: 900_000,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // A module under testdata/, _x/ or .x/ is a fixture: `./...` skips it.
    const rel = posix.relative(toPosix(env.projectRoot), toPosix(seed.cwd));
    if (rel !== "" && hiddenFolder(rel)) return [];
    return hasTests(seed.cwd) ? [seed] : [];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-?-(json|race|v)(=|$)/.test(arg))
      ? "-json, -race and -v are the kit's: it reads test2json's events"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      // The packages first: an `-args` in extraArgs takes the rest.
      args: ["test", "-race", "-json", "./...", ...ctx.extraArgs],
      // Linux builds the race detector only with cgo on (go-race.md).
      env: { CGO_ENABLED: "1" },
      okExitCodes: [0, 1],
      // A timeout stops the test binaries it started too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const module = modulePath(ctx.cwd);
    // The race report names real paths (/private/var/... on macOS), or
    // module paths under -trimpath.
    let real = cwd;
    try {
      real = toPosix(realpathSync(ctx.cwd));
    } catch {
      // The module path as given.
    }
    const own = (file: string): string | undefined => {
      const path = toPosix(file);
      for (const root of [real, cwd, module])
        if (root && path.startsWith(`${root}/`))
          return `${cwd}/${path.slice(root.length + 1)}`;
      return undefined;
    };
    /** A package's folder, relative: its import path below the module. */
    const folder = (pkg: string) =>
      module && pkg.startsWith(`${module}/`)
        ? pkg.slice(module.length + 1)
        : "";

    const events: Event[] = [];
    for (const line of raw.stdout.split("\n"))
      if (line.startsWith("{")) events.push(JSON.parse(line) as Event);

    const findings: Finding[] = [];
    /** Packages with a finding: their own `fail` needs no other. */
    const blamed = new Set<string>();
    const report = (
      file: string,
      line: number,
      col: number,
      ruleId: string,
      message: string,
      pkg: string,
    ) => {
      blamed.add(pkg);
      findings.push(
        finding({
          tool: "go-race",
          layer: "behavior",
          language: "go",
          file,
          line,
          col,
          ruleId,
          severity: "error",
          message,
          fixable: false,
        }),
      );
    };
    const goMod = absPosix(cwd, "go.mod");

    // Output lines per test (a package's own under its name alone), the
    // tests that finished, and each build's output.
    const lines = new Map<string, string[]>();
    const finished = new Set<string>();
    const failed: Event[] = [];
    const builds = new Map<string, string[]>();
    for (const e of events) {
      const at = key(e.Package ?? "", e.Test);
      if (e.Action === "output" && e.Output !== undefined) {
        const list = lines.get(at) ?? [];
        list.push(...e.Output.replace(/\n$/, "").split("\n"));
        lines.set(at, list);
      } else if (e.Action === "build-output" && e.ImportPath && e.Output) {
        const list = builds.get(e.ImportPath) ?? [];
        list.push(e.Output.replace(/\n$/, ""));
        builds.set(e.ImportPath, list);
      } else if (
        e.Action === "pass" ||
        e.Action === "fail" ||
        e.Action === "skip"
      ) {
        finished.add(at);
        if (e.Action === "fail") failed.push(e);
      }
    }
    // The first frame inside the module among `output`'s stack lines.
    const ownFrame = (output: readonly string[]) => {
      for (const line of output) {
        const frame = FRAME.exec(line);
        const file = frame?.[1] ? own(frame[1]) : undefined;
        if (file) return { file, line: Number(frame?.[2]) };
      }
      return undefined;
    };

    // Builds that failed: each error at its position, else the package's
    // first line of output at go.mod (a missing C compiler, an import cycle).
    for (const [importPath, output] of builds) {
      const pkg = importPath.split(" ")[0] ?? "";
      const vet = output.some((line) => line.startsWith("# ["));
      const errors = output.flatMap((line) => {
        const m = COMPILE.exec(line.trim());
        return m?.[1] && m[2] && m[3] && m[4] ? [m] : [];
      });
      for (const m of errors)
        report(
          absPosix(cwd, m[1] ?? ""),
          Number(m[2]),
          Number(m[3]),
          vet ? "vet-failed" : "build-failed",
          vet
            ? `go vet (run by go test) fails, so its tests did not run: ${m[4]}`
            : `does not compile, so its tests did not run: ${m[4]}`,
          pkg,
        );
      if (errors.length === 0) {
        const why = output.filter((line) => !line.startsWith("# ")).join("; ");
        report(
          goMod,
          1,
          1,
          "build-failed",
          `${pkg} did not build, so its tests did not run${why ? `: ${why}` : ""}`,
          pkg,
        );
      }
    }

    // The tests the race detector says raced, per package.
    const racy = new Map<string, Set<string>>();
    for (const [at, output] of lines) {
      const [pkg = "", test = ""] = at.split("\0");
      if (test && output.some((line) => line.includes(RACE_DETECTED)))
        racy.set(pkg, (racy.get(pkg) ?? new Set()).add(test));
    }
    const raced = new Set<string>();
    for (const [at, output] of lines) {
      const [pkg = "", test = ""] = at.split("\0");
      for (let i = 0; i < output.length; i++) {
        if (output[i] !== "WARNING: DATA RACE") continue;
        // Two accesses, each followed by its stack, then the stacks of the
        // goroutines that made them: those are not where an access was.
        const accesses: {
          what: string;
          file?: string;
          line?: number;
          /** Where it was, outside the module: `dep/file.go:11`. */
          ext?: string;
        }[] = [];
        let inAccess = false;
        /** The first frame in the module anywhere in the report. */
        let anyOwn: { file: string; line: number } | undefined;
        let j = i + 1;
        for (; j < output.length && output[j] !== "=================="; j++) {
          const text = output[j] ?? "";
          const access = ACCESS.exec(text);
          if (access?.[1]) {
            accesses.push({
              what: `${access[1].toLowerCase()} by ${access[2]}`,
            });
            inAccess = true;
            continue;
          }
          if (/^Goroutine \d+ /.test(text)) inAccess = false;
          const frame = ownFrame([text]);
          anyOwn ??= frame;
          const current = accesses.at(-1);
          if (!inAccess || !current || current.file !== undefined) continue;
          if (frame) Object.assign(current, frame);
          else if (current.ext === undefined) {
            const m = FRAME.exec(text);
            if (m?.[1])
              current.ext = `${m[1].split("/").slice(-2).join("/")}:${m[2]}`;
          }
        }
        i = j;
        // Where it happened, else where the module called into it.
        const place = accesses.find((a) => a.file) ?? anyOwn;
        if (!place?.file || accesses.length === 0) continue;
        // test2json files the report under the test that printed last; the
        // detector fails every test running then (t.Parallel): name them.
        const named = [...(racy.get(pkg) ?? [])].toSorted();
        const who = named.length > 0 ? named.join(", ") : test || pkg;
        for (const t of named.length > 0 ? named : [test])
          raced.add(key(pkg, t));
        const where = (a: (typeof accesses)[number]) =>
          a.file
            ? `${a.what} at ${a.file.slice(cwd.length + 1)}:${a.line}`
            : a.ext
              ? `${a.what} at ${a.ext}`
              : a.what;
        report(
          place.file,
          place.line ?? 1,
          1,
          "data-race",
          `data race in ${who}: ${accesses.map(where).join("; ")}`,
          pkg,
        );
      }
    }

    const failedKeys = new Set(failed.map((e) => key(e.Package ?? "", e.Test)));
    const testFailure = (
      pkg: string,
      test: string,
      rule: string,
      what: string,
    ) => {
      const output = lines.get(key(pkg, test)) ?? [];
      // The t.Error/Fatal line: the last one logged before `--- FAIL`, since
      // -json shows every t.Log too.
      const end = output.findIndex((line) => /^\s*--- FAIL/.test(line));
      const logged = (end < 0 ? output : output.slice(0, end))
        .map((line) => LOGGED.exec(line))
        .findLast((m) => m);
      const panic = output.find((line) => line.startsWith("panic: "));
      const frame = logged ? undefined : ownFrame(output);
      const dir = folder(pkg);
      report(
        logged?.[1]
          ? absPosix(cwd, dir ? `${dir}/${logged[1]}` : logged[1])
          : (frame?.file ?? goMod),
        logged?.[2] ? Number(logged[2]) : (frame?.line ?? 1),
        1,
        rule,
        `${test} ${what}${logged?.[3] ? `: ${logged[3]}` : panic ? `: ${panic}` : ""}`,
        pkg,
      );
    };
    for (const e of failed) {
      const pkg = e.Package ?? "";
      const at = key(pkg, e.Test);
      if (!e.Test || raced.has(at)) continue;
      // A parent fails with its subtest; a test the detector names fails
      // with its race: their own findings say it.
      if ([...failedKeys, ...raced].some((k) => k.startsWith(`${at}/`)))
        continue;
      testFailure(pkg, e.Test, "test-failed", "failed");
    }
    // A failed package: a test that never finished (a timeout, a crash),
    // else what it printed outside any test (TestMain's exit, init).
    for (const e of failed) {
      const pkg = e.Package ?? "";
      if (e.Test || e.FailedBuild || blamed.has(pkg)) continue;
      const unfinished = [...lines.keys()].filter((at) => {
        const [p = "", t = ""] = at.split("\0");
        return p === pkg && t !== "" && !finished.has(at);
      });
      for (const at of unfinished)
        testFailure(
          pkg,
          at.split("\0")[1] ?? "",
          "test-unfinished",
          "did not finish",
        );
      if (unfinished.length > 0) continue;
      const output = lines.get(key(pkg)) ?? [];
      const frame = ownFrame(output);
      // Go's own reason when it gave one (an unknown flag, a panic), else
      // the last thing it printed.
      const last =
        output.find((line) =>
          /^(flag provided but not defined|panic:)/.test(line.trim()),
        ) ??
        output.findLast(
          (line) =>
            line.trim() !== "" && !/^(FAIL|ok|PASS)\b/.test(line.trim()),
        );
      report(
        frame?.file ?? goMod,
        frame?.line ?? 1,
        1,
        "package-failed",
        `${pkg} failed outside any test${last ? `: ${last.trim()}` : " (TestMain's exit code?)"}`,
        pkg,
      );
    }

    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
