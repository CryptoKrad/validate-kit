import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";
import { hookIndex, run } from "../core/exec.js";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toolAdopted } from "../detect/adoption.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, parseFindings } from "./base.js";

/**
 * One gitleaks finding (docs/research/lint-toolchain/gitleaks-cli.md, 2).
 * `Match`, `Secret`, `Line` and `Description` are never read: with
 * `--redact` they still hold context around the secret.
 */
interface Leak {
  RuleID: string;
  File: string;
  StartLine: number;
  StartColumn: number;
  Secret: string;
}

interface GitleaksTask {
  /** `git --staged`: the index, the commit a hook judges. */
  staged: boolean;
  /**
   * The project root's path inside the work tree (`""`, or ending in "/"):
   * `git --staged` reports paths, and reads `.gitleaksignore` entries, from
   * the work tree's root.
   */
  prefix: string;
  /** A changed-file run's files (absolute, POSIX); absent in a full run. */
  changed?: string[];
  /** Paths git ignores, relative to the project root, for `dir`. */
  ignored: string[];
  /** The project's own config. */
  projectConfig?: string;
  /**
   * It extends another file: gitleaks follows two levels of `[extend]`, so a
   * generated config on top would lose the default rules (gitleaks-cli.md, 5).
   */
  extendsPath: boolean;
  /** The kit's `ignore` globs (fixtures, generated code). */
  ignore: string[];
}

const COMMON = [
  "--no-banner",
  "--log-level",
  "error",
  "--no-color",
  "--redact",
  "--report-format",
  "json",
  "--report-path",
  "-",
  // Not 1, which gitleaks also exits with on errors (gitleaks-cli.md, 3).
  "--exit-code",
  "3",
];

const reEscape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A config that extends the project's (or the default rules) and skips what
 * git ignores, so `dir` walks the files git would add, not build output
 * (gitleaks-cli.md, 5). The path regexes match the walked path, relative to
 * `.`; the project's config is no longer "the config", so it is skipped too.
 */
function scopeConfig(task: GitleaksTask): string {
  const paths = [
    ...task.ignored.map(
      (path) => `^${reEscape(path.replace(/\/$/, ""))}(?:/|$)`,
    ),
    String.raw`(?:^|/)\.gitleaks\.toml$`,
  ];
  return [
    "[extend]",
    task.projectConfig
      ? `path = '''${task.projectConfig}'''`
      : "useDefault = true",
    "",
    "[[allowlists]]",
    'description = "validate-kit: what git ignores"',
    "paths = [",
    ...paths.map((path) => `  '''${path}''',`),
    "]",
    "",
  ].join("\n");
}

/**
 * The project's `.gitleaksignore` with its paths from the work tree's root,
 * as `git --staged` reports them. A `commit:file:rule:line` entry is left
 * as it is: a staged finding has no commit.
 */
function prefixedIgnore(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.trim() === "" ||
      line.startsWith("#") ||
      /^[0-9a-f]{7,40}:/.test(line)
        ? line
        : prefix + line,
    )
    .join("\n");
}

