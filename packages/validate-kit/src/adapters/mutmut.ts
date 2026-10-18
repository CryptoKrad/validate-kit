import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveBin } from "../core/exec.js";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { scratchOf } from "./base.js";
import {
  excerpt,
  failureLine,
  formatChanged,
  type MutantKind,
  type MutationTask,
  MUTATION_TOOL,
  mutantFinding,
  mutationResult,
  planMutation,
  scopedFile,
} from "./mutation.js";

/** mutmut's result codes per mutant (mutmut 3.8.0 `stats.py`). */
const KINDS = new Map<unknown, MutantKind>([
  [0, "survived"],
  [5, "no-coverage"],
  [33, "no-coverage"],
]);

/** Folders a copy of the project leaves out, outside a git work tree. */
const NOT_COPIED = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "mutants",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
]);

/** Every file under `root` outside the folders a copy leaves out. */
function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!NOT_COPIED.has(entry.name)) walk(path);
      } else files.push(path);
    }
  };
  walk("");
  return files;
}

/**
 * The files of the project: what git tracks or would, else (outside a work
 * tree, or in a folder the enclosing repository ignores) a walk.
 */
function projectFiles(root: string): string[] {
  let listed: string[] = [];
  try {
    listed = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 },
    )
      .split("\0")
      .filter((path) => path !== "" && !path.startsWith("mutants/"));
  } catch {
    /* not a git work tree */
  }
  return listed.length > 0 ? listed : walkFiles(root);
}

/**
 * Copy the project's files to `to`: a clone where the file system can, a
 * symlink as a link to what it points at, a submodule as its folder.
 */
function copyProject(from: string, to: string): void {
  const made = new Set<string>();
  for (const path of projectFiles(from)) {
    const source = join(from, path);
    const target = join(to, path);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue; // tracked but deleted in the work tree: not checked
    }
    const dir = dirname(target);
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    if (stat.isSymbolicLink()) {
      if (existsSync(source)) symlinkSync(realpathSync(source), target);
    } else if (stat.isDirectory()) cpSync(source, target, { recursive: true });
    else copyFileSync(source, target, constants.COPYFILE_FICLONE);
  }
}

/** mutmut's own config: `[tool.mutmut]` in pyproject.toml, `[mutmut]` in setup.cfg. */
function configured(root: string): boolean {
  const read = (name: string): string => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  return (
    /^\s*\[tool\.mutmut\]/m.test(read("pyproject.toml")) ||
    /^\s*\[mutmut\]/m.test(read("setup.cfg"))
  );
}

/**
 * Glob patterns for the mutants of a changed file. mutmut names a mutant
 * `<module>.x_<function>__mutmut_<n>` (a method: `<module>.xǁ<Class>ǁ…`),
 * the module named from the path without its source folder, which the
 * project's config decides: every tail of the dotted path is a candidate.
 */
function mutantGlobs(path: string): string[] {
  const parts = path
    .replace(/\.py$/, "")
    .replace(/(?:^|\/)__init__$/, "")
    .split("/")
    .filter(Boolean);
  return parts.map((_, i) => `${parts.slice(i).join(".")}.x*`);
}

/** Leading whitespace of a line. */
const indent = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;

/**
 * Where the mutants of one file are in it. mutmut writes each mutant as a
 * copy of its function in `mutants/<path>` (`.spans` holds their lines), next
 * to the unmutated copy `…__mutmut_orig`: the first line where they differ,
 * found again in the original file, is the mutated line. Undefined for a
 * mutant it cannot place.
 */
function locator(
  copy: string,
  path: string,
  original: string[],
): (
  name: string,
) => { line: number; col: number; mutation: string } | undefined {
  let spans: Record<string, [number, number]> | undefined;
  let generated: string[] = [];
  try {
    spans = (
      JSON.parse(
        readFileSync(join(copy, "mutants", `${path}.spans`), "utf8"),
      ) as { spans?: Record<string, [number, number]> }
    ).spans;
    generated = readFileSync(join(copy, "mutants", path), "utf8").split("\n");
  } catch {
    return () => undefined;
  }
  const trimmed = original.map((line) => line.trim());
  return (name) => {
    const base = name.replace(/__mutmut_\d+$/, "");
    // The function's own name: x_<function>, or xǁ<Class>ǁ<method>.
    const real = base.startsWith("x_")
      ? base.slice(2)
      : base.slice(base.lastIndexOf("ǁ") + 1);
    const body = (key: string): string[] | undefined => {
      const span = spans?.[key];
      if (!span) return undefined;
      const lines = generated
        .slice(span[0] - 1, span[1])
        .map((line) =>
          line.replace(/\bx[_ǁ][\wǁ]*__mutmut_(?:orig|\d+)/g, real),
        );
      while (lines[0]?.trim() === "") lines.shift();
      while (lines.at(-1)?.trim() === "") lines.pop();
      return lines;
    };
    const orig = body(`${base}__mutmut_orig`);
    const mutant = body(name);
    if (!orig || !mutant) return undefined;
    const at = orig.findIndex((line, i) => line !== mutant[i]);
    if (at < 0) return undefined;
    const before = orig[at] ?? "";
    const after = mutant[at] ?? "";
    let col = 0;
    while (col < before.length && before[col] === after[col]) col += 1;
    // The same function in the original file: every line, in order.
    const start = trimmed.findIndex((_, k) =>
      orig.every((line, j) => trimmed[k + j] === line.trim()),
    );
    if (start < 0) return undefined;
    const line = start + at;
    return {
      line: line + 1,
      col: col + 1 + indent(original[line] ?? "") - indent(before),
      mutation: `${excerpt(before)} → ${excerpt(after)}`,
    };
  };
}

