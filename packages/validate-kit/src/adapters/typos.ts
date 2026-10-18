import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
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
import { toPosix } from "../detect/languages.js";
import {
  absPosix,
  charColumn,
  finding,
  parseJsonLine,
  scratchOf,
} from "./base.js";

interface Typo {
  type?: unknown;
  path?: unknown;
  line_num?: unknown;
  byte_offset?: unknown;
  typo?: unknown;
  corrections?: unknown;
}

interface TyposTask {
  /** The files to read, relative to the project root (POSIX). */
  files: string[];
}

/**
 * Files that are not text: typos reads a file it is named as text, and a
 * PNG's bytes then read as misspelled words.
 */
const BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|tar|jar|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|wasm|so|dylib|dll|exe|bin|class|pyc|o|a)$/i;

/** typos' own config files (docs/reference.md). */
const CONFIGS = ["typos.toml", "_typos.toml", ".typos.toml"];

/** A typos table in a manifest it reads: pyproject.toml or Cargo.toml. */
function tableIn(root: string): boolean {
  const read = (name: string): string => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  return (
    /^\s*\[tool\.typos[.\]]/m.test(read("pyproject.toml")) ||
    /^\s*\[(?:package|workspace)\.metadata\.typos[.\]]/m.test(
      read("Cargo.toml"),
    )
  );
}

/**
 * typos — misspelled words in code (identifiers, strings, comments), file
 * names and docs, from a list of known misspellings, so it rarely flags a
 * word that is right. Never fixed by `--fix`: typos' own fixing renames a
 * misspelled file, and rewrites an identifier in the files it reads but not
 * in the ones that import it.
 * Where the project chose it: a typos config (or a `[tool.typos]` or
 * `[package.metadata.typos]` table), `tools.typos.enabled`, or a step that
 * runs it. Reads the kit's scope. Recorded on 1.51.1:
 * docs/research/lint-toolchain/hygiene-adapters.md.
 */
export const typos: ToolAdapter = {
  id: "typos",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "typos",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "1.20.0",
  installHint: "brew install typos-cli  (or: cargo install typos-cli)",
  parseVersion: (out) => /typos-cli (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [2],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const chosen =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      tableIn(root) ||
      toolAdopted(root, root, {
        configs: CONFIGS,
        step: /(?:^|[\s;&|"'(/])typos(?:\s|$)|\bcrate-ci\/typos@/m,
      });
    if (!chosen) return [];
    const top = toPosix(root);
    const changed = env.changedPaths && new Set(env.changedPaths.map(toPosix));
    const files = env.scopedFiles
      .map((file) => posix.relative(top, file))
      .filter((path) => !BINARY.test(path) && (!changed || changed.has(path)));
    if (files.length === 0) return [];
    const task: TyposTask = { files };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^--(format|file-list|write-changes|diff)(=|$)|^-w$/.test(arg),
    )
      ? "the kit sets the output, the files and when to write fixes"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const list = join(scratchOf(ctx), "files.txt");
    writeFileSync(list, `${(ctx.options as TyposTask).files.join("\n")}\n`);
    return {
      bin: this.bin,
      args: [
        "--format",
        "json",
        // A path the project's typos config excludes stays excluded when
        // named.
        "--force-exclude",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        "--file-list",
        list,
        ...ctx.extraArgs,
      ],
      // 2: typos found.
      okExitCodes: [0, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    const sources = new Map<string, string[] | undefined>();
    const linesOf = (file: string): string[] | undefined => {
      if (!sources.has(file))
        sources.set(
          file,
          existsSync(file) ? readFileSync(file, "utf8").split("\n") : undefined,
        );
      return sources.get(file);
    };
    for (const text of raw.stdout.split("\n")) {
      if (!text.trim().startsWith("{")) continue;
      const t = parseJsonLine<Typo>("typos", text.trim());
      if (t.type !== "typo") continue;
      if (
        typeof t.path !== "string" ||
        typeof t.typo !== "string" ||
        !Array.isArray(t.corrections)
      )
        throw new Error(
          "typos reported a typo without a path, word or corrections: its output format may have changed; refusing to report it.",
        );
      const file = absPosix(cwd, t.path);
      // A misspelled file name has no line.
      const line = typeof t.line_num === "number" ? t.line_num : 1;
      const byte = typeof t.byte_offset === "number" ? t.byte_offset : 0;
      const corrections = t.corrections.filter(
        (c): c is string => typeof c === "string",
      );
      findings.push(
        finding({
          tool: "typos",
          layer: "lint",
          file,
          line,
          col:
            typeof t.line_num === "number"
              ? charColumn(linesOf(file), line, byte)
              : 1,
          ruleId: "typo",
          severity: "warning",
          message: `\`${t.typo}\` should be ${corrections.map((c) => `\`${c}\``).join(" or ")}`,
          fixable: false,
        }),
      );
    }
    return {
      findings,
      filesProcessed: (ctx.options as TyposTask).files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
