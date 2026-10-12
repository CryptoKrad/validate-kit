/**
 * Core contracts shared across the engine. Everything else depends on this file,
 * so it imports nothing from the rest of the package (keeps the dep graph acyclic).
 */

export const LAYERS = [
  "format",
  "lint",
  "type-check",
  "custom-rules",
  "security",
  // Specifications checked against their models: TLA+, Lean, Quint.
  "formal",
  // Checks a project defines for itself: its tests, builds and invariants.
  "behavior",
] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * How much a check costs, which decides where it runs: `fast` on every
 * commit (the `dev` profile), `verify` on a normal run, `deep` only under the
 * `ci` profile.
 */
export const TIERS = ["fast", "verify", "deep"] as const;
export type Tier = (typeof TIERS)[number];

export const LANGUAGES = [
  "ts",
  "js",
  "rust",
  "go",
  "python",
  "shell",
  "sql",
  "solidity",
] as const;
export type Language = (typeof LANGUAGES)[number];

/** How a language is recognised. Adding a language is one id plus one row. */
export interface LanguageSpec {
  /** File extensions, lower-case, with the dot. */
  readonly extensions: readonly string[];
  /**
   * Files whose directory is the spawn root for the language's tools (clippy
   * must run in the Cargo crate dir, etc.). None found = the project root.
   */
  readonly markers: readonly string[];
  /**
   * Checked only by a tool the repository chose (squawk for SQL): a file of
   * it that no tool takes is not source the run failed to route.
   */
  readonly optIn?: boolean;
}

export const LANGUAGE_SPECS: Record<Language, LanguageSpec> = {
  ts: {
    extensions: [".ts", ".tsx", ".cts", ".mts"],
    markers: ["tsconfig.json"],
  },
  js: {
    extensions: [".js", ".jsx", ".cjs", ".mjs"],
    markers: ["package.json"],
  },
  rust: { extensions: [".rs"], markers: ["Cargo.toml"] },
  go: { extensions: [".go"], markers: ["go.mod"] },
  python: {
    extensions: [".py", ".pyi"],
    markers: ["pyproject.toml", "setup.py", "setup.cfg"],
  },
  // shellcheck's dialects; not .zsh, which it cannot check
  // (docs/research/lint-toolchain/shellcheck-cli.md).
  shell: {
    extensions: [".sh", ".bash", ".ksh", ".dash", ".bats"],
    markers: [],
  },
  // squawk's input, of which only migrations are passed
  // (docs/research/lint-toolchain/squawk-cli.md, 4).
  sql: { extensions: [".sql"], markers: [], optIn: true },
  // Slither's input; it compiles the whole project, from the Foundry or
  // Hardhat root.
  solidity: {
    extensions: [".sol"],
    markers: [
      "foundry.toml",
      "hardhat.config.js",
      "hardhat.config.ts",
      "hardhat.config.cjs",
      "hardhat.config.mjs",
    ],
  },
};

export type Severity = "error" | "warning" | "info" | "hint";

/** A single normalized issue, regardless of which tool produced it. */
export interface Finding {
  tool: string;
  layer: Layer;
  /** Absent when the file belongs to no language (a spec, a lockfile, a directory). */
  language?: Language;
  /** Absolute, forward-slash path. */
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  ruleId?: string;
  severity: Severity;
  message: string;
  fixable: boolean;
  url?: string;
  /**
   * The config file the tool used for this finding, absolute and
   * forward-slash, when the kit knows it: `tools.<id>.configPath`, or what
   * the adapter names (ESLint's flat config nearest the file, tsc's project).
   * A repository's own gate may use another (R11 row 9).
   */
  config?: string;
  /**
   * Accepted debt: within the count `validate.baseline.json` records for its
   * file and rule. It does not decide the exit code.
   */
  baselined?: boolean;
}

/** What the runner hands an adapter for one invocation. */
export interface ToolContext {
  /** Directory to spawn the tool in (a language root). */
  cwd: string;
  /** Explicit file list (changed-file mode). Undefined = whole project under cwd. */
  files?: string[];
  fix: boolean;
  /** Tool-specific config path override (from validate config). */
  configPath?: string;
  /** Whatever the adapter's own `expand` attached to this task. */
  options?: unknown;
  /** Extra pass-through args (from validate config). */
  extraArgs: string[];
  /**
   * A new private directory for the task's scratch files, set by the runner,
   * which removes it when the run ends (also after a timeout).
   */
  tempDir?: () => string;
}

/** Resolved vulnAudit gate config (opt-in; osv-scanner). */
export interface VulnAuditConfig {
  enabled: boolean;
  /** Dirs/lockfiles to scan recursively (relative to project root). */
  scanPaths: string[];
  /** Single global osv-scanner.toml (avoids the no-propagation footgun). */
  configFile?: string;
  /** --offline-vulnerabilities for air-gapped runs. */
  offline: boolean;
}

