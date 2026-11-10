import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";
import { formatChanged } from "./mutation.js";

/** `[ERROR] /abs/App.java:[13,17] error: [CollectionIncompatibleType] message` */
const DIAGNOSTIC =
  /^\[(ERROR|WARNING)\] (.+?\.java):\[(\d+),(\d+)\] (?:error|warning): \[(\w+)\] (.*)$/;

/** Maven's own summary of a failed compile, for the error message. */
const FAILED = /^\[ERROR\] Failed to execute goal .*$/m;

/** `[ERROR]` lines that say nothing about what went wrong. */
const NO_CAUSE =
  /^(?:BUILD FAILURE$|-> \[Help|\[Help \d|To see the full stack trace|Re-run Maven|For more information)/;
/**
 * What Maven said of a build that never reached a goal (a plugin it could not
 * fetch, a pom it could not read): the first two `[ERROR]` lines with a cause.
 * Recorded: assets/sota-2026-11-03/error-prone/unresolved-plugin.stdout.
 */
function buildError(stdout: string): string | undefined {
  const said = stdout.split("\n").flatMap((line) => {
    const text = /^\[ERROR\]\s+(\S.*)$/.exec(line)?.[1]?.trim();
    return text && !NO_CAUSE.test(text) ? [text] : [];
  });
  return said.length > 0 ? said.slice(0, 2).join(" ") : undefined;
}

/** The pom declares Error Prone (its core as an annotation processor path). */
function errorProneIn(root: string): boolean {
  try {
    return /error_prone_core|errorprone/.test(
      readFileSync(join(root, "pom.xml"), "utf8"),
    );
  } catch {
    return false;
  }
}

/**
 * Error Prone (and NullAway where the pom adds it) — bug patterns javac
 * accepts: a collection asked about a value of the wrong type, a return
 * value dropped, a null flowing into a dereference. It is a javac plugin,
 * so the adapter runs the project's own Maven compile and reads javac's
 * diagnostics; the pom decides the checks and which are errors. Where a
 * pom.xml declares Error Prone, one task per Maven root, the `verify` tier
 * (a compile; Maven may download plugins). A compile that fails with no
 * Error Prone diagnostic is the build's own failure, reported as such.
 * Maven only; Gradle projects wait for a consumer. Recorded on Error Prone
 * 2.52.0, NullAway 0.14.3, Maven 3.10.0, JDK 21:
 * docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const errorProne: ToolAdapter = {
  id: "error-prone",
  layer: "lint",
  languages: ["java"],
  bin: "mvn",
  versionArgs: ["-v"],
  parseVersion: (out) => /Apache Maven (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "3.6.0",
  installHint:
    "brew install maven  (Error Prone itself is declared in the project's pom.xml)",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "verify",
  timeoutMs: 600_000,
  adoptedAt: (root, projectRoot) =>
    errorProneIn(root) ||
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /(?:^|[\s;&|"'(/])-Xplugin:ErrorProne\b/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(?:-q|--quiet|-o|--offline)$/.test(arg))
      ? "-q hides the diagnostics the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      // -B: no colour, no progress; compile stops at the first module with an
      // error, which is where Error Prone reported.
      args: ["-B", "compile", ...ctx.extraArgs],
      // 1: a compile error (Error Prone's, or the build's own).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const line of raw.stdout.split(/\r?\n/)) {
      const m = DIAGNOSTIC.exec(line);
      if (!m) continue;
      // Maven prints each diagnostic twice: as it happens, then in its summary.
      if (seen.has(line)) continue;
      seen.add(line);
      const [
        ,
        level = "ERROR",
        file = "",
        row = "1",
        col = "1",
        rule = "",
        message = "",
      ] = m;
      findings.push(
        finding({
          tool: "error-prone",
          layer: "lint",
          language: "java",
          file: absPosix(cwd, file),
          line: Number(row),
          col: Number(col),
          ruleId: rule,
          severity: level === "WARNING" ? "warning" : "error",
          message,
          fixable: false,
          url: `https://errorprone.info/bugpattern/${rule}`,
        }),
      );
    }
    if (raw.exitCode !== 0 && findings.length === 0) {
      const why =
        FAILED.exec(raw.stdout)?.[0] ??
        buildError(raw.stdout) ??
        raw.stderr.trim().split("\n")[0];
      throw why
        ? new Error(
            `mvn compile failed without an Error Prone diagnostic: ${why}`,
          )
        : formatChanged(
            "error-prone",
            "mvn exited non-zero with no diagnostic and no summary",
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
