import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding, parseJsonLine } from "./base.js";
import {
  cargoEnv,
  cargoPlace,
  type CargoPlace,
  everyMember,
  RUSTUP_BIN,
} from "./cargo.js";
import { failureLine } from "./mutation.js";

/** One rustc JSON diagnostic, as `MIRIFLAGS=--error-format=json` prints it. */
interface Diagnostic {
  $message_type?: unknown;
  level?: unknown;
  message?: unknown;
  spans?: {
    file_name?: unknown;
    line_start?: unknown;
    column_start?: unknown;
    line_end?: unknown;
    column_end?: unknown;
    is_primary?: unknown;
  }[];
  children?: { message?: unknown }[];
}

/** A backtrace frame in a note: `    at src/lib.rs:3:14: 3:32`. */
const FRAME = /^\s*at (.+?):(\d+):(\d+)/gm;

// rustup's proxy: `+nightly` picks the toolchain the miri component is in,
// which a Homebrew or mise cargo first on PATH cannot (rust-go.md, 4).
const CARGO_MIRI = join(RUSTUP_BIN, "cargo-miri");

/**
 * Miri — the crate's tests in Rust's interpreter (`cargo +nightly miri
 * test`), which checks every memory access: a read past the end of an
 * allocation, a use after free, an unaligned or dangling pointer in
 * `unsafe` code, which a native test run passes by luck. Each one is an
 * error where it happened, naming the test, in unit, integration and doc
 * tests, every member at a workspace root. Opt-in (`tools.miri.enabled`),
 * the `deep` tier: Miri runs tests 10x or more slower than native, and the
 * build fetches dependencies not yet downloaded (the first run also builds
 * Miri's sysroot). A run that ran no test is a crash, not a pass (a test
 * filter that matches nothing exits 0). Recorded on nightly 1.101.0
 * (2026-10-09): docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 4.
 */
export const miri: ToolAdapter = {
  id: "miri",
  layer: "behavior",
  languages: ["rust"],
  bin: existsSync(CARGO_MIRI) ? CARGO_MIRI : "cargo-miri",
  versionArgs: ["+nightly", "miri", "--version"],
  parseVersion: (out) => /miri (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.1.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 900_000,
  installHint: "rustup +nightly component add miri rust-src",

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (env.toolConfig.enabled !== true) return [];
    const task: CargoPlace = cargoPlace(seed.cwd);
    return [{ ...seed, options: task }];
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      // cargo-miri itself, as `cargo +nightly miri test` runs it; every test
      // binary, not up to the first that fails.
      args: [
        "+nightly",
        "miri",
        "test",
        ...(ctx.extraArgs.includes("--no-fail-fast") ? [] : ["--no-fail-fast"]),
        ...everyMember(ctx),
        ...ctx.extraArgs,
      ],
      env: {
        ...cargoEnv(ctx),
        // The project's own Miri flags stay; the diagnostics become JSON.
        MIRIFLAGS: [process.env.MIRIFLAGS, "--error-format=json"]
          .filter(Boolean)
          .join(" "),
      },
      // 1: Miri stopped a test; 101: a test failed, or the build did.
      okExitCodes: [0, 1, 101],
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // rustc names files from the workspace root, whichever member runs.
    const cwd = (ctx.options as CargoPlace).workspaceRoot;
    const findings: Finding[] = [];
    // The JSON diagnostics are on stderr among cargo's text lines, and on
    // stdout for a doc test, whose stderr rustdoc prints there.
    for (const line of `${raw.stderr}\n${raw.stdout}`.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      const d = parseJsonLine<Diagnostic>("miri", line);
      if (
        d.$message_type !== "diagnostic" ||
        d.level !== "error" ||
        typeof d.message !== "string"
      )
        continue;
      const span = d.spans?.find((s) => s.is_primary === true);
      // "aborting due to 1 previous error" has no span.
      if (typeof span?.file_name !== "string") continue;
      const notes = (d.children ?? [])
        .map((c) => (typeof c.message === "string" ? c.message : ""))
        .join("\n");
      // In the standard library: the first frame of the backtrace in the crate.
      const own = (file: string) =>
        !isAbsolute(file) || isUnder(toPosix(file), cwd);
      const frame = own(span.file_name)
        ? undefined
        : [...notes.matchAll(FRAME)].find((m) => m[1] && own(m[1]));
      const thread = /this is on thread `([^`]+)`/.exec(notes)?.[1];
      findings.push(
        finding({
          tool: "miri",
          layer: "behavior",
          language: "rust",
          file: absPosix(cwd, frame?.[1] ?? span.file_name),
          line: Number(frame?.[2] ?? span.line_start),
          col: Number(frame?.[3] ?? span.column_start),
          ...(frame
            ? {}
            : {
                endLine: Number(span.line_end),
                endCol: Number(span.column_end),
              }),
          // "Undefined Behavior: ..." -> undefined-behavior
          ruleId: (d.message.split(":")[0] ?? "")
            .toLowerCase()
            .replace(/\s+/g, "-"),
          severity: "error",
          message: `${d.message}${thread && thread !== "main" ? ` (test ${thread})` : ""}`,
          fixable: false,
        }),
      );
    }
    if (findings.length === 0) {
      if (raw.exitCode !== 0)
        throw new Error(`miri failed: ${failureLine(raw, /^error/)}`);
      const ran = [...raw.stdout.matchAll(/^running (\d+) tests?$/gm)].reduce(
        (sum, m) => sum + Number(m[1]),
        0,
      );
      if (ran === 0)
        throw new Error(
          "miri ran no test (a test filter that matches nothing, or a crate without tests): it checked nothing",
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
