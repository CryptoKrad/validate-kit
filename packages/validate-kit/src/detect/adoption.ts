import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** composer.json in `dir` requires `name` (`require` or `require-dev`). */
function composerRequires(dir: string, name: string): boolean {
  try {
    const manifest = JSON.parse(
      read(join(dir, "composer.json")) ?? "null",
    ) as Record<string, unknown> | null;
    return ["require", "require-dev"].some((field) => {
      const deps = manifest?.[field];
      return typeof deps === "object" && deps !== null && name in deps;
    });
  } catch {
    return false;
  }
}

/**
 * A tool the kit runs only where the repository chose it: one of its config
 * files at or above `root`, the npm package `dep` in a package.json's
 * dependencies (or a `key` of its own there), `dep` in a pyproject.toml when
 * it is a Python package too, a gem in the Gemfile, a package composer.json
 * requires, a dependency in mix.exs, or a task or CI step that runs `step`.
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
    gem,
    composer,
    mix,
  }: {
    configs: readonly string[];
    dep?: string;
    key?: string;
    step?: RegExp;
    /** `dep` is also a Python package, named in a pyproject.toml. */
    pyproject?: boolean;
    /** The gem's name, a regular expression (`rubocop(?:-[\w-]+)?`). */
    gem?: string;
    /** The Composer package (`laravel/pint`). */
    composer?: string;
    /** The Mix dependency's name (`credo` for `{:credo, …}`). */
    mix?: string;
  },
): boolean {
  if (step && stepsMention(top, step)) return true;
  const gemLine =
    gem === undefined
      ? undefined
      : new RegExp(`^\\s*gem\\s+["'](?:${gem})["']`, "m");
  const mixDep =
    mix === undefined ? undefined : new RegExp(`\\{\\s*:${mix}\\s*,`);
  return upTo(root, top).some((dir) => {
    if (configs.some((name) => existsSync(join(dir, name)))) return true;
    if (gemLine?.test(code(read(join(dir, "Gemfile")) ?? ""))) return true;
    if (mixDep?.test(code(read(join(dir, "mix.exs")) ?? ""))) return true;
    if (composer !== undefined && composerRequires(dir, composer)) return true;
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

/**
 * The folder of each file's nearest config among `configs` (or a package.json
 * with `key`), looking from the file's folder up to `top`, one look per
 * folder; undefined where none reaches it. For a tool that reads its config
 * only from where it runs (taplo, yamllint) or per file (markdownlint-cli2).
 * With `highest`, the highest one instead (SwiftLint runs from it and merges
 * the nested ones); with `stopAt`, no higher than the first folder holding
 * one of those (ocamlformat's project root: `.git`, `.hg`, `dune-project`).
 */
export function configFolderOf(
  top: string,
  configs: readonly string[],
  {
    key,
    highest = false,
    stopAt = [],
  }: { key?: string; highest?: boolean; stopAt?: readonly string[] } = {},
): (file: string) => string | undefined {
  const byFolder = new Map<string, string | undefined>();
  const isRoot = (dir: string) =>
    stopAt.some((name) => existsSync(join(dir, name)));
  const hasConfig = (dir: string) =>
    toolAdopted(dir, dir, { configs, ...(key ? { key } : {}) });
  return (file) => {
    const folder = dirname(file);
    if (!byFolder.has(folder)) {
      const dirs = upTo(folder, top);
      const root = dirs.findIndex(isRoot);
      const reach = root === -1 ? dirs : dirs.slice(0, root + 1);
      byFolder.set(
        folder,
        highest ? reach.findLast(hasConfig) : reach.find(hasConfig),
      );
    }
    return byFolder.get(folder);
  };
}

const DOTNET_PROJECT = /\.csproj$/i;
const DOTNET_SOLUTION = /\.slnx?$/i;

/**
 * What dotnet loads to reach each file: the highest solution (`.sln`,
 * `.slnx`) up to `top` that lists the file's project, else that project
 * (the nearest `.csproj` up). Undefined for a file in no project. A solution
 * that does not list the project would check nothing for it (`--include` of
 * a file outside the workspace exits 0:
 * docs/research/lint-toolchain/sota-2026-10-18/dotnet-ruby-php-elixir.md, 1c).
 */
export function dotnetWorkspaces(
  top: string,
): (file: string) => string | undefined {
  const listed = new Map<string, string[]>();
  const names = (dir: string): string[] => {
    let found = listed.get(dir);
    if (found === undefined) {
      try {
        found = readdirSync(dir)
          .filter((n) => DOTNET_PROJECT.test(n) || DOTNET_SOLUTION.test(n))
          .toSorted();
      } catch {
        found = [];
      }
      listed.set(dir, found);
    }
    return found;
  };
  // Each solution's projects, relative to its folder, `/`-separated and
  // lower-case: `"src\App\App.csproj"` in a .sln, `Path="src/App/App.csproj"`
  // in a .slnx.
  const projects = new Map<string, Set<string>>();
  const lists = (solution: string, project: string): boolean => {
    let own = projects.get(solution);
    if (own === undefined) {
      own = new Set(
        [...(read(solution) ?? "").matchAll(/"([^"]+\.csproj)"/gi)].map((m) =>
          (m[1] ?? "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(),
        ),
      );
      projects.set(solution, own);
    }
    return own.has(
      relative(dirname(solution), project).replaceAll("\\", "/").toLowerCase(),
    );
  };
  return (file) => {
    const dirs = upTo(dirname(file), top);
    const projectDir = dirs.find((dir) =>
      names(dir).some((n) => DOTNET_PROJECT.test(n)),
    );
    const name =
      projectDir && names(projectDir).find((n) => DOTNET_PROJECT.test(n));
    if (!projectDir || !name) return undefined;
    const project = join(projectDir, name);
    const solution = dirs
      .slice(dirs.indexOf(projectDir))
      .toReversed()
      .flatMap((dir) =>
        names(dir)
          .filter((n) => DOTNET_SOLUTION.test(n))
          .map((n) => join(dir, n)),
      )
      .find((path) => lists(path, project));
    return (solution ?? project).replaceAll("\\", "/");
  };
}

/**
 * Mix can load Hex packages: the Hex archive is installed (`MIX_ARCHIVES`,
 * else the `archives` folder of Mix's home: `MIX_HOME`, the XDG data folder
 * under `MIX_XDG`, else ~/.mix). Without it, any Hex dependency fails to load.
 */
export function hexInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const home =
    env.MIX_HOME ??
    (env.MIX_XDG
      ? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "mix")
      : join(homedir(), ".mix"));
  try {
    return readdirSync(env.MIX_ARCHIVES ?? join(home, "archives")).some(
      (name) => name.startsWith("hex"),
    );
  } catch {
    return false;
  }
}

/**
 * The first of `names` (paths relative to a folder) in `dir` or a folder
 * above it, up to `top`: the config a tool is handed by flag (PMD's ruleset,
 * detekt's and scalafmt's config), since it does not look for it itself.
 */
export function firstConfig(
  dir: string,
  top: string,
  names: readonly string[],
): string | undefined {
  return upTo(dir, top)
    .flatMap((folder) => names.map((name) => join(folder, name)))
    .find((path) => existsSync(path));
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
