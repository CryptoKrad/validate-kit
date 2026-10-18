import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import type { Finding } from "../core/types.js";
import { isCode } from "../detect/languages.js";
import { finding, toolOptions } from "./base.js";
import { nativeCheck } from "./native.js";

const Options = z.object({ max: z.number().int().min(1).optional() }).strict();

/** Lines a source file may hold before it is one to split. */
const DEFAULT_MAX = 600;

/** Lines over the limit each finding stands for. */
const STEP = 100;

/**
 * file-length — source files longer than a limit (600 lines, or
 * `tools.file-length.options.max`): an agent appends to one file rather than
 * splitting a module. Only where the project turns it on
 * (`tools.file-length.enabled`). Each 100 lines over is a finding of its
 * own, so with the baseline a long file passes until it grows by another 100.
 */
export const fileLength = nativeCheck({
  id: "file-length",
  layer: "lint",
  select: (files, env) =>
    env.toolConfig.enabled === true ? files.filter((path) => isCode(path)) : [],
  plan: (_files, env) =>
    toolOptions(env, "file-length", Options).max ?? DEFAULT_MAX,
  check(root, task) {
    const max = task.extra as number;
    const findings: Finding[] = [];
    for (const path of task.files) {
      let lines: number;
      try {
        const text = readFileSync(posix.join(root, path), "utf8");
        lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      } catch {
        continue;
      }
      if (lines <= max) continue;
      // One finding per started 100 lines over: the baseline counts them, so
      // a long file it holds still fails when it grows another 100.
      for (let line = max + 1; line <= lines; line += STEP)
        findings.push(
          finding({
            tool: "file-length",
            layer: "lint",
            file: posix.join(root, path),
            line,
            col: 1,
            ruleId: "too-long",
            severity: "warning",
            message:
              line === max + 1
                ? `${lines} lines, over the ${max}-line limit: split it into modules by what each part does`
                : `and ${STEP} lines more past the ${max}-line limit`,
            fixable: false,
          }),
        );
    }
    return findings;
  },
});
