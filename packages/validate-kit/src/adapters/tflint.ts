import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { groupBy } from "../core/group.js";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { firstConfig, toolAdopted } from "../detect/adoption.js";
import { isUnder, toPosix } from "../detect/languages.js";
import {
  existingFiles,
  finding,
  findingsArray,
  fromRealCwd,
  parseFindings,
  readResult,
} from "./base.js";

/** tflint's config names, in the order it reads them from the folder it lints. */
const CONFIGS = [".tflint.hcl", ".tflint.json"];

/**
 * What tflint reads of a module: `.tf`, `.tf.json` and the values files;
 * never `.tofu` or `.tftest.hcl` (tflint.md, 1.2).
 */
const INPUT = /\.(?:tf|tfvars)(?:\.json)?$/;

/** A step that runs tflint: the command, the setup-tflint action, the pre-commit hook. */
const STEP =
  /(?:^|[\s;&|"'(/])tflint(?:\s|$)|\bsetup-tflint@|\bterraform_tflint\b/m;

/** A step that hands tflint a config (`--config "$(pwd)/.tflint.hcl"`, pre-commit's `--args=--config=…`). */
const STEP_CONFIG =
  /(?:^|[\s;&|"'(/])tflint\s.*\s(?:--config|-c)(?:[\s=]|$)|--args=--config=/m;

/** `source = "./…"` (HCL) or `"source": "../…"` (JSON): a local module call. */
const LOCAL_SOURCE = /\bsource"?\s*[=:]\s*"(\.\.?\/[^"]*)"/g;

const SEVERITY: Record<string, Severity> = {
  error: "error",
  warning: "warning",
  // tflint's NOTICE (terraform_documented_variables).
  info: "info",
};

interface TflintTask {
  /** The module folder, relative to where tflint starts (`--chdir`). */
  module: string;
  /** Absolute: what tflint would otherwise not read (it never looks up). */
  config?: string;
}

interface TflintRange {
  filename?: unknown;
  start?: { line?: unknown; column?: unknown };
  end?: { line?: unknown; column?: unknown };
}

interface TflintIssue {
  rule?: { name?: unknown; severity?: unknown; link?: unknown };
  message?: unknown;
  range?: TflintRange;
}

interface TflintError {
  summary?: unknown;
  message?: unknown;
  range?: TflintRange;
}

type Attrs = Record<string, unknown>;

/** A config block: its attributes, and the names of those it could not read. */
interface Block {
  type: string;
  label?: string;
  attrs: Attrs;
  /** Attributes that are not a string or a bool; "" for a line with no name. */
  unread: string[];
}

/**
 * The top-level blocks of a .tflint.hcl, each with its own string and bool
 * attributes (`plugin "aws" { version = "0.49.0" }`), enough to read its
 * plugins without an HCL parser; undefined for a file whose top level it
 * cannot read whole (tflint's error is then the one reported).
 */
function hclBlocks(text: string): Block[] | undefined {
  const blocks: Block[] = [];
  let depth = 0;
  let line = "";
  const endLine = (): boolean => {
    const block = blocks.at(-1);
    const content = line.trim();
    line = "";
    if (content === "") return true;
    if (depth === 0 || !block) return false; // an attribute outside any block
    if (depth > 1) return true;
    const attr = /^(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)$/.exec(content);
    if (attr?.[1] && attr[2])
      block.attrs[attr[1]] = JSON.parse(attr[2]) as unknown;
    else block.unread.push(/^(\w+)\s*=/.exec(content)?.[1] ?? "");
    return true;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "#" || text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"') {
      const string = /^"(?:[^"\\\n]|\\.)*"?/.exec(text.slice(i))?.[0] ?? '"';
      line += string;
      i += string.length;
    } else if (c === "{") {
      if (depth === 0) {
        // `plugin "aws"`, `plugin aws`, `plugin"aws"`: one label at most.
        const head = /^\s*([\w-]+)\s*(?:"([^"]*)"|([\w-]+))?\s*$/.exec(line);
        if (!head?.[1]) return undefined;
        const label = head[2] ?? head[3];
        blocks.push({
          type: head[1],
          ...(label !== undefined ? { label } : {}),
          attrs: {},
          unread: [],
        });
      }
      // In a block: a nested block or a map, which is not read.
      depth++;
      line = "";
      i++;
    } else if (c === "}" || c === "\n") {
      // `plugin "aws" { enabled = true }` on one line too.
      if (!endLine()) return undefined;
      if (c === "}" && --depth < 0) return undefined;
      i++;
    } else {
      line += c;
      i++;
    }
  }
  return depth === 0 && endLine() ? blocks : undefined;
}

const isObject = (value: unknown): value is Attrs =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A JSON block's bodies: an object, or an array of them; none when absent. */
function bodies(value: unknown): Attrs[] | undefined {
  if (value === undefined) return [];
  const all: unknown[] = Array.isArray(value) ? value : [value];
  return all.every(isObject) ? all : undefined;
}

/**
 * A .tflint.json's config and plugin blocks, in HCL's JSON syntax; undefined
 * for any shape tflint may not read as one (a `"//"` among the plugins is
 * refused: `Incorrect JSON value type`).
 */
function jsonBlocks(text: string): Block[] | undefined {
  const root: unknown = JSON.parse(text);
  if (!isObject(root)) return undefined;
  const configs = bodies(root.config);
  const plugins = bodies(root.plugin);
  if (!configs || !plugins) return undefined;
  const blocks: Block[] = configs.map((attrs) => ({
    type: "config",
    attrs,
    unread: [],
  }));
  for (const named of plugins)
    for (const [label, body] of Object.entries(named)) {
      const all = label === "//" ? undefined : bodies(body);
      if (!all?.length) return undefined;
      for (const attrs of all)
        blocks.push({ type: "plugin", label, attrs, unread: [] });
    }
  return blocks;
}

/** A block's string or bool attribute, absent, or null where it was not read. */
function literal(
  block: Block,
  key: string,
): string | boolean | undefined | null {
  if (block.unread.includes(key) || block.unread.includes("")) return null;
  const value = block.attrs[key];
  return value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
    ? value
    : null;
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/**
 * Why a check cannot lint `moduleDir` with `config`, when a block read whole
 * says so: a plugin it declares is not where tflint looks (enabled or not:
 * it looks for every one first), which only `tflint --init` installs, from
 * GitHub; or a plugin's `deep_check`, which calls the cloud provider's API.
 * The plugin folder is the config's `plugin_dir`, else TFLINT_PLUGIN_DIR,
 * else the module's `.tflint.d/plugins` if there is one, else
 * `~/.tflint.d/plugins` (tflint.md, 1.7). Anything else is tflint's to
 * report, as a crash.
 */
function cannotLint(
  config: string,
  moduleDir: string,
  top: string,
): string | undefined {
  let blocks;
  try {
    const text = readFileSync(config, "utf8");
    blocks = config.endsWith(".json") ? jsonBlocks(text) : hclBlocks(text);
  } catch {
    return undefined;
  }
  if (blocks === undefined) return undefined;
  const dirs = blocks
    .filter((block) => block.type === "config")
    .map((block) => literal(block, "plugin_dir"));
  if (dirs.some((dir) => dir === null || typeof dir === "boolean"))
    return undefined;
  const named = dirs.find((dir) => typeof dir === "string");
  const local = join(moduleDir, ".tflint.d", "plugins");
  const pluginDir =
    typeof named === "string"
      ? named.startsWith("~")
        ? join(homedir(), named.slice(1))
        : resolve(moduleDir, named)
      : process.env.TFLINT_PLUGIN_DIR
        ? resolve(moduleDir, process.env.TFLINT_PLUGIN_DIR)
        : existsSync(local)
          ? local
          : join(homedir(), ".tflint.d", "plugins");
  const where = isUnder(config, top)
    ? posix.relative(top, toPosix(config))
    : toPosix(config);
  for (const block of blocks) {
    const name = block.label;
    if (block.type !== "plugin" || name === undefined) continue;
    const [source, version, enabled, deep] = [
      "source",
      "version",
      "enabled",
      "deep_check",
    ].map((key) => literal(block, key));
    if ([source, version, enabled, deep].includes(null)) continue;
    if (enabled === true && deep === true)
      return `${where}: plugin "${name}" sets deep_check = true, which calls the cloud provider's API (network): a check never does, so set it to false for the kit`;
    const manual = source === undefined && version === undefined;
    const released = typeof source === "string" && typeof version === "string";
    // The bundled ruleset; one of source and version alone, which tflint refuses.
    if ((manual && name === "terraform") || (!manual && !released)) continue;
    const path = released
      ? join(pluginDir, source, version, `tflint-ruleset-${name}`)
      : join(pluginDir, `tflint-ruleset-${name}`);
    if (isFile(path) || isFile(`${path}.exe`)) continue;
    return released
      ? `${where}: plugin "${name}" (${source} ${version}) is not installed in ${toPosix(pluginDir)}: run \`tflint --init\` (it downloads it from GitHub, which a check never does)`
      : `${where}: plugin "${name}" is not installed: tflint looks for ${toPosix(path)}`;
  }
  return undefined;
}

/**
 * The config tflint reads in a module given none and holding none of its
 * own: TFLINT_CONFIG_FILE, else `~/.tflint.hcl` or `~/.tflint.json`.
 */
function fallbackConfig(moduleDir: string): string | undefined {
  const named = process.env.TFLINT_CONFIG_FILE;
  if (named) return toPosix(resolve(moduleDir, named));
  const home = firstConfig(homedir(), homedir(), CONFIGS);
  return home === undefined ? undefined : toPosix(home);
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * In a changed-file run, the module folders a change reaches: each with a
 * changed or deleted file tflint reads, each at or below a changed config
 * (or the `tools.tflint.configPath` file), and, over and over, each that
 * calls one of those as a local module: tflint checks the call against the
 * callee, which may be gone.
 */
function reachedModules(
  top: string,
  changedPaths: readonly string[],
  modules: ReadonlyMap<string, readonly string[]>,
  named: string | undefined,
): Set<string> {
  const changed = changedPaths.map((path) => posix.join(top, toPosix(path)));
  const configs = changed
    .filter((f) => f === named || CONFIGS.includes(posix.basename(f)))
    .map((f) => (f === named ? top : posix.dirname(f)));
  const reached = new Set(
    changed.filter((f) => INPUT.test(f)).map((f) => posix.dirname(f)),
  );
  const callers = new Map<string, string[]>();
  for (const [dir, files] of modules) {
    if (configs.some((folder) => isUnder(dir, folder))) reached.add(dir);
    for (const file of files)
      for (const call of readText(file).matchAll(LOCAL_SOURCE)) {
        const callee = posix.join(dir, call[1] ?? "").replace(/\/+$/, "");
        callers.set(callee, [...(callers.get(callee) ?? []), dir]);
      }
  }
  // A Set's iteration visits what is added during it: the callers' callers.
  for (const dir of reached)
    for (const caller of callers.get(dir) ?? []) reached.add(caller);
  return reached;
}

/** An error tflint printed, with its place when it has one. */
function described(error: TflintError): string {
  const { filename, start } = error.range ?? {};
  const at =
    typeof filename === "string"
      ? `${filename}:${String(start?.line)}:${String(start?.column)}: `
      : "";
  const text = [error.summary, error.message]
    .filter((part) => typeof part === "string" && part !== "")
    .join(": ");
  return `${at}${text}`;
}

/**
 * tflint — Terraform's linter: declarations nothing uses, deprecated syntax,
 * providers and modules without a pinned version, and with a provider's
 * plugin (aws, google, azurerm) values the provider would refuse, such as
 * an instance type that does not exist. Error and warning as they are, a
 * notice as info. Where the project chose it: a `.tflint.hcl` or
 * `.tflint.json` at or above the module folder, `tools.tflint.enabled` or
 * `.configPath`, or a step that runs it. It reads the config tflint itself
 * would (the module's own, else its fallback), and a parent one only when
 * the project's step passes `--config`. One task per module folder a change
 * reaches: a changed or deleted `.tf`, `.tf.json` or `.tfvars` file in it,
 * a changed config at or above it, or a local module it calls. Never
 * `tflint --init`, which downloads plugins from GitHub: a config naming a
 * plugin that is not installed, or turning on a plugin's `deep_check`
 * (cloud API calls), cannot run. No network, and nothing written into the
 * project. No fix: `--fix` deletes unused declarations. Recorded on 0.64.0:
 * docs/research/lint-toolchain/sota-2026-10-18/tflint.md.
 */
export const tflint: ToolAdapter = {
  id: "tflint",
  layer: "lint",
  languages: ["terraform"],
  fileScoped: false,
  configFiles: CONFIGS,
  bin: "tflint",
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  minVersion: "0.64.0",
  installHint:
    "brew install terraform-linters/tap/tflint  (or: go install github.com/terraform-linters/tflint@v0.64.0)",
  parseVersion: (out) => /TFLint version (\d+\.\d+\.\d+)/.exec(out)?.[1],
  // `--version` asks GitHub for a newer release unless told not to.
  versionEnv: { TFLINT_DISABLE_VERSION_CHECK: "1" },
  configFor: (_finding, ctx) => (ctx.options as TflintTask | undefined)?.config,

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    const top = toPosix(env.projectRoot);
    const named = env.toolConfig.configPath;
    const stepConfig = toolAdopted(top, top, {
      configs: [],
      step: STEP_CONFIG,
    });
    const chosen =
      env.toolConfig.enabled === true ||
      named !== undefined ||
      toolAdopted(top, top, { configs: [], step: STEP });
    const modules = groupBy(
      existingFiles(seed, env, "terraform").filter((file) => INPUT.test(file)),
      (file) => posix.dirname(file),
    );
    const reached =
      env.changedPaths && reachedModules(top, env.changedPaths, modules, named);
    return [...modules].flatMap(([dir, files]) => {
      if (reached && !reached.has(dir)) return [];
      const nearest = firstConfig(dir, top, CONFIGS);
      if (!chosen && nearest === undefined) return [];
      // tflint reads only the module's own config. shortcut: a step's
      // --config is taken to name the nearest one; read its path if a
      // project names another.
      const own =
        nearest !== undefined && posix.dirname(toPosix(nearest)) === dir;
      const config =
        named ??
        (nearest !== undefined && (own || stepConfig)
          ? toPosix(nearest)
          : undefined);
      const task: TflintTask = {
        module: posix.relative(toPosix(seed.cwd), dir) || ".",
        ...(config ? { config } : {}),
      };
      const read = config ?? fallbackConfig(dir);
      const cannotRun =
        read === undefined ? undefined : cannotLint(read, dir, top);
      return [
        {
          cwd: seed.cwd,
          files,
          options: task,
          ...(cannotRun ? { cannotRun } : {}),
        },
      ];
    });
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) =>
      /^(?:-f|--format|--chdir|--recursive|--filter|--fix|--init|--langserver|-v|--version)(?:=|$)|^-f./.test(
        arg,
      ),
    )
      ? "the kit names each module and reads tflint's JSON; --filter drops issues, --fix deletes declarations and --init downloads plugins"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const { module = ".", config } = (ctx.options ?? {}) as Partial<TflintTask>;
    return {
      bin: this.bin,
      args: [
        `--chdir=${module}`,
        "--format",
        "json",
        ...(config ? [`--config=${config}`] : []),
        ...ctx.extraArgs,
      ],
      // 1: it could not lint (a bad config, a missing plugin, a file that
      // does not parse): the JSON's `errors` says which.
      okExitCodes: [0, 1, 2],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const { root, items } = parseFindings<TflintIssue>("tflint", raw, "issues");
    const [error] = findingsArray<TflintError>("tflint", root, "errors");
    if (error) throw new Error(`tflint could not lint: ${described(error)}`);
    // Paths are relative to where it started, through the module's real path.
    const fileOf = fromRealCwd(ctx.cwd);
    const findings = items.map(({ rule, message, range }) => {
      const severity =
        typeof rule?.severity === "string"
          ? SEVERITY[rule.severity]
          : undefined;
      const start = range?.start;
      const end = range?.end;
      if (
        typeof rule?.name !== "string" ||
        severity === undefined ||
        typeof message !== "string" ||
        typeof range?.filename !== "string" ||
        typeof start?.line !== "number" ||
        typeof start.column !== "number"
      )
        throw new Error(
          `tflint reported an issue without a rule, known severity (${JSON.stringify(rule?.severity)}), message or position: its output format may have changed; refusing to report it.`,
        );
      return finding({
        tool: "tflint",
        layer: "lint",
        language: "terraform",
        file: fileOf(range.filename),
        line: start.line,
        col: start.column,
        // A file it says is missing (terraform_standard_module_structure)
        // ends at 0:0.
        ...(typeof end?.line === "number" &&
        typeof end.column === "number" &&
        end.line >= start.line &&
        end.line > 0
          ? { endLine: end.line, endCol: end.column }
          : {}),
        ruleId: rule.name,
        severity,
        message,
        fixable: false,
        ...(typeof rule.link === "string" && rule.link
          ? { url: rule.link }
          : {}),
      });
    });
    // Exit 2 with no issue, or 1 with no error, is output the kit cannot read.
    return readResult("tflint", raw, ctx, findings);
  },
};
