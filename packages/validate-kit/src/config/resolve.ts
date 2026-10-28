import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createJiti } from "jiti";
import satisfies from "semver/functions/satisfies.js";
import { parseAllDocuments } from "yaml";
import { TOOL_REGISTRY } from "../adapters/registry.js";
import { DEFAULT_POLICY_FILES } from "../adapters/policy.js";
import { invariantGate } from "../gates/command-gate.js";
import {
  getKitRoot,
  KIT_PACKAGE_NAME,
  kitRulesDir,
  kitVersion,
} from "../core/paths.js";
import {
  fileAtCommit,
  pathsAtCommit,
  resolveCommit,
  workTreeOf,
} from "../detect/git.js";
import { DEFAULT_MAX_FILE_BYTES, toPosix } from "../detect/languages.js";
import type {
  LangConfig,
  Language,
  Layer,
  LayerConfig,
  PresetName,
  ResolvedConfig,
  ToolAdapter,
  TrustedPolicy,
  ValidateConfig,
} from "../core/types.js";
import { LANGUAGES, LAYERS, TIERS } from "../core/types.js";
import { ConfigError, parseConfig } from "./schema.js";
import { sgconfigDirs } from "./sgconfig.js";
import { PRESETS } from "./presets.js";
import { fixAdapterIdentity, IdentityError } from "../core/evidence.js";

const CONFIG_NAMES = [
  "validate.config.ts",
  "validate.config.mts",
  "validate.config.mjs",
  "validate.config.js",
  "validate.config.cjs",
  "validate.config.json",
];
const CONFIG_EXTENSIONS = [".ts", ".mts", ".mjs", ".js", ".cjs", ".json"];
const AST_GREP_RULE_EXTENSIONS = new Set([".yml", ".yaml"]);

export interface ResolveResult {
  config: ResolvedConfig;
  /** The config file's path, or `<ref>:<path>` when read from a commit. */
  source: string | undefined;
  /** Built-in tools plus the ones this config supplies. */
  adapters: ToolAdapter[];
  /** Set when the config was read from a commit (--trusted-ref). */
  trusted?: TrustedPolicy;
}

/**
 * The run's config file in the work tree, absolute and POSIX: under
 * --trusted-ref the same path the trusted commit's config has.
 */
export function configFileOf(
  resolved: ResolveResult,
  projectRoot: string,
): string | undefined {
  if (resolved.trusted)
    return toPosix(resolve(projectRoot, resolved.trusted.configFile));
  return resolved.source === undefined
    ? undefined
    : toPosix(resolve(projectRoot, resolved.source));
}

/**
 * Where a config may be, in the order they are tried: the explicit path, or
 * each name in `CONFIG_NAMES` at the root. On disk and at a commit alike.
 */
function configCandidates(rootDir: string, explicit?: string): string[] {
  return explicit
    ? [resolve(rootDir, explicit)]
    : CONFIG_NAMES.map((name) => resolve(rootDir, name));
}

function assertConfigExtension(abs: string): void {
  if (!CONFIG_EXTENSIONS.includes(extname(abs))) {
    throw new ConfigError(
      `Unsupported config file extension for ${abs}. Expected one of: ${CONFIG_EXTENSIONS.join(", ")}`,
    );
  }
}

export function findConfigFile(
  rootDir: string,
  explicit?: string,
): string | undefined {
  const candidates = configCandidates(rootDir, explicit);
  const abs = explicit ? candidates[0] : candidates.find(existsSync);
  if (abs === undefined) return undefined;
  if (!existsSync(abs)) throw new ConfigError(`Config file not found: ${abs}`);
  if (statSync(abs).isDirectory())
    throw new ConfigError(`Config path must be a file: ${abs}`);
  assertConfigExtension(abs);
  return abs;
}

/**
 * Parse a config file's text, or (with no text) the file on disk. `absPath`
 * is where it lives in the work tree: a script config's relative imports
 * resolve from there. `label` names it in errors.
 */