/** gitleaks — secrets in the files a commit or a run covers. */
export const gitleaks: ToolAdapter = {
  id: "gitleaks",
  layer: "security",
  languages: [],
  runsAt: "project-root",
  fileScoped: false,
  bin: "gitleaks",
  versionArgs: ["version"],
  supportsFix: false,
  fixWriteBack: false,
  optional: true,
  // [[allowlists]], and baselines that work with --redact (gitleaks-cli.md, 6).
  minVersion: "8.25.0",
  installHint: "brew install gitleaks",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  findingExitCodes: [3],

  async expand(seed: TaskSeed, env: PlanEnv): Promise<TaskSeed[]> {
    const root = env.projectRoot;
    // A project-level tool: the planner checks no adoption for it.
    // Chosen for the whole tree: in the kit's config or by gitleaks' own
    // files. A task or hook step that runs it is a choice to scan changes:
    // a full run on it would report every secret already committed, which
    // that step never read (dark-visitor, 2026-10-10: 83 on upgrade).
    const wholeTree =
      env.toolConfig.enabled === true ||
      env.toolConfig.configPath !== undefined ||
      toolAdopted(root, root, {
        configs: [".gitleaks.toml", ".gitleaksignore"],
      });
    const changesOnly =
      env.changedPaths !== undefined &&
      toolAdopted(root, root, { configs: [], step: /\bgitleaks\b/ });
    // Any file a change touched, in or out of the kit's scope: a secret in
    // `.env` or a minified bundle is still a secret.
    if (!(wholeTree || changesOnly) || env.changedPaths?.length === 0)
      return [];
    const staged = env.changedMode === "staged";
    const git = async (args: string[]): Promise<string | undefined> => {
      const raw = await run("git", args, { cwd: root, timeoutMs: 60_000 });
      return raw.spawnError || raw.exitCode !== 0 ? undefined : raw.stdout;
    };
    const prefix = staged ? await git(["rev-parse", "--show-prefix"]) : "";
    if (prefix === undefined)
      throw new Error(
        "gitleaks: git cannot place the project in its work tree",
      );
    const projectConfig =
      env.toolConfig.configPath ??
      (existsSync(join(root, ".gitleaks.toml"))
        ? join(root, ".gitleaks.toml")
        : undefined);
    let extendsPath = false;
    if (projectConfig) {
      try {
        const extend = (
          parseToml(readFileSync(projectConfig, "utf8")) as {
            extend?: { path?: unknown };
          }
        ).extend;
        extendsPath = typeof extend?.path === "string";
      } catch {
        // gitleaks reports a config it cannot read itself.
      }
    }
    const task: GitleaksTask = {
      staged,
      prefix: prefix.trim(),
      ...(env.changedPaths && !staged
        ? {
            changed: env.changedPaths.map((path) => toPosix(join(root, path))),
          }
        : {}),
      // Outside a repository nothing is pruned: `dir` walks every file.
      ignored: staged
        ? []
        : (
            (await git([
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
              "--directory",
              "-z",
            ])) ?? ""
          )
            .split("\0")
            .filter((path) => path !== ""),
      ...(projectConfig ? { projectConfig } : {}),
      extendsPath,
      ignore: [...env.config.ignore],
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs(extraArgs) {
    for (const [i, arg] of extraArgs.entries()) {
      const level =
        arg === "-l" || arg === "--log-level"
          ? extraArgs[i + 1]
          : /^(?:-l=?|--log-level=)(.+)$/i.exec(arg)?.[1];
      if (level !== undefined && /^(?:trace|debug)$/i.test(level))
        return `--log-level ${level} prints secrets unredacted on stderr`;
      if (arg === "-v" || arg === "--verbose")
        return "--verbose prints each finding on stdout, which holds the kit's JSON report";
      const redact = /^--redact=(\d+)$/.exec(arg)?.[1];
      if (redact !== undefined && Number(redact) < 100)
        return `--redact=${redact} leaves part of each secret in the report`;
      if (/^--max-target-megabytes(=|$)/.test(arg))
        return "--max-target-megabytes skips larger files without a finding";
      if (
        /^(?:-b|-f|--report-path|--report-format|--report-template|--exit-code|--baseline-path)(?:=|$)/.test(
          arg,
        ) ||
        /^-[bf]./.test(arg)
      )
        return `the kit sets ${arg.split("=")[0]}: it reads gitleaks' JSON report and exit code`;
    }
    return undefined;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as GitleaksTask;
    const scratch = (): string => {
      if (!ctx.tempDir) throw new Error("gitleaks needs a scratch folder");
      return ctx.tempDir();
    };
    let args: string[];
    if (task.staged) {
      args = ["git", "--staged", ...COMMON];
      if (ctx.configPath) args.push("--config", ctx.configPath);
      const own = join(ctx.cwd, ".gitleaksignore");
      if (task.prefix !== "" && existsSync(own)) {
        const ignore = join(scratch(), ".gitleaksignore");
        writeFileSync(
          ignore,
          prefixedIgnore(readFileSync(own, "utf8"), task.prefix),
        );
        args.push("--gitleaks-ignore-path", ignore);
      }
    } else if (task.extendsPath && task.projectConfig) {
      // What git ignores is dropped after the scan instead.
      args = ["dir", ...COMMON, "--config", task.projectConfig];
    } else {
      const config = join(scratch(), "git-scope.toml");
      writeFileSync(config, scopeConfig(task));
      args = ["dir", ...COMMON, "--config", config];
    }
    args.push(...ctx.extraArgs, ".");
    return {
      bin: this.bin,
      args,
      okExitCodes: [0, 3],
      // A config named by the environment would replace the project's; a
      // staged scan reads the index the hook's commit is made from.
      env: {
        GITLEAKS_CONFIG: "",
        GITLEAKS_CONFIG_TOML: "",
        ...(task.staged ? hookIndex() : {}),
      },
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // git failures exit 0 with nothing scanned (gitleaks-cli.md, 3).
    const failure = raw.stderr
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
      .split("\n")
      .find((line) => /\b(ERR|FTL)\b/.test(line));
    if (failure)
      throw new Error(`gitleaks reported an error: ${failure.trim()}`);
    const task = ctx.options as GitleaksTask;
    const { items } = parseFindings<Leak>("gitleaks", raw);
    const changed = task.changed ? new Set(task.changed) : undefined;
    const ignoredByKit = picomatch(task.ignore, { dot: true });
    const ignoredByGit = (rel: string): boolean =>
      task.ignored.some((path) =>
        path.endsWith("/") ? rel.startsWith(path) : rel === path,
      );
    const cwd = toPosix(ctx.cwd);
    const findings = items.flatMap((leak) => {
      if (
        typeof leak.RuleID !== "string" ||
        typeof leak.File !== "string" ||
        !Number.isInteger(leak.StartLine) ||
        leak.StartLine < 0
      )
        throw new Error(
          "gitleaks output has a finding without a rule, file or line: its output format may have changed; refusing to report it.",
        );
      // The guard that redaction is on; the value itself is never echoed.
      if (leak.Secret !== "REDACTED")
        throw new Error(
          "gitleaks output holds an unredacted secret: refusing to report it.",
        );
      // `git --staged .` scans the project's folder, named from the root.
      const rel = task.staged
        ? posix.relative(task.prefix, toPosix(leak.File))
        : toPosix(leak.File);
      const file = absPosix(cwd, rel);
      if (
        (changed && !changed.has(file)) ||
        ignoredByKit(rel) ||
        (task.extendsPath && ignoredByGit(rel))
      )
        return [];
      return [
        finding({
          tool: "gitleaks",
          layer: "security",
          file,
          line: leak.StartLine,
          col: typeof leak.StartColumn === "number" ? leak.StartColumn : 1,
          ruleId: leak.RuleID,
          severity: "error",
          message: `Possible secret (${leak.RuleID}): remove and rotate it, or mark a false positive (gitleaks:allow, .gitleaksignore).`,
          fixable: false,
        }),
      ];
    });
    return {
      findings,
      filesProcessed: changed?.size ?? 1,
      fixesApplied: 0,
      // Every leak was outside the run: a clean result, not a lost report.
      rawExitCode: findings.length === 0 ? 0 : raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
