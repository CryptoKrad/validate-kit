import { existsSync } from "node:fs";
import { posix } from "node:path";
import { refineRoots } from "../detect/roots.js";
import {
  isUnder,
  languageForFile,
  listScopedFiles,
  toPosix,
} from "../detect/languages.js";
import { absPosix } from "../adapters/base.js";
import { ConfigError } from "../config/schema.js";
import { stableJson } from "./evidence.js";
import type {
  ScopeNote,
  Detection,
  Language,
  Layer,
  PlanEnv,
  ResolvedConfig,
  TaskSeed,
  ToolAdapter,
  ToolConfig,
  TrustedPolicy,
} from "./types.js";
import { LANGUAGE_SPECS, LAYERS } from "./types.js";

/**
 * Max files per task argv. ARG_MAX is ~1MB on macOS/Linux; 400 paths of even
 * 500 bytes stay ~200KB, comfortably clear of E2BIG. Oversized file lists are
 * split into several tasks of the same adapter — the runner merges findings
 * and sums per-tool file counts, so chunking is invisible downstream.
 */
export const FILE_ARG_CHUNK = 400;

function chunkFiles(files: string[]): string[][] {
  if (files.length <= FILE_ARG_CHUNK) return [files];
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += FILE_ARG_CHUNK) {
    chunks.push(files.slice(i, i + FILE_ARG_CHUNK));
  }
  return chunks;
}

export interface PlannedTask extends TaskSeed {
  adapter: ToolAdapter;
  /** Per-tool config (extraArgs, configPath) resolved from validate config. */
  toolConfig: ToolConfig;
}

export interface PlanFilters {
  onlyTools?: Set<string>;
  disabledTools?: Set<string>;
  onlyLayers?: Set<Layer>;
  onlyLanguages?: Set<Language>;
  /** All files in the configured validation scope. Used in full runs. */
  scopedFiles?: string[];
  changedFiles?: string[];
  /** Every path the change touched, relative to the project root. */
  changedPaths?: string[];
  changedMode?: PlanEnv["changedMode"];
  /** Set when the config was read from a commit (--trusted-ref). */
  trusted?: TrustedPolicy;
  /** The run's config file in the work tree, absolute (PlanEnv). */
  configFile?: string;
  /** Told about files a planned crate or module tool cannot reach. */
  onNote?: (note: ScopeNote) => void;
}

function byLayer(adapter: ToolAdapter): number {
  return LAYERS.indexOf(adapter.layer);
}

function servedLanguages(
  adapter: ToolAdapter,
  detection: Detection,
  config: ResolvedConfig,
  only?: Set<Language>,
): Language[] {
  return adapter.languages.filter(
    (l) =>
      detection.has(l) &&
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- public API: a caller's config may predate a language or layer
      config.languages[l]?.enabled !== false &&
      (!only || only.has(l)),
  );
}

function adapterRoots(
  adapter: ToolAdapter,
  detection: Detection,
  projectRoot: string,
  langs: Language[],
): string[] {
  if (adapter.runsAt === "project-root") return [toPosix(projectRoot)];
  const roots = new Set<string>();
  for (const lang of langs) {
    const langRoots = (detection.get(lang)?.roots ?? []).map(toPosix);
    for (const root of refineRoots(lang, langRoots)) roots.add(root);
  }
  // One canonical order per tool, whatever order its languages contributed
  // their roots in.
  return [...roots].toSorted();
}

/**
 * `tools.<id>` with `languages.<lang>.tools.<id>` over it, for one language
 * (none for a tool that serves no language).
 */
function toolConfigFor(
  adapter: ToolAdapter,
  config: ResolvedConfig,
  projectRoot: string,
  lang: Language | undefined,
): ToolConfig {
  const merged: ToolConfig = {
    ...config.tools[adapter.id],
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- public API: a caller's config may predate a language or layer
    ...(lang === undefined ? {} : config.languages[lang]?.tools?.[adapter.id]),
  };
  if (merged.configPath)
    merged.configPath = absPosix(projectRoot, merged.configPath);
  // A path is the project's; a bare name is looked up on PATH only (DV16).
  if (merged.bin && /[/\\]/.test(merged.bin))
    merged.bin = absPosix(projectRoot, merged.bin);
  return merged;
}

/**
 * The tool's served languages grouped by their settings: a language that
 * configures the tool its own way gets its own tasks (DV9). A tool that runs
 * once over all its languages (no file list) cannot be split, so different
 * settings for it are a config error.
 */
