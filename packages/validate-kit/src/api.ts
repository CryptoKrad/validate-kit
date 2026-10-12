import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { policy } from "./adapters/policy.js";
import { ConfigError } from "./config/schema.js";
import { configFileOf, resolveConfig } from "./config/resolve.js";
import {
  applyBaseline,
  loadBaseline,
  relativeTo,
  type Baseline,
} from "./core/baseline.js";
import { collectEvidence } from "./core/evidence.js";
import { getKitRoot } from "./core/paths.js";
import {
  validateChangedMode,
  profileRunsTier,
  profileSettings,
  validateCheckFilters,
  validateConcurrency,
  validateProfile,
  type ValidationProfile,
} from "./core/options.js";
import { buildPlan, type PlanFilters, type PlannedTask } from "./core/plan.js";
import { resolveProjectRoot } from "./core/project-root.js";
import {
  execute,
  exitCodeOf,
  isGating,
  mergeSummaries,
  type RunScope,
  type RunSummary,
} from "./core/runner.js";
import { finding } from "./adapters/base.js";
import type {
  Detection,
  Finding,
  ScopeNote,
  Language,
  Layer,
  ResolvedConfig,
  ToolAdapter,
  TrustedPolicy,
} from "./core/types.js";
import { changedSet, unstagedOnly, type ChangedMode } from "./detect/git.js";
import {
  detectFromFiles,
  isSourceFile,
  listScopedFiles,
  scanScope,
  miscasedSource,
  toPosix,
} from "./detect/languages.js";

export type { ValidationProfile } from "./core/options.js";

export interface CheckOptions {
  cwd?: string;
  fix?: boolean;
  changedMode?: ChangedMode;
  since?: string;
  layers?: Layer[];
  languages?: Language[];
  onlyTools?: string[];
  disabledTools?: string[];
  configPath?: string;
  /**
   * Read the config from this commit instead of the work tree, and report
   * every tool settings file that differs from it (the `policy` tool).
   */
  trustedRef?: string;
  profile?: ValidationProfile;
  concurrency?: number;
  /**
   * Attach run evidence (commit, dirty flag, config digest, kit version) to
   * the summary. Off by default: it costs a `git status` per run.
   */
  evidence?: boolean;
}

export interface CheckResult {
  summary: RunSummary;
  detection: Detection;
  tasks: PlannedTask[];
  projectRoot: string;
  scope: RunScope;
  configSource?: string;
  /** Set when the config was read from a commit (--trusted-ref). */
  trusted?: TrustedPolicy;
  /** Files the run does not check, and why; a full run reports them (info). */
  notes: ScopeNote[];
}

interface PlannedCheck extends Omit<CheckResult, "summary"> {
  config: ResolvedConfig;
  /** Files a changed-file run looks at, relative to the root. */
  checkedFiles?: ReadonlySet<string>;
}

/**
 * The fixtures profile scopes to the kit's intentionally-bad seeded fixtures
 * (samples/ inside the kit source, services/ at its repo root). Those trees
 * are dev-only — they don't ship in the npm package — so the paths are
 * DERIVED from getKitRoot() and the profile fails with a clear message when
 * they aren't inside the project being validated (any consumer repo).
 */
function fixturesInclude(projectRoot: string): string[] {
  const kitRoot = getKitRoot();
  const root = toPosix(resolve(projectRoot));
  const candidates = [
    resolve(kitRoot, "samples"),
    resolve(dirname(dirname(kitRoot)), "services"),
  ];
  const within = candidates.filter((dir) => {
    const posix = toPosix(dir);
    return existsSync(dir) && (posix === root || posix.startsWith(`${root}/`));
  });
  if (within.length === 0) {
    throw new ConfigError(
      `The fixtures profile validates validate-kit's own seeded fixture trees (samples/, services/), which are not present under ${projectRoot}. It only applies inside the validate-kit source repo — use the default or ci profile here.`,
    );
  }
  return within.map((dir) =>
    toPosix(relative(resolve(projectRoot), dir) || "."),
  );
}

function configForProfile(
  config: ResolvedConfig,
  profile: ValidationProfile,
  projectRoot: string,
): ResolvedConfig {
  if (profile !== "fixtures") return config;
  return {
    ...config,
    include: fixturesInclude(projectRoot),
    ignore: [],
  };
}

function configForRun(
  config: ResolvedConfig,
  opts: CheckOptions,
  profile: ValidationProfile,
  projectRoot: string,
): ResolvedConfig {
  const profiled = configForProfile(config, profile, projectRoot);
  if (opts.concurrency === undefined) return profiled;
  return { ...profiled, concurrency: opts.concurrency };
}