/** Resolved apiDiff gate config (opt-in; oasdiff breaking-change gate). */
export interface ApiDiffConfig {
  enabled: boolean;
  /** OpenAPI spec paths (relative to project root); one task per spec. */
  specs: string[];
  /** Git ref holding the base spec to diff against. */
  baseRef: string;
}

/** One unit of planned work, before the adapter has had its say. */
export interface TaskSeed {
  cwd: string;
  files?: string[];
  options?: unknown;
  /**
   * Planned but impossible here, and why (TypeScript in no tsconfig project,
   * dependencies not installed). Never spawned, and treated as a missing
   * tool: incomplete (exit 3) with the reason, except an optional tool
   * outside `ci`, which is listed as skipped.
   */
  cannotRun?: string;
}

/** What an adapter may read while expanding a seed. */
export interface PlanEnv {
  config: ResolvedConfig;
  projectRoot: string;
  /**
   * Every file in the validation scope (absolute, POSIX, sorted), also in a
   * changed-file run: for a tool that finds its own inputs.
   */
  scopedFiles: readonly string[];
  /**
   * Set in changed-file runs (--staged, --changed, --since): every path the
   * change touched, relative to the project root, POSIX separators,
   * deletions included, not limited to the validation scope.
   */
  changedPaths?: readonly string[];
  /**
   * Which changed-file run this is: `staged` judges the index (the commit),
   * the others the working tree.
   */
  changedMode?: "staged" | "changed" | "since";
  /** Set under --trusted-ref: where the config was read from. */
  trusted?: TrustedPolicy;
  /**
   * The run's own config file in the work tree (absolute, POSIX), when it
   * has one: the kit loads it, so no project needs to cover it.
   */
  configFile?: string;
  /**
   * The expanding tool's own settings: `tools.<id>` merged with the served
   * language's, `configPath` absolute (the planner's precedence, in one place).
   */
  toolConfig: ToolConfig;
}

/**
 * The commit a run's config was read from (--trusted-ref), which the `policy`
 * tool compares the project's settings files against.
 */
export interface TrustedPolicy {
  /** Full object id. */
  commit: string;
  /** The config file, relative to the project root, POSIX separators. */
  configFile: string;
  /** The work tree's root, as git reports it. */
  top: string;
  /** The project root's path inside the work tree: `""`, or ending in "/". */
  prefix: string;
}

/**
 * A statement about the project that must stay true, tied to what proves it.
 * Plain data, so a JSON config can carry it; it runs as the gate `inv:<id>`.
 */
export interface Invariant {
  /** Short and stable, e.g. "JOB-001". */
  id: string;
  /** What must stay true, in plain words. */
  statement: string;
  /**
   * Globs relative to the project root (`!pattern` excludes): in a
   * changed-file run, the check runs only when a matching path changed.
   */
  covers?: string[];
  /** Spec or test files that must exist. */
  evidence?: string[];
  /** Shell command run at the project root; exit 0 = it holds. */
  check?: string;
  /** Text the check's output must contain (defeats a run that tested nothing). */
  expect?: string;
  /**
   * Default "fast" when it has `covers` or no `check` (cheap enough for every
   * commit), else "verify".
   */
  tier?: Tier;
}

export interface BuiltCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** Override the spawn cwd (defaults to ToolContext.cwd). */
  cwd?: string;
  /**
   * Exit codes that are NOT a crash. Linters typically exit 1 when they find
   * issues — that is a normal result, not an adapter failure. "any" hands
   * every exit code to parseOutput (a command whose exit code IS the verdict).
   */
  okExitCodes?: number[] | "any";
  /**
   * The command forks (a shell line): run it in its own process group so a
   * timeout stops everything it started.
   */
  processGroup?: boolean;
}

export interface RawOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the binary could not be spawned at all. */
  spawnError?: boolean;
  /** True when the process was killed by the run timeout (distinct from spawnError). */
  timedOut?: boolean;
}

export interface RunResult {
  findings: Finding[];
  filesProcessed: number;
  fixesApplied: number;
  rawExitCode: number;
  stderr: string;
}

export interface AvailabilityResult {
  available: boolean;
  version?: string;
  minVersion: string;
  installHint: string;
  /** Why a binary that exists cannot run: its version command failed. */
  problem?: string;
}

export interface DetectedLanguage {
  lang: Language;
  /** Directories containing this language's marker file (tool spawn dirs). */
  roots: string[];
  markerFiles: string[];
}
export type Detection = Map<Language, DetectedLanguage>;

/**
 * A tool integration. Mostly declarative + two pure functions (buildArgs,
 * parseOutput). The runner owns execution, concurrency and availability checks.
 */
