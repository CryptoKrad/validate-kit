import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { delimiter, join, posix } from "node:path";
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
import { isUnder, toPosix } from "../detect/languages.js";
import {
  absPosix,
  escapeRegex,
  finding,
  findingsArray,
  scratchOf,
} from "./base.js";

interface Violation {
  error?: { code?: unknown; message?: unknown };
  module?: unknown;
  location?: { file?: unknown; line?: unknown; column?: unknown };
}

/** The project's `.venv` site-packages folders. */
function sitePackages(root: string): string[] {
  const venv = join(root, ".venv");
  const windows = join(venv, "Lib", "site-packages");
  if (existsSync(windows)) return [windows];
  try {
    return readdirSync(join(venv, "lib"))
      .filter((name) => name.startsWith("python"))
      .map((name) => join(venv, "lib", name, "site-packages"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

/**
 * deptry maps an import (`yaml`) to the package that provides it (`pyyaml`)
 * from the environment it runs in; without the project's packages it
 * guesses, and reports the import missing and the package unused. Only the
 * packages' metadata folders are made visible (linked into `scratch`), so a
 * project's version of a library deptry itself imports (click) cannot
 * replace deptry's.
 */
function metadataPath(root: string, scratch: string): string | undefined {
  const meta = join(scratch, "metadata");
  let linked = 0;
  for (const site of sitePackages(root)) {
    for (const name of readdirSync(site)) {
      if (!/\.(?:dist|egg)-info$/.test(name) || existsSync(join(meta, name)))
        continue;
      mkdirSync(meta, { recursive: true });
      symlinkSync(join(site, name), join(meta, name), "junction");
      linked += 1;
    }
  }
  return linked > 0 ? meta : undefined;
}

/**
 * The line of a manifest that declares `module`: a PEP 621 string
 * (`"rich>=13"`), a Poetry key (`rich = "^13"`) or a requirements line.
 */
function declaredAt(manifest: string, module: string): number {
  try {
    const lines = readFileSync(manifest, "utf8").split("\n");
    const name = module.toLowerCase().replace(/[-_.]+/g, "[-_.]");
    const declares = new RegExp(
      `["']${name}(?:[\\s\\[<>=!~;"']|$)|^\\s*["']?${name}["']?\\s*=(?!=)` +
        (manifest.endsWith(".txt") ? `|^\\s*${name}(?:[\\s\\[<>=!~;]|$)` : ""),
      "i",
    );
    const at = lines.findIndex((line) => declares.test(line));
    return at < 0 ? 1 : at + 1;
  } catch {
    return 1;
  }
}

/** Folders that hold a Python project of their own. */
const PY_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"];

interface DeptryTask {
  /** Nested Python projects (relative, POSIX): deptry leaves them to their own run. */
  nested: string[];
}

/**
 * deptry — Python imports against the dependencies a project declares: an
 * import nothing declares (it works here because something else installed
 * it, and fails in a clean environment), a declared package nothing imports,
 * a transitive one imported directly, a development one imported by the code.
 * From the project's `.venv` first, with its packages visible. Where the
 * project chose it: deptry in pyproject.toml, `tools.deptry.enabled`, or a
 * step that runs it. Recorded on 0.25.1:
 * docs/research/lint-toolchain/hygiene-adapters.md.
 */
export const deptry: ToolAdapter = {
  id: "deptry",
  layer: "lint",
  languages: ["python"],
  bin: "deptry",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  minVersion: "0.20.0",
  installHint: "uv add --dev deptry  (or: uv tool install deptry)",
  parseVersion: (out) => /deptry (\d+\.\d+\.\d+)/.exec(out)?.[1],
  findingExitCodes: [1],
  // A nested Python project is its own task: this one leaves its files out.
  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const cwd = toPosix(seed.cwd);
    const nested = new Set<string>();
    const isProject = new Map<string, boolean>();
    for (const file of env.scopedFiles) {
      if (!file.endsWith(".py") || !isUnder(file, cwd)) continue;
      let top: string | undefined;
      for (
        let dir = posix.dirname(file);
        dir !== cwd && isUnder(dir, cwd);
        dir = posix.dirname(dir)
      ) {
        if (!isProject.has(dir))
          isProject.set(
            dir,
            PY_MARKERS.some((m) => existsSync(join(dir, m))),
          );
        if (isProject.get(dir)) top = dir;
      }
      if (top) nested.add(posix.relative(cwd, top));
    }
    const task: DeptryTask = { nested: [...nested].toSorted() };
    return [{ ...seed, options: task }];
  },
  adoptedAt: (root, projectRoot) =>
    toolAdopted(root, projectRoot, {
      configs: [],
      dep: "deptry",
      pyproject: true,
      step: /(?:^|[\s;&|"'(/])deptry(?:\s|$)/m,
    }),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(-o|--json-output)(=|$)/.test(arg))
      ? "--json-output is the report the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const scratch = scratchOf(ctx);
    const meta = metadataPath(ctx.cwd, scratch);
    const nested = (ctx.options as DeptryTask | undefined)?.nested ?? [];
    return {
      bin: this.bin,
      args: [
        ".",
        "--json-output",
        join(scratch, "deptry.json"),
        "--no-ansi",
        ...nested.flatMap((dir) => [
          "--extend-exclude",
          `${escapeRegex(dir)}(/|$)`,
        ]),
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      ...(meta
        ? {
            env: {
              PYTHONPATH: [meta, process.env.PYTHONPATH]
                .filter(Boolean)
                .join(delimiter),
            },
          }
        : {}),
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const report = join(scratchOf(ctx), "deptry.json");
    if (!existsSync(report))
      throw new Error(
        `deptry wrote no report (exit ${raw.exitCode}): ${`${raw.stderr}\n${raw.stdout}`.trim().split("\n").at(-1) ?? ""}`,
      );
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    for (const v of findingsArray<Violation>(
      "deptry",
      JSON.parse(readFileSync(report, "utf8")),
    )) {
      const code = v.error?.code;
      const message = v.error?.message;
      const path = v.location?.file;
      if (
        typeof code !== "string" ||
        typeof message !== "string" ||
        typeof path !== "string"
      )
        throw new Error(
          "deptry reported a violation without a code, message or file: its output format may have changed; refusing to report it.",
        );
      const file = absPosix(cwd, path);
      // A declared package has no line in the report: the manifest's.
      const line =
        typeof v.location?.line === "number"
          ? v.location.line
          : typeof v.module === "string"
            ? declaredAt(file, v.module)
            : 1;
      findings.push(
        finding({
          tool: "deptry",
          layer: "lint",
          language: "python",
          file,
          line,
          col: typeof v.location?.column === "number" ? v.location.column : 1,
          ruleId: code,
          // DEP001: an import nothing declares fails in a clean install.
          severity: code === "DEP001" ? "error" : "warning",
          message,
          fixable: false,
        }),
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