function changedModeFor(opts: CheckOptions): ChangedMode | undefined {
  const mode = validateChangedMode(opts.changedMode);
  if (mode) return mode;
  if (opts.since) return "since";
  return opts.profile && profileSettings(opts.profile).changedByDefault
    ? "changed"
    : undefined;
}

function hasExplicitPlanFilters(opts: CheckOptions): boolean {
  return (
    (opts.layers?.length ?? 0) > 0 ||
    (opts.languages?.length ?? 0) > 0 ||
    (opts.onlyTools?.length ?? 0) > 0 ||
    (opts.disabledTools?.length ?? 0) > 0
  );
}

function hasConfiguredScope(config: ResolvedConfig): boolean {
  return config.include.length > 0 || config.ignore.length > 0;
}

function sourceFiles(files: readonly string[]): string[] {
  return files.filter(isSourceFile);
}

function hasConfiguredExecutionDisablers(config: ResolvedConfig): boolean {
  return (
    Object.values(config.layers).some((cfg) => cfg.enabled === false) ||
    Object.values(config.languages).some(
      (cfg) =>
        cfg.enabled === false ||
        Object.values(cfg.tools ?? {}).some(
          (toolCfg) => toolCfg.enabled === false,
        ),
    )
  );
}

async function hasUnscopedLanguageFiles(projectRoot: string): Promise<boolean> {
  const files = await listScopedFiles(projectRoot);
  return files.some(isSourceFile);
}

/**
 * What runs before planning reaches the project's own code: planning may run
 * it (tsc lists what each project covers).
 */
type BeforeProjectCode = (early: {
  projectRoot: string;
  config: ResolvedConfig;
  trusted: TrustedPolicy | undefined;
  scope: RunScope;
  /** The tasks that read the tree as the patch left it (the policy check). */
  first: PlannedTask[];
}) => Promise<void>;

