import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

/**
 * Has the repository adopted a formatter? A formatter the repository never
 * configured would flag every file on its defaults (the operator's decision
 * R11, 2026-10-04). The signals, and why each one counts:
 * docs/research/formatters/adoption-signals.md.
 */

/** Prettier's own config names (prettier 3.9.9 `CONFIG_FILES`). */
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];

const GOLANGCI_CONFIGS = [
  ".golangci.yml",
  ".golangci.yaml",
  ".golangci.toml",
  ".golangci.json",
];

/** `root` and each folder above it, up to and including `top`. */
export function upTo(root: string, top: string): string[] {
  const dirs = [resolve(root)];
  const stop = resolve(top);
  let dir = dirs[0] as string;
  while (dir !== stop && !relative(stop, dir).startsWith("..")) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dirs.push(parent);
    dir = parent;
  }
  return dirs;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The text without comment lines (`#` and `//`), for word matches. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

/** Task and CI files at the top whose steps may run a formatter. */
function stepFiles(top: string): string[] {
  const named = [
    "Makefile",
    "makefile",
    "GNUmakefile",
    "justfile",
    "Justfile",
    "lefthook.yml",
    "lefthook.yaml",
    ".pre-commit-config.yaml",
    ".pre-commit-config.yml",
  ].map((name) => join(top, name));
  let workflows: string[] = [];
  try {
    workflows = readdirSync(join(top, ".github", "workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(top, ".github", "workflows", name));
  } catch {
    /* no workflows */
  }
  return [...named, ...workflows];
}

function stepsMention(top: string, word: RegExp): boolean {
  return stepFiles(top).some((file) => {
    const text = read(file);
    return text !== undefined && word.test(code(text));
  });
}

/**
 * A Prettier config at or above `root` (package.json only with a `prettier`
 * key), `prettier` in a package.json's dependencies, or a `.prettierignore`.
 */
export function prettierAdopted(root: string, top: string): boolean {
  if (existsSync(join(top, ".prettierignore"))) return true;
  return upTo(root, top).some((dir) => {
    if (PRETTIER_CONFIGS.some((name) => existsSync(join(dir, name))))
      return true;
    return ["package.json", "package.yaml"].some((name) => {
      const manifest = read(join(dir, name));
      if (manifest === undefined) return false;
      try {
        const pkg = (
          name === "package.json" ? JSON.parse(manifest) : parseYaml(manifest)
        ) as Record<string, unknown> | null;
        if (pkg === null || typeof pkg !== "object") return false;
        const deps = (key: string) => Object.hasOwn(pkg[key] ?? {}, "prettier");
        return (
          Object.hasOwn(pkg, "prettier") ||
          deps("dependencies") ||
          deps("devDependencies")
        );
      } catch {
        return false;
      }
    });
  });
}

/**
 * A tool the kit runs only where the repository chose it: one of its config
 * files at or above `root`, the npm package `dep` in a package.json's
 * dependencies (or a `key` of its own there), `dep` in a pyproject.toml when
 * it is a Python package too, or a task or CI step that runs `step`.
 */
export function toolAdopted(
  root: string,
  top: string,
  {
    configs,
    dep,
    key,
    step,
    pyproject = false,
  }: {
    configs: readonly string[];
    dep?: string;
    key?: string;
    step?: RegExp;
    /** `dep` is also a Python package, named in a pyproject.toml. */
    pyproject?: boolean;
  },
): boolean {
  if (step && stepsMention(top, step)) return true;
  return upTo(root, top).some((dir) => {
    if (configs.some((name) => existsSync(join(dir, name)))) return true;
    if (dep === undefined && key === undefined) return false;
    const python = pyproject ? read(join(dir, "pyproject.toml")) : undefined;
    if (dep && python !== undefined && code(python).includes(dep)) return true;
    const manifest = read(join(dir, "package.json"));
    if (manifest === undefined) return false;
    try {
      const pkg = JSON.parse(manifest) as Record<string, unknown> | null;
      if (pkg === null || typeof pkg !== "object") return false;
      const deps = (field: string) =>
        dep !== undefined && Object.hasOwn(pkg[field] ?? {}, dep);
      return (
        (key !== undefined && Object.hasOwn(pkg, key)) ||
        deps("dependencies") ||
        deps("devDependencies")
      );
    } catch {
      return false;
    }
  });
}

/** Biome's config names, in the order it reads them (biome-cli.md, 5). */
const BIOME_CONFIGS = [
  "biome.json",
  "biome.jsonc",
  ".biome.json",
  ".biome.jsonc",
];

/**
 * The repository's top above `top` (the first folder up holding `.git`), or
 * `top` outside one: how far up a config of the repository may be.
 */
function repositoryTopOf(top: string): string {
  const dirs = upTo(top, "/");
  return dirs.find((dir) => existsSync(join(dir, ".git"))) ?? top;
}

/**
 * Where Biome runs for each file, with one look per folder however many
 * files share it: the folder of the file's root config (the first one up
 * that is not nested, `"root": false` or `"extends": "//"`), since Biome
 * spawned above its root config finds it as a second root and fails; the
 * project root when that config is above the project (in the repository);
 * for a file only nested configs reach, the highest of them, from where
 * Biome walks up to the root itself; undefined where no Biome config of the
 * repository reaches it (one in the user's config folder does not adopt
 * Biome for the repository: biome-cli.md, 5).
 */
export function biomeRunDirs(
  top: string,
): (file: string) => string | undefined {
  const project = resolve(top);
  const repository = repositoryTopOf(project);
  const configs = new Map<string, "root" | "nested" | undefined>();
  const kindIn = (dir: string): "root" | "nested" | undefined => {
    if (configs.has(dir)) return configs.get(dir);
    const config = BIOME_CONFIGS.map((name) => join(dir, name)).find((path) =>
      existsSync(path),
    );
    const kind =
      config === undefined
        ? undefined
        : /"root"\s*:\s*false|"extends"\s*:\s*"\/\/"/.test(read(config) ?? "")
          ? "nested"
          : "root";
    configs.set(dir, kind);
    return kind;
  };
  const byFolder = new Map<string, string | undefined>();
  return (file) => {
    const folder = dirname(file);
    if (byFolder.has(folder)) return byFolder.get(folder);
    const dirs = upTo(folder, repository);
    const root = dirs.find((dir) => kindIn(dir) === "root");
    const run =
      root === undefined
        ? dirs.findLast(
            (dir) =>
              kindIn(dir) === "nested" &&
              !relative(project, dir).startsWith(".."),
          )
        : relative(project, root).startsWith("..")
          ? project
          : root;
    byFolder.set(folder, run);
    return run;
  };
}

/** The files a Biome config in the project reaches: Biome formats them. */
export function biomeFiles(
  files: readonly string[],
  top: string,
): readonly string[] {
  const runDir = biomeRunDirs(top);
  return files.filter((file) => runDir(file) !== undefined);
}

/**
 * The nearest ruff config has a format table (`[tool.ruff.format]`,
 * `[format]`), or a step runs `ruff format` (or the ruff-format hook). A
 * lint-only ruff config does not adopt the formatter.
 */
export function ruffFormatAdopted(root: string, top: string): boolean {
  if (stepsMention(top, /\bruff[- ]format\b/)) return true;
  for (const dir of upTo(root, top)) {
    for (const [name, table] of [
      [".ruff.toml", /^\s*\[format\]/m],
      ["ruff.toml", /^\s*\[format\]/m],
      ["pyproject.toml", /^\s*\[tool\.ruff\.format\]/m],
    ] as const) {
      const text = read(join(dir, name));
      if (text === undefined) continue;
      // ruff ignores a pyproject.toml without [tool.ruff] when looking for
      // the nearest config.
      if (name === "pyproject.toml" && !/^\s*\[tool\.ruff[.\]]/m.test(text))
        continue;
      return table.test(text);
    }
  }
  return false;
}

/** A YAML/JSON list that names gofumpt. */
function namesGofumpt(list: unknown): boolean {
  return Array.isArray(list) && list.includes("gofumpt");
}

/**
 * A golangci-lint config (YAML, JSON or TOML) turns gofumpt on: v2
 * `formatters.enable`, v1 `linters.enable`, or v1 `enable-all` without
 * disabling it. Settings for gofumpt, or `disable: [gofumpt]`, do not.
 */
function golangciEnablesGofumpt(path: string): boolean {
  const text = read(path);
  if (text === undefined) return false;
  let config: unknown;
  try {
    // Parsed, never matched as text: TOML has several layouts for one
    // document (docs/research/formatters/toml-parser.md).
    config = path.endsWith(".json")
      ? JSON.parse(text)
      : path.endsWith(".toml")
        ? parseToml(text)
        : parseYaml(text);
  } catch {
    return false;
  }
  const c = config as {
    formatters?: { enable?: unknown };
    linters?: { enable?: unknown; disable?: unknown; "enable-all"?: unknown };
  } | null;
  return (
    namesGofumpt(c?.formatters?.enable) ||
    namesGofumpt(c?.linters?.enable) ||
    (c?.linters?.["enable-all"] === true && !namesGofumpt(c.linters.disable))
  );
}

/**
 * gofumpt is configured: turned on in a golangci-lint config at or above
 * `root`, as a `mvdan.cc/gofumpt` tool or requirement in go.mod, or in a step.
 */
export function gofumptAdopted(root: string, top: string): boolean {
  if (stepsMention(top, /\bgofumpt\b/)) return true;
  return upTo(root, top).some((dir) => {
    if (
      GOLANGCI_CONFIGS.some((name) => golangciEnablesGofumpt(join(dir, name)))
    )
      return true;
    const mod = read(join(dir, "go.mod"));
    return mod !== undefined && /mvdan\.cc\/gofumpt\b/.test(code(mod));
  });
}