export interface ToolAdapter {
  readonly id: string;
  readonly layer: Layer;
  /**
   * Languages the tool serves. Empty = a project-level tool: planned once at
   * the project root, with no file list, whatever languages are detected.
   */
  readonly languages: readonly Language[];
  readonly bin: string;
  readonly supportsFix: boolean;
  /** Does --fix mutate files in place (formatters, ruff --fix)? Drives the per-root fix mutex. */
  readonly fixWriteBack: boolean;
  readonly minVersion: string;
  readonly installHint: string;
  /** May legitimately be absent without failing a run (warned, not exit-3). */
  readonly optional?: boolean;
  /** Default "fast": the tool runs under every profile. */
  readonly tier?: Tier;
  /**
   * Runs from its language's marker (Cargo.toml, go.mod) and only there: a
   * crate or module tool. Files outside every marker are named in a note,
   * not checked; with no marker at all it plans nothing.
   */
  readonly rootedAtMarker?: boolean;
  /**
   * Planned whatever `--layer`, `--lang` and the config's layer switches
   * select, and under --trusted-ref whatever `--only` selects too (only
   * `--disable` and `tools.<id>.enabled` drop it): a check on the run itself,
   * not on a language. It never counts as the selected work unless named with
   * `--only`.
   */
  readonly everyRun?: boolean;
  /**
   * Runs, and is probed, before every other tool: it reads the tree before
   * any project code (a config file a tool executes) can change it.
   */
  readonly runsFirst?: boolean;
  /** Kill the tool after this long and report a crash. Default 240 000 ms. */
  readonly timeoutMs?: number;
  /**
   * Plain data that decides what this tool checks, when that lives in a
   * closure rather than in the functions' source (a command gate's command).
   * It is hashed into the run's config digest.
   */
  readonly policy?: unknown;
  /** Args to print the version. Default ["--version"]. */
  readonly versionArgs?: readonly string[];
  /**
   * Exit codes of the version command that mean the tool works. Default
   * [0]: a broken shim (mise's "not a valid shim") exits otherwise, and its
   * error text must not be read as a version.
   */
  readonly versionExitCodes?: readonly number[];
  /** Extract a semver from `--version` stdout. Default: first x.y.z match. */
  parseVersion?(stdout: string): string | undefined;
  /**
   * Where the tool is spawned: once per language root (default) or once at
   * the project root (tools that scan every language in one pass).
   */
  readonly runsAt?: "language-root" | "project-root";
  /**
   * Does the tool take an explicit file list (default true)? False for tools
   * that read their own project, crate or module and ignore file arguments.
   */
  readonly fileScoped?: boolean;
  /**
   * Tool-specific relevance, beyond what the planner already requires (an
   * enabled layer and at least one detected, enabled language it serves).
   */
  detect?(detection: Detection, config: ResolvedConfig): boolean;
  /**
   * Turn one planned seed into the tasks to run: attach options, fan out
   * (one task per spec, per model), or return [] when there is nothing to do
   * for this seed. Without it the seed runs as is. It may ask a tool what it
   * would cover (tsc's file lists), hence a promise.
   */
  expand?(seed: TaskSeed, env: PlanEnv): TaskSeed[] | Promise<TaskSeed[]>;
  buildArgs(ctx: ToolContext): BuiltCommand;
  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult;
  /**
   * Exit codes that mean "findings reported"
   * (docs/research/lint-toolchain/exit-codes-and-json-shapes.md). Such an exit
   * whose output yields no finding is a crash: the output changed, or the
   * parser fell behind it.
   */
  readonly findingExitCodes?: readonly number[];
  /**
   * Why the tool cannot run with these `extraArgs`, if it cannot: a
   * combination that breaks what the kit reads is a config error (exit 2)
   * before anything runs, not a crash of the tool.
   */
  refuseArgs?(extraArgs: readonly string[]): string | undefined;
  /**
   * A finding that stops the tool from checking the rest (a file that does
   * not compile or parse): in a staged run it still gates when it is in a
   * file the commit does not stage, since the commit was not checked past it.
   */
  masks?(finding: Finding): boolean;
  /**
   * For a tool that serves no language: the file extensions it reads from
   * the scope (".tla"), so a scope holding only those still has work.
   */
  inputs?: readonly string[];
  /**
   * false: the command is a script that runs the tool by name (or the system
   * git or sh), so `tools.<id>.bin` cannot choose it and is a config error.
   */
  binSetting?: false;
  /**
   * For a formatter: whether the repository adopted it at `root`, looking
   * from `root` up to `projectRoot`. Where it did not, the tool is not
   * planned, unless `tools.<id>.enabled` is true.
   */
  adoptedAt?(root: string, projectRoot: string): boolean;
  /**
   * Of `files`, those another tool does this one's job for (Biome formats
   * them): the "not adopted" note does not ask for this one there.
   */
  replacedIn?(files: readonly string[], projectRoot: string): readonly string[];
  /**
   * How a repository adopts this tool. With it, the files it would have
   * checked where it was not adopted are named in a `not-adopted` note;
   * without it another tool checks them (gofmt where gofumpt is not
   * configured).
   */
  readonly adoptHint?: string;
  /** The config file this tool used for `finding`, when the tool decides it. */
  configFor?(finding: Finding, ctx: ToolContext): string | undefined;
}