async function plan(
  opts: CheckOptions,
  beforeProjectCode?: BeforeProjectCode,
): Promise<PlannedCheck> {
  const projectRoot = resolveProjectRoot(opts.cwd);
  const profile = validateProfile(opts.profile) ?? "default";
  const concurrency = validateConcurrency(opts.concurrency);
  // The config comes first: it can add tools, and --only/--disable must be
  // able to name them.
  const resolved = await resolveConfig(
    projectRoot,
    opts.configPath,
    opts.trustedRef,
  );
  const validatedFilters = validateCheckFilters(
    {
      layers: opts.layers,
      languages: opts.languages,
      disabledTools: opts.disabledTools,
      onlyTools: opts.onlyTools,
    },
    resolved.adapters.map((adapter) => adapter.id),
  );
  // Under --trusted-ref the settings check is the trusted policy's; a flag
  // cannot drop it (the trusted config can: tools.policy.enabled).
  if (
    resolved.trusted &&
    validatedFilters.disabledTools?.includes(policy.id) &&
    resolved.config.tools[policy.id]?.enabled !== false
  ) {
    throw new ConfigError(
      `--disable ${policy.id} with --trusted-ref: the work tree's settings would judge the run while it claims the trusted policy. Drop the flag, or turn the check off in the trusted commit's config (tools.${policy.id}.enabled: false).`,
    );
  }
  const config = configForRun(
    resolved.config,
    { ...opts, ...(concurrency ? { concurrency } : {}) },
    profile,
    projectRoot,
  );
  const scopeConfig = {
    include: config.include,
    ignore: config.ignore,
    maxFileBytes: config.maxFileBytes,
    skipMinified: config.skipMinified,
  };
  const { files: scopedFiles, skipped } = await scanScope(
    projectRoot,
    scopeConfig,
  );
  const scopedSourceFiles = sourceFiles(scopedFiles);
  if (
    scopedSourceFiles.length === 0 &&
    // Models and proofs: a scope holding only these still has work (DV12).
    !scopedFiles.some((file) =>
      resolved.adapters.some((adapter) =>
        adapter.inputs?.some((ext) => file.endsWith(ext)),
      ),
    ) &&
    hasConfiguredScope(config) &&
    (await hasUnscopedLanguageFiles(projectRoot))
  ) {
    throw new ConfigError(
      "Configured include/ignore patterns matched no source files. Adjust include/ignore or remove the scope config.",
    );
  }
  const detection = detectFromFiles(projectRoot, scopedFiles);
  const mode = changedModeFor({ ...opts, profile });

  const filters: PlanFilters = {};
  // One note per language, naming every crate or module tool that cannot
  // reach its files.
  const unrooted = new Map<string, ScopeNote>();
  filters.onNote = (note) => {
    const key =
      note.reason === "no-marker"
        ? note.lang
        : note.reason === "not-adopted"
          ? `${note.reason}:${note.tool}`
          : note.reason;
    const known = unrooted.get(key);
    if (known?.reason === "no-marker" && note.reason === "no-marker")
      known.tools = [...new Set([...known.tools, ...note.tools])].toSorted();
    else if (known?.reason === "not-adopted" && note.reason === "not-adopted")
      known.files = [...known.files, ...note.files];
    else unrooted.set(key, note);
  };
  if (validatedFilters.disabledTools?.length)
    filters.disabledTools = new Set(validatedFilters.disabledTools);
  if (validatedFilters.onlyTools?.length)
    filters.onlyTools = new Set(validatedFilters.onlyTools);
  if (validatedFilters.layers?.length)
    filters.onlyLayers = new Set(validatedFilters.layers);
  if (validatedFilters.languages?.length)
    filters.onlyLanguages = new Set(validatedFilters.languages);
  filters.scopedFiles = scopedFiles;
  if (resolved.trusted) filters.trusted = resolved.trusted;
  const configFile = configFileOf(resolved, projectRoot);
  if (configFile) filters.configFile = configFile;
  if (mode) {
    const scoped = new Set(scopedFiles);
    const changes = await changedSet(projectRoot, mode, opts.since);
    filters.changedFiles = changes.files.filter((file) => scoped.has(file));
    // Unfiltered: a gate's `covers` can watch files outside the validation
    // scope, and deletions.
    filters.changedPaths = changes.paths;
    filters.changedMode = mode;
  }
  // `App.TSX` would reach no tool (oxlint and ast-grep skip it) and the run
  // would still read clean. A changed-file run (the commit hook) asks only
  // about the files it changed; a full run, the gate, about all of them.
  const miscased = (filters.changedFiles ?? scopedFiles).filter(miscasedSource);
  if (miscased.length > 0) {
    throw new ConfigError(
      `${miscased.length} file(s) in scope have a source extension in another case, so no tool checks them (oxlint and ast-grep skip such names): ${miscased
        .slice(0, 5)
        .map((file) => relative(projectRoot, file))
        .join(
          ", ",
        )}. Rename them to the lower-case extension, or add them to ignore.`,
    );
  }

  // A tool named with --only runs whatever its tier: the caller asked for
  // it, and dropping it silently would report a clean run that ran nothing.
  const inProfile = resolved.adapters.filter(
    (adapter) =>
      validatedFilters.onlyTools?.includes(adapter.id) === true ||
      profileRunsTier(profile, adapter.tier),
  );
  const activeFiles = mode ? (filters.changedFiles ?? []) : scopedFiles;
  const scope: RunScope = {
    profile,
    mode: mode ?? "full",
    files: activeFiles.length,
  };
  await beforeProjectCode?.({
    projectRoot,
    config,
    trusted: resolved.trusted,
    scope,
    first: await buildPlan(
      detection,
      config,
      projectRoot,
      inProfile.filter((adapter) => adapter.runsFirst),
      filters,
    ),
  });
  const tasks = await buildPlan(
    detection,
    config,
    projectRoot,
    inProfile,
    filters,
  );
  const activeSourceFiles = sourceFiles(activeFiles);
  // What the caller asked for: a tool that runs in every trusted run (the
  // settings check) counts only when named with --only, so it never stands in
  // for a selection that matched nothing (R16).
  const requested = tasks.filter(
    (task) =>
      !task.adapter.everyRun ||
      validatedFilters.onlyTools?.includes(task.adapter.id) === true,
  );
  // A project-level task serves no language, so on its own it does not count
  // as routing the source files anywhere — unless the caller's filters asked
  // for exactly that tool.
  const routesSources = requested.some(
    (task) => task.adapter.languages.length > 0,
  );
  const sourcesUnrouted =
    requested.length === 0 || (!routesSources && !hasExplicitPlanFilters(opts));
  if (sourcesUnrouted && activeSourceFiles.length > 0) {
    if (hasExplicitPlanFilters(opts)) {
      throw new ConfigError(
        "No validation tasks matched the requested filters. Remove or adjust layer, language, and tool filters.",
      );
    }
    if (hasConfiguredExecutionDisablers(config)) {
      throw new ConfigError(
        "Validate config disables every validation task for the matched source files. Re-enable at least one layer, language, or tool, or adjust include/ignore.",
      );
    }
    // Structural fall-through (no filters, no disablers, yet real source files
    // routed to zero tools). Unreachable today — the project-scoped ast-grep
    // adapter serves every detected language — but if a registry/detection
    // change ever reopens it, "we failed to route real files" must never exit
    // CLEAN.
    throw new ConfigError(
      `${activeSourceFiles.length} source file(s) in scope matched no validation tool — language detection or tool routing is broken for this tree.`,
    );
  }
  if (profileSettings(profile).strict && !mode && requested.length === 0) {
    // A full-scope gate run must vouch for something: an empty plan (no
    // source files, everything ignored or disabled) is a misconfiguration,
    // not a pass. A changed-file run where nothing relevant changed is fine.
    throw new ConfigError(
      "The ci profile planned no validation task: nothing in scope would be checked. Check the path, include/ignore and disabled tools.",
    );
  }
  return {
    detection,
    tasks,
    projectRoot,
    config,
    scope,
    notes: [...skipped, ...unrooted.values()],
    ...(resolved.source ? { configSource: resolved.source } : {}),
    ...(resolved.trusted ? { trusted: resolved.trusted } : {}),
    ...(filters.changedFiles
      ? {
          checkedFiles: new Set(
            filters.changedFiles.map(relativeTo(projectRoot)),
          ),
        }
      : {}),
  };
}

