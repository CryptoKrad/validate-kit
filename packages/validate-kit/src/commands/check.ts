import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import { runCheck } from "../api.js";
import { ConfigError } from "../config/schema.js";
import { resolveProjectRoot } from "../core/project-root.js";
import {
  parseConcurrency,
  validateProfile,
  validateStaticFilters,
  type ValidatedCheckFilters,
} from "../core/options.js";
import { gitState, type ChangedMode } from "../detect/git.js";
import { toJson } from "../report/json.js";
import { renderPretty, renderQuiet } from "../report/pretty.js";
import { toAiJson } from "../report/ai.js";
import { toSarif } from "../report/sarif.js";

export interface CheckFlags {
  fix?: boolean;
  changed?: boolean;
  staged?: boolean;
  since?: string;
  layer?: string[];
  lang?: string[];
  disable?: string[];
  only?: string[];
  json?: boolean;
  sarif?: string;
  aiJson?: string;
  quiet?: boolean;
  concurrency?: string;
  config?: string;
  trustedRef?: string;
  profile?: string;
}

export const parseProfile = validateProfile;
export { parseConcurrency };

export type ParsedCheckFilters = ValidatedCheckFilters;

export function parseCheckFilters(flags: CheckFlags): ParsedCheckFilters {
  return validateStaticFilters({
    layers: flags.layer,
    languages: flags.lang,
    disabledTools: flags.disable,
    onlyTools: flags.only,
  });
}

export function changedMode(flags: CheckFlags): ChangedMode | undefined {
  const requested = [
    flags.changed ? "--changed" : undefined,
    flags.staged ? "--staged" : undefined,
    flags.since ? "--since" : undefined,
  ].filter((flag) => flag !== undefined);
  if (requested.length > 1) {
    throw new ConfigError(
      `Choose only one scope filter: ${requested.join(", ")}`,
    );
  }
  if (flags.staged) return "staged";
  if (flags.since) return "since";
  if (flags.changed) return "changed";
  return undefined;
}

/** Resolve an optional positional path: zero or one existing directory. */
export function resolveCwd(paths: string[]): string {
  if (paths.length > 1) {
    throw new ConfigError(
      `Expected at most one directory path, received ${paths.length}.`,
    );
  }
  const first = paths[0];
  return resolveProjectRoot(first);
}

export function resolveSarifPath(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new ConfigError(`SARIF output path must be a file: ${abs}`);
  }

  const parent = dirname(abs);
  if (!existsSync(parent)) {
    throw new ConfigError(`SARIF output directory does not exist: ${parent}`);
  }
  if (!statSync(parent).isDirectory()) {
    throw new ConfigError(`SARIF output parent is not a directory: ${parent}`);
  }

  return abs;
}

export async function checkCommand(
  paths: string[],
  flags: CheckFlags,
): Promise<number> {
  // `--ai-json -` is read by an agent: the AI report is all stdout carries.
  const aiOnStdout = flags.aiJson === "-";
  if (aiOnStdout && flags.json) {
    throw new ConfigError(
      "--json and --ai-json - both write to stdout: give --ai-json a file path",
    );
  }
  const cwd = resolveCwd(paths);
  const mode = changedMode(flags);
  const profile = parseProfile(flags.profile);
  const concurrency = parseConcurrency(flags.concurrency);
  const filters = parseCheckFilters(flags);
  const sarifPath = flags.sarif ? resolveSarifPath(flags.sarif) : undefined;
  const aiJsonPath =
    flags.aiJson && flags.aiJson !== "-"
      ? resolveSarifPath(flags.aiJson)
      : flags.aiJson;

  const result = await runCheck({
    cwd,
    fix: flags.fix === true,
    ...(mode ? { changedMode: mode } : {}),
    ...(flags.since ? { since: flags.since } : {}),
    ...filters,
    ...(flags.config ? { configPath: flags.config } : {}),
    ...(flags.trustedRef !== undefined ? { trustedRef: flags.trustedRef } : {}),
    ...(profile ? { profile } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(flags.json ? { evidence: true } : {}),
  });

  if (flags.json) {
    process.stdout.write(`${toJson(result.summary)}\n`);
  } else if (!aiOnStdout) {
    process.stdout.write(
      flags.quiet
        ? renderQuiet(result.summary, result.projectRoot)
        : renderPretty(result.summary, result.projectRoot),
    );
    // The ci run a pre-push hook makes reads the working tree, not the
    // commit: say when they differ, so a pass is not taken for the commit's
    // (under --quiet too, plain: the one line a pass then prints).
    if (profile === "ci" && !mode && !flags.since) {
      const { dirty } = await gitState(result.projectRoot);
      const notice =
        "The working tree has uncommitted changes: this run judged them too, and a push carries only what is committed.\n";
      if (dirty) process.stderr.write(flags.quiet ? notice : pc.yellow(notice));
    }
  }

  if (sarifPath) {
    writeFileSync(sarifPath, toSarif(result.summary, result.projectRoot));
    if (!flags.json && !aiOnStdout)
      process.stdout.write(`SARIF written to ${sarifPath}\n`);
  }

  if (aiJsonPath) {
    const aiJson = `${toAiJson(result.summary, result.projectRoot)}\n`;
    if (aiOnStdout) {
      process.stdout.write(aiJson);
    } else {
      writeFileSync(aiJsonPath, aiJson);
      if (!flags.json)
        process.stdout.write(`AI-assist report written to ${aiJsonPath}\n`);
    }
  }

  return result.summary.exitCode;
}