/**
 * mutmut — mutation testing for Python. It must run in the project's own
 * environment (it imports the tests and the code), so the kit takes it from
 * the project's `.venv` first, and it writes its `mutants/` folder where it
 * runs, so the kit runs it in a copy of the project. Where `[tool.mutmut]` or
 * `[mutmut]` is configured (or `tools.mutmut.enabled`), the `deep` tier.
 * Recorded on 3.8.0: docs/research/lint-toolchain/mutation-testing/mutmut-full.md.
 */
export const mutmut: ToolAdapter = {
  id: "mutmut",
  layer: "mutation",
  ...MUTATION_TOOL,
  languages: ["python"],
  bin: "mutmut",
  minVersion: "3.0.0",
  parseVersion: (out) => /mutmut, version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  rootedAtMarker: true,
  pythonEnv: true,
  installHint:
    "uv add --dev mutmut  (in the project's environment: it imports the tests; not on Windows)",
  // mutmut reads its config from the folder it runs in only.
  adoptedAt: (root) => configured(root),
  expand: (seed, env) => planMutation(seed, env, ["python"]),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(apply|browse|results|show)$/.test(arg))
      ? "the kit runs `mutmut run` and reads its results itself"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const copy = scratchOf(ctx);
    copyProject(ctx.cwd, copy);
    // mutmut reads only the folder it runs in: a config named elsewhere
    // takes the place of the project's.
    if (ctx.configPath)
      copyFileSync(
        ctx.configPath,
        join(
          copy,
          ctx.configPath.endsWith("setup.cfg") ? "setup.cfg" : "pyproject.toml",
        ),
      );
    const task = ctx.options as MutationTask;
    return {
      // The project's mutmut, found from the project, not from the copy; a
      // configured one (tools.mutmut.bin: the planner's object over this one)
      // on PATH only.
      bin: resolveBin(this.bin, ctx.cwd, process.env, this !== mutmut, true),
      args: [
        "run",
        ...(task.targets ?? []).flatMap(mutantGlobs),
        ...ctx.extraArgs,
      ],
      cwd: copy,
      // 1: it could not run (failing tests, no tests, a bad config), or a
      // changed file has no mutant to match; said below.
      okExitCodes: [0, 1],
      // A timeout stops the test processes it forked too.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 1) {
      // The changed files hold no function mutmut mutates.
      if (
        (ctx.options as MutationTask).targets &&
        /Filtered for specific mutants, but nothing matches/.test(
          raw.stdout + raw.stderr,
        )
      )
        return mutationResult(raw, ctx, []);
      throw new Error(`mutmut could not run (exit 1): ${failureLine(raw)}`);
    }
    const copy = scratchOf(ctx);
    const mutants = join(copy, "mutants");
    const metas = existsSync(mutants)
      ? readdirSync(mutants, { recursive: true, encoding: "utf8" })
          .map(toPosix)
          .filter((path) => path.endsWith(".meta"))
      : [];
    if (metas.length === 0)
      throw formatChanged("mutmut", "wrote no mutants/*.meta results");
    const inScope = scopedFile(ctx);
    const findings: Finding[] = [];
    for (const meta of metas) {
      const path = meta.slice(0, -".meta".length);
      const file = inScope(path);
      if (!file) continue;
      const codes = (
        JSON.parse(readFileSync(join(mutants, meta), "utf8")) as {
          exit_code_by_key?: unknown;
        }
      ).exit_code_by_key;
      if (typeof codes !== "object" || codes === null)
        throw formatChanged("mutmut", `wrote ${meta} without exit_code_by_key`);
      const locate = locator(
        copy,
        path,
        readFileSync(join(ctx.cwd, path), "utf8").split("\n"),
      );
      for (const [key, code] of Object.entries(codes)) {
        const kind = KINDS.get(code);
        if (!kind) continue;
        const at = locate(key.slice(key.lastIndexOf(".") + 1));
        findings.push(
          mutantFinding({
            tool: "mutmut",
            language: "python",
            file,
            line: at?.line ?? 1,
            col: at?.col ?? 1,
            kind,
            mutation: at ? `${at.mutation} (${key})` : key,
          }),
        );
      }
    }
    return mutationResult(raw, ctx, findings);
  },
};