/**
 * Dry-run: detection + which tasks would run, without running the checks.
 * Planning asks the project's tsc which files each TypeScript project covers
 * (`tsc --listFilesOnly`), so it runs that one tool.
 */
export async function planCheck(
  opts: CheckOptions = {},
): Promise<Omit<CheckResult, "summary">> {
  const {
    config: _config,
    checkedFiles: _checked,
    ...planned
  } = await plan(opts);
  return planned;
}

/**
 * A staged run judges the commit, but a tool that reads a whole module or
 * project (golangci-lint, tsc, clippy) reads the working tree, so it also
 * reports on files the commit does not hold: another agent's half-saved file
 * in a shared checkout refused commits that never touched it (dark-visitor,
 * 2026-10-09). Such a tool's finding in a file that had unstaged edits, or was
 * untracked, before the run, and that the commit does not stage, is info: its
 * content is not what the commit holds. Still gating:
 * - a finding in a clean file: that file is what the commit will hold, so a
 *   staged change that breaks it is the commit's;
 * - a finding that stopped the tool checking the rest (`masks`: a file that
 *   does not compile), since the commit was not checked past it;
 * - every finding of a tool that reads only the files it is given, of the
 *   settings check, and of gates.
 * A dirty file can still shift findings in clean files of its package; the
 * full run before a push decides those.
 */
function outsideTheCommit(
  summary: RunSummary,
  elsewhere: ReadonlySet<string>,
  adapters: ReadonlyMap<string, ToolAdapter>,
): RunSummary {
  if (elsewhere.size === 0) return summary;
  const real = new Map<string, string>();
  const realOf = (file: string): string => {
    let path = real.get(file);
    if (path === undefined) {
      try {
        path = toPosix(realpathSync(file));
      } catch {
        path = file;
      }
      real.set(file, path);
    }
    return path;
  };
  // Set inside the callback, which TypeScript's narrowing does not follow.
  let moved = false as boolean;
  const findings = summary.findings.map((item) => {
    const adapter = adapters.get(item.tool);
    if (
      item.baselined ||
      !isGating(item) ||
      adapter?.fileScoped !== false ||
      !elsewhere.has(realOf(item.file))
    )
      return item;
    if (adapter.masks?.(item))
      return {
        ...item,
        message: `${item.message} (in a file this commit does not stage; it stops ${item.tool} from checking the commit)`,
      };
    moved = true;
    return {
      ...item,
      severity: "info" as const,
      message: `${item.message} (in a file with changes this commit does not stage)`,
    };
  });
  if (!moved) return { ...summary, findings };
  const fresh = findings.filter((f) => !f.baselined);
  const failing = new Set(fresh.filter(isGating).map((f) => f.tool));
  return {
    ...summary,
    findings,
    toolStatus: Object.fromEntries(
      Object.entries(summary.toolStatus).map(([tool, status]) => [
        tool,
        status === "fail" && !failing.has(tool) ? "pass" : status,
      ]),
    ),
    exitCode: exitCodeOf(fresh, summary.crashed, summary.incomplete),
  };
}

/** Full run: detect → resolve config → plan → execute. */
function strictFor(scope: RunScope): boolean {
  return profileSettings(validateProfile(scope.profile) ?? "default").strict;
}