async function loadConfigFile(
  absPath: string,
  label: string,
  text?: string,
): Promise<ValidateConfig> {
  let raw: unknown;
  if (absPath.endsWith(".json")) {
    try {
      raw = JSON.parse(text ?? readFileSync(absPath, "utf8"));
    } catch (err) {
      throw new ConfigError(
        `Invalid JSON config at ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    // Alias the package name to the running kit so a consumer's
    // `import { defineConfig } from "validate-kit"` resolves even when the kit
    // isn't (yet) a resolvable dependency of the target project.
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      // jiti's module cache is process-wide: with it, a long-lived process
      // (the MCP server) keeps the first config it loaded, through edits and
      // through a config evaluated from a commit under the same filename.
      moduleCache: false,
      alias: { [KIT_PACKAGE_NAME]: join(getKitRoot(), "dist", "index.js") },
    });
    try {
      const mod = (
        text === undefined
          ? await jiti.import(absPath)
          : await jiti.evalModule(text, {
              filename: absPath,
              ext: extname(absPath),
              async: true,
            })
      ) as { default?: unknown } & Record<string, unknown>;
      raw = mod.default ?? mod;
    } catch (err) {
      throw new ConfigError(
        `Failed to load validate config at ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return parseConfig(raw, label);
}

/**
 * The config as committed at `ref`, found by the same names as on disk. The
 * work tree's config is not read: a patch must not choose the policy it is
 * judged by.
 */
async function loadTrustedConfig(
  rootDir: string,
  ref: string,
  explicit: string | undefined,
): Promise<{
  trusted: TrustedPolicy;
  source: string;
  /** Undefined: the commit has no config, and neither has the work tree. */
  config: ValidateConfig | undefined;
}> {
  // The ref first: its error names it, and a ref starting with "-" is
  // refused before git runs.
  const commit = await resolveCommit(rootDir, ref, "--trusted-ref");
  const tree = await workTreeOf(rootDir);
  const candidates = configCandidates(rootDir, explicit).map((abs) => {
    assertConfigExtension(abs);
    return { abs, rel: relative(rootDir, abs).split("\\").join("/") };
  });
  const present = await pathsAtCommit(
    rootDir,
    commit,
    candidates.map((candidate) => candidate.rel),
  );
  // The first name present wins, in the same order as on disk.
  const found = candidates.find((candidate) => present.has(candidate.rel));
  if (found) {
    const source = `${ref}:${found.rel}`;
    const text = await fileAtCommit(rootDir, commit, found.rel);
    return {
      trusted: { commit, configFile: found.rel, ...tree },
      source,
      config: await loadConfigFile(found.abs, source, text),
    };
  }
  // No config at the commit and none in the work tree: the policy is the
  // built-in defaults on both sides, so judge by those. (A work tree with a
  // config the commit lacks stays an error: the ref may be wrong, and a new
  // config needs review.)
  if (!explicit && findConfigFile(rootDir) === undefined) {
    return {
      trusted: { commit, configFile: "", ...tree },
      source: `${ref} (no validate config: built-in defaults)`,
      config: undefined,
    };
  }
  throw new ConfigError(
    `--trusted-ref '${ref}' (${commit.slice(0, 12)}) has no ${explicit ? relative(rootDir, resolve(rootDir, explicit)) : `validate config (${CONFIG_NAMES.join(", ")})`} under ${rootDir}: there is no trusted policy to judge by`,
  );
}

function defaults(): ResolvedConfig {
  const languages = Object.fromEntries(
    LANGUAGES.map((l) => [l, { enabled: true } satisfies LangConfig]),
  ) as Record<Language, LangConfig>;
  const layers = Object.fromEntries(
    LAYERS.map((l) => [l, { enabled: true } satisfies LayerConfig]),
  ) as Record<Layer, LayerConfig>;
  return {
    languages,
    tools: {},
    adapters: [],
    invariants: [],
    layers,
    include: [],
    ignore: [],
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    skipMinified: true,
    astGrep: { ruleDirs: [], ruleIds: [] },
    vulnAudit: { enabled: false, scanPaths: ["."], offline: false },
    apiDiff: { enabled: false, specs: [] },
    concurrency: Math.max(1, cpus().length),
    severityOverrides: [],
    policyFiles: [...DEFAULT_POLICY_FILES],
  };
}

/** Exported for tests: layered merge semantics are load-bearing (L1). */
export function mergeInto(target: ResolvedConfig, src: ValidateConfig): void {
  if (src.languages) {
    for (const [lang, cfg] of Object.entries(src.languages) as [
      Language,
      LangConfig,
    ][]) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- public API: a caller's config may predate a language
      const existing = target.languages[lang] ?? {};
      // Per-tool objects deep-merge: a later layer adding e.g. extraArgs must
      // not wholesale-replace (and silently drop) an earlier layer's
      // `enabled: false` for the same tool.
      const tools = { ...existing.tools };
      for (const [toolId, toolCfg] of Object.entries(cfg.tools ?? {})) {
        tools[toolId] = { ...tools[toolId], ...toolCfg };
      }
      target.languages[lang] = {
        ...existing,
        ...cfg,
        tools,
      };
    }
  }
  if (src.tools) {
    for (const [toolId, toolCfg] of Object.entries(src.tools)) {
      target.tools[toolId] = { ...target.tools[toolId], ...toolCfg };
    }
  }
  if (src.adapters) target.adapters = [...target.adapters, ...src.adapters];
  if (src.invariants)
    target.invariants = [...target.invariants, ...src.invariants];
  if (src.layers) {
    for (const [layer, cfg] of Object.entries(src.layers) as [
      Layer,
      LayerConfig,
    ][]) {
      target.layers[layer] = { ...target.layers[layer], ...cfg };
    }
  }
  if (src.include) target.include = [...src.include];
  if (src.ignore) target.ignore = [...src.ignore];
  if (src.maxFileBytes !== undefined) target.maxFileBytes = src.maxFileBytes;
  if (src.skipMinified !== undefined) target.skipMinified = src.skipMinified;
  if (src.astGrep) {
    if (src.astGrep.ruleDirs)
      target.astGrep.ruleDirs = [...src.astGrep.ruleDirs];
    if (src.astGrep.ruleIds)
      target.astGrep.ruleIds = [
        ...new Set([...target.astGrep.ruleIds, ...src.astGrep.ruleIds]),
      ];
    if (src.astGrep.sgconfig) target.astGrep.sgconfig = src.astGrep.sgconfig;
  }
  if (src.vulnAudit) {
    target.vulnAudit = { ...target.vulnAudit, ...src.vulnAudit };
  }
  if (src.apiDiff) {
    target.apiDiff = {
      ...target.apiDiff,
      ...src.apiDiff,
      ...(src.apiDiff.specs ? { specs: [...src.apiDiff.specs] } : {}),
    };
  }
  if (typeof src.concurrency === "number") target.concurrency = src.concurrency;
  if (src.severityOverrides)
    target.severityOverrides = [...src.severityOverrides];
  if (src.policyFiles) target.policyFiles = [...src.policyFiles];
}

function assertExistingFile(label: string, abs: string): void {
  if (!existsSync(abs)) throw new ConfigError(`${label} not found: ${abs}`);
  if (statSync(abs).isDirectory())
    throw new ConfigError(`${label} must be a file: ${abs}`);
}

function assertExistingDirectory(label: string, abs: string): void {
  if (!existsSync(abs)) throw new ConfigError(`${label} not found: ${abs}`);
  if (!statSync(abs).isDirectory())
    throw new ConfigError(`${label} must be a directory: ${abs}`);
}

function resolveMaybeRelative(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function parseAstGrepRuleIds(abs: string): string[] {
  // Rule files may hold several YAML documents (a rule plus its tsx/js
  // grammar variants), each with its own id.
  const ids: string[] = [];
  for (const doc of parseAllDocuments(readFileSync(abs, "utf8"))) {
    const parsed: unknown = doc.toJS();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      continue;
    const id = (parsed as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) ids.push(id);
  }
  return ids;
}

function collectAstGrepRuleIdsFromDir(dir: string, out: Set<string>): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAstGrepRuleIdsFromDir(abs, out);
      continue;
    }
    if (!AST_GREP_RULE_EXTENSIONS.has(extname(entry.name))) continue;
    for (const ruleId of parseAstGrepRuleIds(abs)) out.add(ruleId);
  }
}