function settingsGroups(
  adapter: ToolAdapter,
  config: ResolvedConfig,
  projectRoot: string,
  langs: Language[],
): { langs: Language[]; toolCfg: ToolConfig }[] {
  if (langs.length === 0)
    return [
      {
        langs,
        toolCfg: toolConfigFor(adapter, config, projectRoot, undefined),
      },
    ];
  const groups = new Map<string, { langs: Language[]; toolCfg: ToolConfig }>();
  for (const lang of langs) {
    const toolCfg = toolConfigFor(adapter, config, projectRoot, lang);
    // The same settings, whatever order their keys were written in.
    const key = stableJson(toolCfg);
    const group = groups.get(key);
    if (group) group.langs.push(lang);
    else groups.set(key, { langs: [lang], toolCfg });
  }
  if (groups.size > 1 && adapter.fileScoped === false)
    throw new ConfigError(
      `languages.<lang>.tools.${adapter.id}: ${adapter.id} runs once over ${langs.join(", ")} together, so it cannot be set per language; set it under tools.${adapter.id}`,
    );
  return [...groups.values()];
}

/**
 * A formatter runs where the repository adopted it, or where the kit's config
 * turns it on or names its config file (R11).
 */
function adopted(
  adapter: ToolAdapter,
  toolCfg: ToolConfig,
  root: string,
  projectRoot: string,
): boolean {
  return (
    !adapter.adoptedAt ||
    toolCfg.enabled === true ||
    toolCfg.configPath !== undefined ||
    adapter.adoptedAt(root, projectRoot)
  );
}

/**
 * Turn (detection × config × filters) into a flat, ordered task list. Tasks are
 * grouped by layer (format → lint → type-check → custom-rules → security); within
 * a layer order is irrelevant (the runner parallelizes).
 */