// ---------- Configuration ----------

export type PresetName = "recommended" | "strict" | "security" | "ci";

export interface ToolConfig {
  enabled?: boolean;
  configPath?: string;
  /**
   * The tool's executable instead of the one the kit finds (a project
   * dependency, then the kit's own copy, then PATH): a path, relative to the
   * project root, or a command name looked up on PATH only.
   */
  bin?: string;
  extraArgs?: string[];
  /** Blanket severity for this tool's findings. */
  severity?: Severity;
  /** Overrides the tool's own timeout. */
  timeoutMs?: number;
  /**
   * Settings for the tool itself, whose shape the adapter defines; its
   * `expand` reads them from `env.config.tools[id].options`.
   */
  options?: unknown;
}

export interface LangConfig {
  enabled?: boolean;
  tools?: Record<string, ToolConfig>;
}

export interface LayerConfig {
  enabled?: boolean;
}

export interface SeverityOverride {
  tool: string;
  ruleId: string;
  severity: Severity | "off";
}

/** User-authored config (everything optional). */
export interface ValidateConfig {
  extends?: PresetName | PresetName[];
  languages?: Partial<Record<Language, LangConfig>>;
  /**
   * Per-tool config by tool id. The home for tools that serve no language;
   * for the rest, `languages.<lang>.tools.<id>` overrides it.
   */
  tools?: Record<string, ToolConfig>;
  /**
   * This project's own tools, beside the built-in ones. Only a JS/TS config
   * can carry them (an adapter has functions); see `commandGate` for wrapping
   * a command.
   */
  adapters?: ToolAdapter[];
  /** Statements that must stay true; see `Invariant`. */
  invariants?: Invariant[];
  layers?: Partial<Record<Layer, LayerConfig>>;
  include?: string[];
  ignore?: string[];
  /**
   * Source files larger than this many bytes are out of scope (reported as
   * info). Default 1,048,576; 0 turns the limit off.
   */
  maxFileBytes?: number;
  /** Leave out minified files (reported as info). Default true. */
  skipMinified?: boolean;
  astGrep?: { ruleDirs?: string[]; ruleIds?: string[]; sgconfig?: string };
  vulnAudit?: Partial<VulnAuditConfig>;
  apiDiff?: Partial<ApiDiffConfig>;
  concurrency?: number;
  severityOverrides?: SeverityOverride[];
  /** Semver range of kits this config was written for; another kit is exit 2. */
  kitVersion?: string;
  /**
   * Globs (relative to the project root) of the files that set what the
   * tools check. Under --trusted-ref, each one that differs from the trusted
   * commit is an error. Replaces the default list.
   */
  policyFiles?: string[];
}

/** Fully-resolved, frozen config the runner consumes. */
export interface ResolvedConfig {
  languages: Record<Language, LangConfig>;
  tools: Record<string, ToolConfig>;
  adapters: ToolAdapter[];
  invariants: Invariant[];
  layers: Record<Layer, LayerConfig>;
  include: string[];
  ignore: string[];
  maxFileBytes: number;
  skipMinified: boolean;
  astGrep: { ruleDirs: string[]; ruleIds: string[]; sgconfig?: string };
  vulnAudit: VulnAuditConfig;
  apiDiff: ApiDiffConfig;
  concurrency: number;
  severityOverrides: SeverityOverride[];
  policyFiles: string[];
}

export function defineConfig(config: ValidateConfig): ValidateConfig {
  return config;
}

/** Files a run does not check, and why: reported (info), never dropped unseen. */
export type ScopeNote =
  | {
      /** In a folder that is out of scope by default (archive/, logs/ …). */
      reason: "default-ignored";
      folders: string[];
      files: string[];
    }
  | {
      /** Outside every crate or module, where these tools cannot run. */
      reason: "no-marker";
      lang: Language;
      marker: string;
      tools: string[];
      files: string[];
    }
  | {
      /** Larger than `maxFileBytes`. */
      reason: "oversized";
      limit: number;
      files: string[];
    }
  | {
      /** A `.min.` name, or lines no one writes by hand. */
      reason: "minified";
      files: string[];
      /** For each file, what gave it away ("line 12 is over 10000 bytes"). */
      why?: string[];
    }
  | {
      /** A formatter the repository has not adopted. */
      reason: "not-adopted";
      tool: string;
      hint: string;
      files: string[];
    };
