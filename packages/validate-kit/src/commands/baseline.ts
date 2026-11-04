import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitFiles } from "../adapters/native.js";
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
import { toolProblems } from "../report/pretty.js";
import { parseCheckFilters, parseProfile, resolveCwd } from "./check.js";

/** The findings that cannot be debt, listed up to this many. */
const VERDICT_LINES = 20;

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
  const tracked = gitFiles(projectRoot, true);
  if (summary.crashed.length > 0 || summary.incomplete.length > 0) {
    process.stderr.write(
      `Not writing ${BASELINE_FILE}: the run could not see everything. Install or fix the tool and run it again.\n${toolProblems(
        summary,
      )
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
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
    ...(tracked ? { tracked: new Set(tracked) } : {}),
  });
  if (update.refused.length > 0) {
    const { refused, adoptable } = update;
    // Rules the baseline never saw, after a kit or tool upgrade, are the
    // flag's to accept: say so, or the refusal reads as "fix them all".
    const hint =
      adoptable === 0
        ? ""
        : adoptable === refused.length
          ? `All of them come from rules ${BASELINE_FILE} has not seen, after a kit or tool upgrade: \`validate-kit baseline --adopt-new-rules\` accepts them.\n`
          : `Of these, ${adoptable} come from rules ${BASELINE_FILE} has not seen, after a kit or tool upgrade, which \`--adopt-new-rules\` accepts; the other ${refused.length - adoptable} are new findings.\n`;
    process.stderr.write(
      `Not writing ${BASELINE_FILE}: these counts would grow (new findings are fixed, not accepted):\n${refused.map((line) => `  ${line}`).join("\n")}\n${hint}`,
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
  const { verdicts, security } = update;
  if (verdicts.length > 0) {
    // Named, with the profile: the default `check` may not run the gates
    // the ci profile does.
    process.stdout.write(
      `${verdicts.length} finding(s) of the ${profile} run cannot be debt and still fail it: gates, tests and formal checks report one verdict however much fails:\n${verdicts
        .slice(0, VERDICT_LINES)
        .map((line) => `  ${line}\n`)
        .join(
          "",
        )}${verdicts.length > VERDICT_LINES ? `  ... ${verdicts.length - VERDICT_LINES} more\n` : ""}`,
    );
  }
  if (security > 0) {
    process.stdout.write(
      `${security} security finding(s) cannot be debt without --include-security, and still fail the run.\n`,
    );
  }
  if (update.untracked > 0) {
    process.stdout.write(
      `${update.untracked} finding(s) are in files git does not track, which cannot be debt and still fail the run: add the file to git, or to .gitignore.\n`,
    );
  }
  return EXIT.CLEAN;
}