/** The ast-grep rule ids a run applies: the config's filter, or every rule. */
export function activeAstGrepRuleIds(
  rootDir: string,
  config: ResolvedConfig,
): string[] {
  return config.astGrep.ruleIds.length > 0
    ? [...config.astGrep.ruleIds]
    : [...collectKnownAstGrepRuleIds(rootDir, config)];
}

function collectKnownAstGrepRuleIds(
  rootDir: string,
  config: ResolvedConfig,
): Set<string> {
  const ruleDirs = config.astGrep.sgconfig
    ? sgconfigDirs(
        resolveMaybeRelative(rootDir, config.astGrep.sgconfig),
        "ruleDirs",
      )
    : [
        kitRulesDir(),
        ...config.astGrep.ruleDirs.map((dir) =>
          resolveMaybeRelative(rootDir, dir),
        ),
      ];
  const known = new Set<string>();
  for (const dir of ruleDirs) collectAstGrepRuleIdsFromDir(dir, known);
  return known;
}

function validateAstGrepRuleIds(rootDir: string, config: ResolvedConfig): void {
  if (config.astGrep.ruleIds.length === 0) return;

  const known = collectKnownAstGrepRuleIds(rootDir, config);
  const unknown = config.astGrep.ruleIds.filter((id) => !known.has(id));
  if (unknown.length === 0) return;

  throw new ConfigError(
    `Unknown astGrep.ruleIds: ${unknown.join(", ")}. Rule filters must match bundled rule ids or ids from the active ast-grep ruleDirs/sgconfig.`,
  );
}

