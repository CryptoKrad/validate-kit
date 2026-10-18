import { z } from "zod";
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
import { toolAdopted } from "../detect/adoption.js";
import {
  absPosix,
  finding,
  listedFiles,
  readResult,
  toolOptions,
} from "./base.js";

const Options = z
  .object({
    /** Google style (2-space indent, the default) or AOSP (4-space). */
    style: z.enum(["google", "aosp"]).optional(),
  })
  .strict();

interface GjfTask {
  aosp: boolean;
}

/** `src/Syn.java:2:11: error: illegal start of type` */
const SYNTAX = /^(\S.*?):(\d+):(\d+): error: (.+)$/;

/**
 * google-java-format — Java formatting to Google (or AOSP) style; its
 * formatting also removes unused imports and sorts them. It has no config
 * file, so it runs where the project chose it: `tools.google-java-format
 * .enabled` (`options.style`: "google" or "aosp") or a step that runs it.
 * Recorded on 1.37.0 (JDK 21+):
 * docs/research/lint-toolchain/sota-2026-10-18/c-zig-jvm.md, 5.
 */
export const googleJavaFormat: ToolAdapter = {
  id: "google-java-format",
  layer: "format",
  languages: ["java"],
  bin: "google-java-format",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.37.0",
  installHint: "brew install google-java-format",
  // The version goes to stderr.
  parseVersion: (out) => /Version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  masks: (f) => f.ruleId === "syntax-error",
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [],
      step: /(?:^|[\s;&|"'(/])google-java-format(?:\s|$)/m,
    }),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const { style } = toolOptions(env, "google-java-format", Options);
    const task: GjfTask = { aosp: style === "aosp" };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-?-(i|r|replace)$|^-$|^@/.test(arg))
      ? "the kit sets the files and when google-java-format rewrites them"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = ctx.files ?? [];
    if (files.length === 0)
      throw new Error("google-java-format needs the task's file list");
    return {
      bin: this.bin,
      args: [
        ...(ctx.fix ? ["--replace"] : ["--dry-run", "--set-exit-if-changed"]),
        ...((ctx.options as GjfTask).aosp ? ["--aosp"] : []),
        ...ctx.extraArgs,
        ...files,
      ],
      // 1: a file differs, does not parse or is missing; 2 is a usage error.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // It goes on to the other files, whose findings would hide this one.
    const unread = /^.*: could not read file: .*$/m.exec(raw.stderr)?.[0];
    if (unread)
      throw new Error(`google-java-format did not check a file: ${unread}`);
    const findings: Finding[] = [];
    for (const line of raw.stderr.split(/\r?\n/)) {
      const m = SYNTAX.exec(line);
      if (!m?.[1] || !m[2] || !m[3] || !m[4]) continue;
      findings.push(
        finding({
          tool: "google-java-format",
          layer: "format",
          language: "java",
          file: absPosix(ctx.cwd, m[1]),
          line: Number(m[2]),
          col: Number(m[3]),
          ruleId: "syntax-error",
          severity: "error",
          message: m[4],
          fixable: false,
        }),
      );
    }
    // --dry-run lists each file that would change.
    findings.push(
      ...listedFiles("google-java-format", raw, ctx, {
        files: /\.java$/,
        message:
          "File is not google-java-format-formatted (formatting also removes unused imports and sorts the rest)",
      }),
    );
    return readResult("google-java-format", raw, ctx, findings);
  },
};