export async function buildPlan(
  detection: Detection,
  config: ResolvedConfig,
  projectRoot: string,
  adapters: ToolAdapter[],
  filters: PlanFilters = {},
): Promise<PlannedTask[]> {
  // Every tool's seeds first, then all expansions at once (tsc asks tsc what
  // each project covers); tasks keep the seeds' order.
  const seeds: {
    adapter: ToolAdapter;
    toolConfig: ToolConfig;
    seed: TaskSeed;
  }[] = [];
  const ordered = adapters.toSorted((a, b) => byLayer(a) - byLayer(b));
  const env: Omit<PlanEnv, "toolConfig"> = {
    config,
    projectRoot,
    // A caller that passes no scope (the exported four-argument form) gets
    // the project's own: tools that find their inputs (tsc, tlc) need it.
    scopedFiles:
      filters.scopedFiles ??
      (await listScopedFiles(projectRoot, {
        include: config.include,
        ignore: config.ignore,
      })),
    ...(filters.changedPaths ? { changedPaths: filters.changedPaths } : {}),
    ...(filters.changedMode ? { changedMode: filters.changedMode } : {}),
    ...(filters.trusted ? { trusted: filters.trusted } : {}),
    ...(filters.configFile ? { configFile: filters.configFile } : {}),
  };

  /**
   * Plan one tool for the languages that share one setting of it (`langs`).
   * Its roots come from every language it serves (`served`), so a file runs
   * from the same root whatever group its language is in: a .ts file in a
   * package with package.json but no tsconfig still runs from that package.
   */
  const planGroup = (
    adapter: ToolAdapter,
    langs: Language[],
    toolCfg: ToolConfig,
    served: Language[],
  ): void => {
    if (toolCfg.enabled === false) return;
    const refused =
      toolCfg.extraArgs && adapter.refuseArgs?.(toolCfg.extraArgs);
    if (refused)
      throw new ConfigError(`tools.${adapter.id}.extraArgs: ${refused}`);

    if (toolCfg.bin !== undefined && adapter.binSetting === false)
      throw new ConfigError(
        `tools.${adapter.id}.bin: ${adapter.id} runs its tools from a script, so the setting cannot choose them`,
      );
    // The configured executable replaces the tool's own (DV16). The tool is
    // the prototype, so an adapter written as a class keeps its methods, and
    // its own `bin` may be a getter.
    const runAdapter =
      toolCfg.bin === undefined
        ? adapter
        : (Object.defineProperty(Object.create(adapter), "bin", {
            value: toolCfg.bin,
            enumerable: true,
          }) as ToolAdapter);
    const plan = (seed: TaskSeed): void => {
      seeds.push({ adapter: runAdapter, toolConfig: toolCfg, seed });
    };

    if (adapter.languages.length === 0) {
      plan({ cwd: toPosix(projectRoot) });
      return;
    }

    const candidates = filters.changedFiles ?? filters.scopedFiles;
    const ofLangs = (candidates ?? []).filter((f) => {
      const l = languageForFile(f);
      return l !== undefined && langs.includes(l);
    });
    let roots = adapterRoots(adapter, detection, projectRoot, served);
    if (adapter.rootedAtMarker) {
      // Only where its marker is: with none, the fallback root is no crate.
      roots = roots.filter((root) =>
        served.some((lang) =>
          detection
            .get(lang)
            ?.markerFiles.some((marker) => isUnder(marker, root)),
        ),
      );
      for (const lang of langs) {
        const outside = ofLangs.filter(
          (f) =>
            languageForFile(f) === lang &&
            !roots.some((root) => isUnder(f, root)),
        );
        if (outside.length > 0)
          filters.onNote?.({
            reason: "no-marker",
            lang,
            marker: LANGUAGE_SPECS[lang].markers.join(" or "),
            tools: [adapter.id],
            files: outside,
          });
      }
    } else if (
      candidates &&
      ofLangs.some((f) => !roots.some((root) => isUnder(f, root)))
    ) {
      // Files outside every marker root: a tool that reads files checks
      // them from the project root.
      roots = [...roots, toPosix(projectRoot)].toSorted();
    }
    for (const cwd of roots) {
      let files: string[] | undefined;
      const candidateFiles = filters.changedFiles ?? filters.scopedFiles;
      if (candidateFiles) {
        const scopeRoot = adapter.runsAt === "project-root" ? projectRoot : cwd;
        // Each file to its nearest root only: a package with its own markers
        // inside another is linted once, from its own root (R8).
        const nested = roots.filter(
          (root) => root !== cwd && isUnder(root, scopeRoot),
        );
        const relevant = candidateFiles.filter((f) => {
          if (!isUnder(f, scopeRoot)) return false;
          if (nested.some((root) => isUnder(f, root))) return false;
          const l = languageForFile(f);
          return l !== undefined && langs.includes(l);
        });
        // A module-wide tool also answers for a file the change deleted: what
        // imported it may no longer build.
        const deleted =
          adapter.fileScoped === false && filters.changedFiles
            ? (filters.changedPaths ?? [])
                .map((path) => posix.join(toPosix(projectRoot), toPosix(path)))
                .filter((f) => {
                  const l = languageForFile(f);
                  return (
                    l !== undefined &&
                    langs.includes(l) &&
                    !existsSync(f) &&
                    isUnder(f, scopeRoot) &&
                    !nested.some((root) => isUnder(f, root))
                  );
                })
            : [];
        if (relevant.length === 0 && deleted.length === 0) continue;
        if (!adopted(adapter, toolCfg, cwd, projectRoot)) {
          const replaced = new Set(
            adapter.replacedIn?.(relevant, projectRoot) ?? [],
          );
          const unserved = relevant.filter((f) => !replaced.has(f));
          if (adapter.adoptHint && unserved.length > 0)
            filters.onNote?.({
              reason: "not-adopted",
              tool: adapter.id,
              hint: adapter.adoptHint,
              files: unserved,
            });
          continue;
        }
        files = adapter.fileScoped === false ? undefined : relevant;
      } else if (!adopted(adapter, toolCfg, cwd, projectRoot)) continue;
      for (const chunk of files ? chunkFiles(files) : [undefined]) {
        plan({ cwd, ...(chunk ? { files: chunk } : {}) });
      }
    }
  };

  for (const adapter of ordered) {
    if (filters.disabledTools?.has(adapter.id)) continue;
    // Under --trusted-ref, a run limited to some tools still runs the checks
    // on the run itself, the settings check among them (R16).
    if (
      filters.onlyTools &&
      !filters.onlyTools.has(adapter.id) &&
      !(adapter.everyRun && filters.trusted)
    )
      continue;
    if (
      filters.onlyLayers &&
      !filters.onlyLayers.has(adapter.layer) &&
      !adapter.everyRun
    )
      continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- public API: a caller's config may predate a language or layer
    if (config.layers[adapter.layer]?.enabled === false && !adapter.everyRun)
      continue;
    if (adapter.detect && !adapter.detect(detection, config)) continue;

    // A project-level tool serves no language: it is not gated on detection
    // or on which files changed, and a --lang filter excludes it.
    const projectLevel = adapter.languages.length === 0;
    if (projectLevel && filters.onlyLanguages && !adapter.everyRun) continue;
    const langs = servedLanguages(
      adapter,
      detection,
      config,
      filters.onlyLanguages,
    );
    if (!projectLevel && langs.length === 0) continue;

    const groups = settingsGroups(adapter, config, projectRoot, langs);
    const first = seeds.length;
    for (const group of groups)
      planGroup(adapter, group.langs, group.toolCfg, langs);
    // One tool's tasks in directory order, however its languages split.
    if (groups.length > 1)
      seeds.push(
        ...seeds
          .splice(first)
          .toSorted((a, b) =>
            a.seed.cwd < b.seed.cwd ? -1 : a.seed.cwd > b.seed.cwd ? 1 : 0,
          ),
      );
  }

  const expanded = await Promise.all(
    seeds.map(async ({ adapter, toolConfig, seed }) => {
      const tasks = adapter.expand
        ? await adapter.expand(seed, { ...env, toolConfig })
        : [seed];
      const planned: PlannedTask[] = [];
      // adapter and toolConfig last: an expansion cannot replace them.
      for (const task of tasks) planned.push({ ...task, adapter, toolConfig });
      return planned;
    }),
  );
  return expanded.flat();
}
