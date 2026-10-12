import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runCheck } from "../api.js";
import {
  BASELINE_FILE,
  loadBaseline,
  serializeBaseline,
  updateBaseline,
} from "../core/baseline.js";
import { EXIT } from "../core/exit-codes.js";
import { profileSettings } from "../core/options.js";
import { kitVersion } from "../core/paths.js";
import { activeAstGrepRuleIds, resolveConfig } from "../config/resolve.js";
import { ConfigError } from "../config/schema.js";
import { parseCheckFilters, parseProfile, resolveCwd } from "./check.js";

export interface BaselineFlags {
  adoptNewRules?: boolean;
  includeSecurity?: boolean;
  profile?: string;
  config?: string;
  only?: string[];
  disable?: string[];
}

/**
 * Write `validate.baseline.json` from a full run: created when absent,
 * otherwise only lowered (see `updateBaseline`). A run that could not see
 * everything (a missing tool, a crash) writes nothing: it would record too
 * little debt.
 */
export async function baselineCommand(
  paths: string[],
  flags: BaselineFlags,
): Promise<number> {
  const cwd = resolveCwd(paths);
  const profile = parseProfile(flags.profile) ?? "ci";
  // A changed-file run sees only some files, and would drop the rest.
  if (profileSettings(profile).changedByDefault) {
    throw new ConfigError(
      `The ${profile} profile checks only changed files; a baseline needs a full run (use ci or default).`,
    );
  }
  // Read before the tools run: they execute the project's code.
  const previous = await loadBaseline(cwd);
  const { config, adapters } = await resolveConfig(cwd, flags.config);
  const result = await runCheck({
    cwd,
    profile,
    ...parseCheckFilters(flags),
    ...(flags.config ? { configPath: flags.config } : {}),
  });
  const { summary, projectRoot } = result;
  if (summary.crashed.length > 0 || summary.incomplete.length > 0) {
    const tools = [...summary.crashed, ...summary.incomplete]
      .map((issue) => issue.id)
      .join(", ");
    process.stderr.write(
      `Not writing ${BASELINE_FILE}: the run could not see everything (${tools}). Install or fix the tool and run it again.\n`,
    );
    return summary.crashed.length > 0 ? EXIT.INTERNAL : EXIT.INCOMPLETE;
  }
  const update = updateBaseline(previous, summary, {
    projectRoot,
    kitVersion: kitVersion(),
    adoptNewRules: flags.adoptNewRules === true,
    includeSecurity: flags.includeSecurity === true,
    knownRules: activeAstGrepRuleIds(projectRoot, config).map(
      (id) => `ast-grep/${id}`,
    ),
    knownTools: adapters.map((adapter) => adapter.id),
  });
  if (update.refused.length > 0) {
    process.stderr.write(
      `Not writing ${BASELINE_FILE}: these counts would grow (new findings are fixed, not accepted):\n${update.refused.map((line) => `  ${line}`).join("\n")}\n`,
    );
    return EXIT.FINDINGS;
  }
  writeFileSync(
    resolve(projectRoot, BASELINE_FILE),
    serializeBaseline(update.baseline),
  );
  const entries = Object.values(update.baseline.counts).reduce(
    (sum, byRule) => sum + Object.keys(byRule).length,
    0,
  );
  process.stdout.write(
    `${previous ? "Updated" : "Wrote"} ${BASELINE_FILE}: ${entries} file/rule count(s); ${update.lowered} lowered or removed${update.adopted.length > 0 ? `; adopted ${update.adopted.join(", ")}` : ""}${update.dropped.length > 0 ? `; dropped tools the kit and config no longer have: ${update.dropped.join(", ")}` : ""}.\n`,
  );
  if (update.unrecordable > 0) {
    process.stdout.write(
      `${update.unrecordable} finding(s) cannot be debt and still fail the run: gates, tests and formal checks report one verdict however much fails, and security findings need --include-security.\n`,
    );
  }
  return EXIT.CLEAN;
}
