import { readFileSync } from "node:fs";
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
import { absPosix, finding, lineOf } from "./base.js";
import { formatChanged } from "./mutation.js";

/** One JUnit suite: its name is the issue class, each testcase one issue. */
const SUITE =
  /<testsuite name="([^"]+)" failures="(\d+)">([\s\S]*?)<\/testsuite>/g;
const CASE =
  /<testcase name="([^"]+)">\s*(?:<failure>([^<]*)<\/failure>\s*)?<\/testcase>/g;

/** The issue classes it reports, as the suite names spell them. */
const RULES: Record<
  string,
  { ruleId: string; message: (name: string) => string; onManifest: boolean }
> = {
  "unknown classes": {
    ruleId: "unknown-class",
    message: (name) =>
      `\`${name}\` cannot be autoloaded: the package that provides it is not required (or the class is misspelled)`,
    onManifest: false,
  },
  "unknown functions": {
    ruleId: "unknown-function",
    message: (name) => `\`${name}()\` is not defined by any required package`,
    onManifest: false,
  },
  "shadow dependencies": {
    ruleId: "shadow-dependency",
    message: (name) =>
      `\`${name}\` is used but not required in composer.json (it comes in through another package)`,
    onManifest: true,
  },
  "dev dependencies in production code": {
    ruleId: "dev-dependency-in-production",
    message: (name) =>
      `\`${name}\` is a require-dev package the production code uses`,
    onManifest: true,
  },
  "prod dependencies used only in dev paths": {
    ruleId: "prod-dependency-only-in-dev",
    message: (name) =>
      `\`${name}\` is required but used only by development code`,
    onManifest: true,
  },
  "unused dependencies": {
    ruleId: "unused-dependency",
    message: (name) =>
      `\`${name}\` is required in composer.json and nothing uses it`,
    onManifest: true,
  },
};

/** The line of composer.json that names `pkg`. */
function declaredAt(manifest: string, pkg: string): number {
  try {
    return lineOf(
      readFileSync(manifest, "utf8"),
      new RegExp(`"${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\s*:`),
    );
  } catch {
    return 1;
  }
}

/**
 * composer-dependency-analyser — a PHP project's `use` statements against
 * its composer.json: a class from a package never required (it autoloads
 * here through another package and breaks when that one changes), a
 * required package nothing uses, a require-dev package in production code.
 * phpstan does not read composer.json. Where a composer.json is and the
 * project chose it: the analyser in require-dev, its config file,
 * `tools.composer-dependency-analyser.enabled`, or a step. One task per
 * Composer root, the project's own vendor/bin copy found first;
 * the JUnit output is read (its console form is coloured prose). Recorded
 * on 1.8.4: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const composerDependencyAnalyser: ToolAdapter = {
  id: "composer-dependency-analyser",
  layer: "lint",
  languages: ["php"],
  bin: "composer-dependency-analyser",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "1.5.0",
  installHint: "composer require --dev shipmonk/composer-dependency-analyser",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  composerVendor: true,
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: ["composer-dependency-analyser.php"],
      composer: "shipmonk/composer-dependency-analyser",
      step: /(?:^|[\s;&|"'(/])composer-dependency-analyser(?:\s|$)/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(?:format|verbose|dump-usages)(=|$)/.test(arg))
      ? "--format is the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "--format",
        "junit",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      // 1: issues found (a usage error too, with no XML).
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    if (!raw.stdout.includes("<testsuites")) {
      if (raw.exitCode === 0 && raw.stdout.trim() === "")
        return {
          findings: [],
          filesProcessed: 0,
          fixesApplied: 0,
          rawExitCode: raw.exitCode,
          stderr: raw.stderr,
        };
      throw raw.stderr.trim()
        ? new Error(
            `composer-dependency-analyser: ${raw.stderr.trim().split("\n")[0]}`,
          )
        : formatChanged(
            "composer-dependency-analyser",
            "printed no JUnit document",
          );
    }
    const manifest = absPosix(cwd, "composer.json");
    const findings: Finding[] = [];
    let suites = 0;
    for (const suite of raw.stdout.matchAll(SUITE)) {
      suites += 1;
      const [, name = "", , body = ""] = suite;
      const rule = RULES[name];
      for (const item of body.matchAll(CASE)) {
        const [, subject = "", where = ""] = item;
        // `src/Config.php:12` for a class or function; nothing for a package.
        const at = /^(.*):(\d+)$/.exec(where);
        const file = at ? absPosix(cwd, at[1] ?? "") : manifest;
        findings.push(
          finding({
            tool: "composer-dependency-analyser",
            layer: "lint",
            language: "php",
            file,
            line: at
              ? Number(at[2])
              : rule?.onManifest
                ? declaredAt(manifest, subject)
                : 1,
            col: 1,
            ruleId: rule?.ruleId ?? name.replace(/\s+/g, "-"),
            severity: "error",
            message: rule ? rule.message(subject) : `${name}: ${subject}`,
            fixable: false,
          }),
        );
      }
    }
    if (raw.exitCode === 1 && suites === 0)
      throw formatChanged(
        "composer-dependency-analyser",
        "exited 1 with no testsuite in its JUnit",
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