function validateAstGrepPaths(rootDir: string, config: ResolvedConfig): void {
  if (config.astGrep.sgconfig) {
    assertExistingFile(
      "astGrep.sgconfig",
      resolve(rootDir, config.astGrep.sgconfig),
    );
  }
  for (const dir of config.astGrep.ruleDirs) {
    assertExistingDirectory("astGrep.ruleDirs entry", resolve(rootDir, dir));
  }
}

function validateLanguageToolConfigs(
  rootDir: string,
  config: ResolvedConfig,
  adapters: readonly ToolAdapter[],
): void {
  const toolIds = adapters.map((tool) => tool.id);
  for (const [lang, cfg] of Object.entries(config.languages) as [
    Language,
    LangConfig,
  ][]) {
    for (const [toolId, toolCfg] of Object.entries(cfg.tools ?? {})) {
      const label = `languages.${lang}.tools.${toolId}`;
      const adapter = adapters.find((tool) => tool.id === toolId);
      if (!adapter) {
        throw new ConfigError(
          `Unknown tool config ${label}. Expected one of: ${toolIds.join(", ")}`,
        );
      }
      if (adapter.languages.length === 0) {
        throw new ConfigError(
          `Tool ${toolId} serves no language: configure it under tools.${toolId}, not ${label}`,
        );
      }
      if (!adapter.languages.includes(lang)) {
        throw new ConfigError(
          `Tool ${toolId} does not support language ${lang}`,
        );
      }
      if (toolCfg.configPath) {
        assertExistingFile(
          `${label}.configPath`,
          resolve(rootDir, toolCfg.configPath),
        );
      }
    }
  }
}

function validateToolConfigs(
  rootDir: string,
  config: ResolvedConfig,
  toolIds: readonly string[],
): void {
  for (const [toolId, toolCfg] of Object.entries(config.tools)) {
    if (!toolIds.includes(toolId)) {
      throw new ConfigError(
        `Unknown tool config tools.${toolId}. Expected one of: ${toolIds.join(", ")}`,
      );
    }
    if (toolCfg.configPath) {
      assertExistingFile(
        `tools.${toolId}.configPath`,
        resolve(rootDir, toolCfg.configPath),
      );
    }
  }
}

function validateSeverityOverrides(
  config: ResolvedConfig,
  toolIds: readonly string[],
): void {
  const seen = new Set<string>();

  for (const override of config.severityOverrides) {
    if (!toolIds.includes(override.tool)) {
      throw new ConfigError(
        `Unknown severity override tool '${override.tool}'. Expected one of: ${toolIds.join(", ")}`,
      );
    }

    const key = `${override.tool}/${override.ruleId}`;
    if (seen.has(key)) {
      throw new ConfigError(`Duplicate severity override for ${key}`);
    }
    seen.add(key);
  }
}

/**
 * The built-in tools plus the ones a project's config supplies. A project
 * adapter may not reuse an id: silently replacing a built-in would change
 * what a known tool name means.
 */
