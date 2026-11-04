import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import {
  finding,
  findingsArray,
  parseJsonOutput,
  toolOptions,
} from "./base.js";
import { formatChanged } from "./mutation.js";

/** Spectral's ruleset names, as its lookup spells them (`.?spectral.(js|ya?ml|json)`). */
const RULESETS = [
  ".spectral.yaml",
  ".spectral.yml",
  ".spectral.json",
  ".spectral.js",
  "spectral.yaml",
  "spectral.yml",
  "spectral.json",
  "spectral.js",
];

/** An API description's top-level key, within its first bytes. */
// The key alone, quoted or bare: a package.json script named `openapi:emit` is not one.
const API_DOC =
  /^\s*(?:"(?:openapi|swagger|asyncapi)"|(?:openapi|swagger|asyncapi))\s*:/m;
const DOC_EXT = /\.(?:ya?ml|json)$/;

interface Item {
  code?: unknown;
  message?: unknown;
  severity?: unknown;
  source?: unknown;
  range?: {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
}

const Options = z
  .object({
    /**
     * The API descriptions to lint, relative to the project root. Named when
     * they are JSON (JSON is not a scoped language, so the kit cannot find
     * them) or when the scan would take the wrong files.
     */
    documents: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** 0 error, 1 warn, 2 info, 3 hint (spectral's DiagnosticSeverity). */
const SEVERITY: Record<number, Severity> = {
  0: "error",
  1: "warning",
  2: "info",
  3: "info",
};

/** The file's first 4 KiB, or nothing. */
function head(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * The API descriptions to lint, relative to the root (POSIX): the ones
 * `tools.spectral.options.documents` names, else the specs `apiDiff` names,
 * else every scoped YAML or JSON file that opens with an `openapi`,
 * `swagger` or `asyncapi` key.
 */
function documentsOf(env: PlanEnv): string[] {
  const root = env.projectRoot;
  const named = toolOptions(env, "spectral", Options).documents;
  if (named && named.length > 0) return named.map(toPosix).toSorted();
  if (env.config.apiDiff.specs.length > 0)
    return env.config.apiDiff.specs.map(toPosix).toSorted();
  const top = toPosix(root);
  return env.scopedFiles
    .map((file) =>
      isAbsolute(file) ? toPosix(file) : toPosix(join(root, file)),
    )
    .filter((file) => DOC_EXT.test(file) && API_DOC.test(head(file)))
    .map((file) => file.slice(top.length + 1))
    .toSorted();
}

/**
 * spectral — an OpenAPI or AsyncAPI description against a ruleset: an
 * operation with no operationId, a response with no description, an unused
 * component, a `servers` list left out. oasdiff compares two versions of a
 * spec; this judges one on its own. It lints nothing without a ruleset, so
 * it runs where the project has one (`.spectral.yaml` and the other names
 * spectral looks up, or `tools.spectral.configPath`). The documents are the
 * specs `apiDiff.specs` names, else the scoped YAML and JSON files that
 * open with an API key. Its exit code only says whether `--fail-severity`
 * was reached: the findings are read from the JSON on exit 0 and 1.
 * Recorded on 6.17.0: docs/research/lint-toolchain/sota-2026-11-03/recorded.md.
 */
export const spectral: ToolAdapter = {
  id: "spectral",
  layer: "lint",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "spectral",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "6.0.0",
  installHint: "pnpm add -D -w @stoplight/spectral-cli",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  configFiles: RULESETS,
  findingExitCodes: [1],

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const root = env.projectRoot;
    const ruleset =
      env.toolConfig.configPath !== undefined ||
      RULESETS.some((name) => existsSync(join(root, name)));
    if (!ruleset) {
      // Chosen by hand and nothing to lint with: say so rather than skip.
      return env.toolConfig.enabled === true
        ? [
            {
              ...seed,
              cannotRun:
                'spectral lints nothing without a ruleset: add a .spectral.yaml (`extends: ["spectral:oas"]` to start) or tools.spectral.configPath',
            },
          ]
        : [];
    }
    let files = documentsOf(env);
    if (env.changedPaths) {
      const changed = new Set(env.changedPaths.map(toPosix));
      files = files.filter((file) => changed.has(file));
    }
    return files.length === 0 ? [] : [{ ...seed, files }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-f|--format|-o|--output|-r|--ruleset|-q|--quiet)(=|$)/.test(arg),
    )
      ? "-f, -o, -q and --ruleset are the kit's"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "lint",
        "-f",
        "json",
        "-q",
        ...(ctx.configPath ? ["--ruleset", ctx.configPath] : []),
        ...ctx.extraArgs,
        ...(ctx.files ?? []),
      ],
      // 1: the fail severity was reached (a usage error too, with no JSON);
      // 2: no ruleset or no file.
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const items = findingsArray<Item>(
      "spectral",
      parseJsonOutput<unknown>("spectral", raw, []),
    );
    if (raw.exitCode === 1 && items.length === 0)
      throw formatChanged("spectral", "exited 1 with no finding in its JSON");
    const findings: Finding[] = items.map((item) => {
      const start = item.range?.start;
      if (
        typeof item.code !== "string" ||
        typeof item.message !== "string" ||
        typeof item.source !== "string" ||
        typeof start?.line !== "number" ||
        typeof start.character !== "number"
      )
        throw formatChanged(
          "spectral",
          "reported a finding without a code, message, source or range",
        );
      const end = item.range?.end;
      return finding({
        tool: "spectral",
        layer: "lint",
        file: toPosix(item.source),
        line: start.line + 1,
        col: start.character + 1,
        ...(typeof end?.line === "number" && typeof end.character === "number"
          ? { endLine: end.line + 1, endCol: end.character + 1 }
          : {}),
        ruleId: item.code,
        severity:
          (typeof item.severity === "number"
            ? SEVERITY[item.severity]
            : undefined) ?? "warning",
        message: item.message,
        fixable: false,
      });
    });
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