/** One info finding for files the run does not check, and why. */
function noteFinding(projectRoot: string, note: ScopeNote): Finding {
  const why = note.reason === "minified" ? note.why : undefined;
  const shown = note.files
    .slice(0, 5)
    .map((file, n) => {
      const rel = relative(projectRoot, file);
      return why?.[n] ? `${rel}: ${why[n]}` : rel;
    })
    .join(", ");
  const listing = `${shown}${note.files.length > 5 ? ", …" : ""}`;
  return finding({
    tool: "scope",
    layer: "lint",
    file: toPosix(resolve(projectRoot)),
    line: 1,
    col: 1,
    ruleId: note.reason,
    severity: "info",
    message: noteMessage(note, listing),
    fixable: false,
  });
}

function noteMessage(note: ScopeNote, listing: string): string {
  const count = note.files.length;
  switch (note.reason) {
    case "default-ignored":
      return `${count} file(s) are out of scope by default, in ${note.folders.map((folder) => `${folder}/`).join(", ")} folders (${listing}). Name the folder in \`include\` to check them.`;
    case "no-marker":
      return `${count} ${note.lang} file(s) are outside every ${note.marker}, so ${note.tools.join(" and ")} cannot check them (${listing}). Put them in a crate or module, or add them to \`ignore\`.`;
    case "oversized":
      return `${count} source file(s) are larger than ${note.limit} bytes and are not checked (${listing}). Raise \`maxFileBytes\`, or set it to 0, to check them.`;
    case "not-adopted":
      return `${count} file(s) are not checked by ${note.tool}: the repository has not adopted it (${listing}). ${note.hint}`;
    case "minified":
      return `${count} source file(s) look minified (a .min. name, or lines no one writes by hand) and are not checked (${listing}). Set \`skipMinified: false\` to check them.`;
  }
}

export async function runCheck(opts: CheckOptions = {}): Promise<CheckResult> {
  // Before any of the project's code runs (planning runs its tsc): the
  // baseline is read, and the policy check compares the tree with the trusted
  // commit. The runner compares it again before and after the other tools.
  const startedAt = Date.now();
  const before: { baseline?: Baseline; early?: RunSummary } = {};
  const planned = await plan(opts, async (early) => {
    before.baseline = await loadBaseline(early.projectRoot, early.trusted);
    if (early.first.length === 0) return;
    before.early = await execute({
      projectRoot: early.projectRoot,
      config: early.config,
      tasks: early.first,
      fix: false,
      scope: early.scope,
      strict: strictFor(early.scope),
    });
  });
  const { baseline, early } = before;
  const strict = strictFor(planned.scope);
  // Before any tool runs: a fix pass rewrites files, which would make clean
  // ones look like another agent's edits.
  const elsewhere =
    planned.scope.mode === "staged"
      ? await unstagedOnly(planned.projectRoot)
      : undefined;
  const run: RunSummary = await execute({
    projectRoot: planned.projectRoot,
    config: planned.config,
    tasks: planned.tasks,
    fix: !!opts.fix,
    scope: planned.scope,
    strict,
    ...(early ? { checkedFirst: true } : {}),
  });
  // The whole run's time: planning lists each TypeScript project's files.
  const durationMs = Date.now() - startedAt;
  const raw = early
    ? mergeSummaries([early, run], durationMs)
    : { ...run, durationMs };
  const judged = baseline
    ? applyBaseline(raw, baseline, {
        projectRoot: planned.projectRoot,
        strict,
        ...(planned.checkedFiles ? { checkedFiles: planned.checkedFiles } : {}),
      })
    : raw;
  const committed = elsewhere
    ? outsideTheCommit(
        judged,
        elsewhere,
        new Map(planned.tasks.map((task) => [task.adapter.id, task.adapter])),
      )
    : judged;
  // A full run says what a default left out of scope (info: it gates
  // nothing, but no file leaves the scope unseen).
  const summary =
    planned.scope.mode === "full" && planned.notes.length > 0
      ? {
          ...committed,
          findings: [
            ...committed.findings,
            ...planned.notes.map((note) =>
              noteFinding(planned.projectRoot, note),
            ),
          ],
        }
      : committed;
  const { config, checkedFiles: _checked, ...result } = planned;
  if (!opts.evidence) return { ...result, summary };
  // Collected after the run: with --fix the tree that was finally judged is
  // the fixed one.
  // What ran, not what was planned: a settings check that could not run
  // (git missing) checked nothing.
  const settings = summary.toolStatus[policy.id];
  const evidence = await collectEvidence(
    planned.projectRoot,
    config,
    planned.trusted,
    settings === "pass" || settings === "fail",
  );
  return { ...result, summary: { ...summary, evidence } };
}