function resolveAdapters(
  projectAdapters: readonly ToolAdapter[],
): ToolAdapter[] {
  const all = [...TOOL_REGISTRY];
  for (const adapter of projectAdapters) {
    const label = `adapters entry '${adapter.id}'`;
    if (all.some((known) => known.id === adapter.id)) {
      throw new ConfigError(
        `Duplicate tool id '${adapter.id}': ${label} must not reuse the id of a built-in tool or of another project adapter`,
      );
    }
    if (!LAYERS.includes(adapter.layer)) {
      throw new ConfigError(
        `${label} has unknown layer '${adapter.layer}'. Expected one of: ${LAYERS.join(", ")}`,
      );
    }
    const unknownLanguage = adapter.languages.find(
      (language) => !LANGUAGES.includes(language),
    );
    if (unknownLanguage) {
      throw new ConfigError(
        `${label} has unknown language '${unknownLanguage}'. Expected: ${LANGUAGES.join(", ")}`,
      );
    }
    if (adapter.tier !== undefined && !TIERS.includes(adapter.tier)) {
      throw new ConfigError(
        `${label} has unknown tier '${adapter.tier}'. Expected one of: ${TIERS.join(", ")}`,
      );
    }
    // It is hashed into the config digest, so it has to be plain data now,
    // not a surprise after the run.
    try {
      JSON.stringify(adapter.policy);
    } catch (err) {
      throw new ConfigError(
        `${label} has a policy that is not plain data: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The digest identifies it from now on; what it cannot identify would let
    // two policies that judge differently share one digest (R13).
    try {
      fixAdapterIdentity(adapter);
    } catch (err) {
      if (!(err instanceof IdentityError)) throw err;
      throw new ConfigError(
        `${label}: ${err.message}. The run's digest must identify everything that can change its verdict.`,
      );
    }
    all.push(adapter);
  }
  return all;
}

function presetList(ext: ValidateConfig["extends"]): PresetName[] {
  if (!ext) return [];
  return Array.isArray(ext) ? ext : [ext];
}

/**
 * Resolve the effective config. Precedence (highest wins):
 *   CLI overrides (applied by the caller after this) >
 *   project validate.config > preset(s) in `extends` order > built-in defaults.
 * With no config file, the `recommended` preset is the baseline.
 */
export async function resolveConfig(
  rootDir: string,
  explicitPath?: string,
  trustedRef?: string,
): Promise<ResolveResult> {
  const fromRef =
    trustedRef === undefined
      ? undefined
      : await loadTrustedConfig(rootDir, trustedRef, explicitPath);
  const source = fromRef?.source ?? findConfigFile(rootDir, explicitPath);
  const userConfig = fromRef
    ? fromRef.config
    : source
      ? await loadConfigFile(source, source)
      : undefined;
  if (
    userConfig?.kitVersion !== undefined &&
    !satisfies(kitVersion(), userConfig.kitVersion, { includePrerelease: true })
  ) {
    throw new ConfigError(
      `${source} sets kitVersion "${userConfig.kitVersion}", and this is validate-kit ${kitVersion()}: install a kit in that range, or re-check the project with this one and update kitVersion`,
    );
  }

  const resolved = defaults();
  const presets: PresetName[] = userConfig?.extends
    ? presetList(userConfig.extends)
    : ["recommended"];
  for (const name of presets) mergeInto(resolved, PRESETS[name]);
  if (userConfig) {
    const { extends: _ignored, ...rest } = userConfig;
    mergeInto(resolved, rest);
  }
  validateAstGrepPaths(rootDir, resolved);
  validateAstGrepRuleIds(rootDir, resolved);
  const invariantIds = new Set<string>();
  for (const { id } of resolved.invariants) {
    if (invariantIds.has(id))
      throw new ConfigError(`Duplicate invariant id '${id}'`);
    invariantIds.add(id);
  }
  const adapters = resolveAdapters([
    ...resolved.adapters,
    ...resolved.invariants.map(invariantGate),
  ]);
  const toolIds = adapters.map((tool) => tool.id);
  validateToolConfigs(rootDir, resolved, toolIds);
  validateLanguageToolConfigs(rootDir, resolved, adapters);
  validateSeverityOverrides(resolved, toolIds);

  return {
    config: Object.freeze(resolved),
    source,
    adapters,
    ...(fromRef ? { trusted: fromRef.trusted } : {}),
  };
}
