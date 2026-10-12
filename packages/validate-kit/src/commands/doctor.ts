import { resolve } from "node:path";
import pc from "picocolors";
import {
  checkAvailability,
  compareSemver,
  toolAvailability,
} from "../adapters/base.js";
import { configFileOf, resolveConfig } from "../config/resolve.js";
import { ConfigError } from "../config/schema.js";
import { EXIT } from "../core/exit-codes.js";
import { groupBy } from "../core/group.js";
import {
  profileRunsTier,
  profileSettings,
  validateProfile,
  type ValidationProfile,
} from "../core/options.js";
import { buildPlan, type PlannedTask } from "../core/plan.js";
import type {
  AvailabilityResult,
  Detection,
  Language,
  ToolAdapter,
} from "../core/types.js";
import { detectFromFiles, listScopedFiles } from "../detect/languages.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Verify every tool's presence + version. Exit 3 if a tool this project's
 * plan needs is missing. */
export async function doctorCommand(flags: {
  json?: boolean;
  config?: string;
  /**
   * Answer for this profile: its tiers decide what is needed, and under a
   * strict profile (ci) an optional tool is required.
   */
  profile?: string;
  cwd?: string;
  adapters?: readonly ToolAdapter[];
  detect?: (root: string) => Promise<Detection>;
  availability?: (
    adapter: ToolAdapter,
    cwd: string,
  ) => Promise<AvailabilityResult>;
}): Promise<number> {
  const root = resolve(flags.cwd ?? process.cwd());
  const availability = flags.availability ?? checkAvailability;
  let profile: ValidationProfile | undefined;
  try {
    profile = validateProfile(flags.profile);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    throw err;
  }
  const strict = profile !== undefined && profileSettings(profile).strict;
  // "Needed" is what the planner would actually run here: it honours the
  // config (scope, disabled languages, layers and tools), each tool's own
  // condition, and project-level tools that serve no language. Every tier
  // counts: a deep tool is needed by the `ci` profile, which is the gate.
  let adapters: readonly ToolAdapter[];
  let detection: Detection;
  let planned: Map<string, PlannedTask[]>;
  try {
    const resolved = await resolveConfig(root, flags.config);
    const { config } = resolved;
    adapters = flags.adapters ?? resolved.adapters;
    const scope = { include: config.include, ignore: config.ignore };
    // The same file list `check` plans from, so a tool that finds its own
    // inputs (tlc's models) is needed exactly when `check` would run it.
    const scopedFiles = await listScopedFiles(root, scope);
    detection = flags.detect
      ? await flags.detect(root)
      : detectFromFiles(root, scopedFiles);
    // Without a profile every tier counts: a deep tool is needed by ci.
    const inProfile = adapters.filter(
      (adapter) =>
        profile === undefined || profileRunsTier(profile, adapter.tier),
    );
    const configFile = configFileOf(resolved, root);
    const tasks = await buildPlan(detection, config, root, inProfile, {
      scopedFiles,
      ...(configFile ? { configFile } : {}),
    });
    planned = groupBy(tasks, (task) => task.adapter.id);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    throw err;
  }
  const detected = new Set<Language>(detection.keys());

  const rows = await Promise.all(
    adapters.map(async (adapter) => {
      const own = planned.get(adapter.id) ?? [];
      const needed = own.length > 0;
      // Found from the folders `check` runs it in (DV3); a tool not needed
      // here is looked for from the root.
      let avail: AvailabilityResult;
      let versions: string[];
      let chosen = false;
      if (needed) {
        const found = await toolAvailability(own, root, availability);
        versions = found.versions;
        chosen = found.configuredMissing;
        avail = {
          available: found.lacking.length === 0,
          ...(versions.length > 0 ? { version: versions.join(", ") } : {}),
          minVersion: adapter.minVersion,
          installHint: adapter.installHint,
          ...(found.problem ? { problem: found.problem } : {}),
        };
      } else {
        avail = await availability(adapter, root);
        versions = avail.version ? [avail.version] : [];
      }
      const required = needed && (!adapter.optional || strict || chosen);
      const outdated =
        avail.available &&
        versions.some(
          (version) => compareSemver(version, adapter.minVersion) < 0,
        );
      let status:
        | "ok"
        | "outdated"
        | "version-unknown"
        | "missing-required"
        | "missing-optional"
        | "not-needed";
      // An unparseable --version means the min-version gate CANNOT run;
      // reporting "ok" would fail open on a possibly-too-old tool. Soft
      // warning: visible, but doesn't fail doctor (the tool did spawn).
      if (!needed) status = "not-needed";
      // With a minimum of 0.0.0 no version could fail the check, so one it
      // cannot read cannot either (gofmt prints none).
      else if (avail.available && !avail.version)
        status = adapter.minVersion === "0.0.0" ? "ok" : "version-unknown";
      else if (avail.available) status = outdated ? "outdated" : "ok";
      else status = required ? "missing-required" : "missing-optional";
      return { adapter, avail, required, status };
    }),
  );

  const missingRequired = rows.filter((r) => r.status === "missing-required");
  const outdatedRequired = rows.filter(
    (r) => r.required && r.status === "outdated",
  );
  const ok = missingRequired.length === 0 && outdatedRequired.length === 0;

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          languages: [...detected],
          tools: rows.map((r) => ({
            id: r.adapter.id,
            layer: r.adapter.layer,
            languages: r.adapter.languages,
            optional: r.adapter.optional ?? false,
            version: r.avail.version ?? null,
            minVersion: r.adapter.minVersion,
            status: r.status,
            installHint: r.adapter.installHint,
            ...(r.avail.problem ? { problem: r.avail.problem } : {}),
          })),
          ok,
        },
        null,
        2,
      )}\n`,
    );
    return ok ? EXIT.CLEAN : EXIT.INCOMPLETE;
  }

  process.stdout.write(
    `\nDetected languages: ${[...detected].join(", ") || pc.dim("none")}\n\n`,
  );
  process.stdout.write(
    pc.dim(
      `  ${pad("TOOL", 16)} ${pad("LAYER", 13)} ${pad("VERSION", 10)} STATUS\n`,
    ),
  );
  for (const r of rows) {
    const icon =
      r.status === "ok"
        ? pc.green("✔")
        : r.status === "outdated" || r.status === "version-unknown"
          ? pc.yellow("▲")
          : r.status === "missing-required"
            ? pc.red("✗")
            : r.status === "missing-optional"
              ? pc.gray("○")
              : pc.dim("–");
    const statusText =
      r.status === "missing-required"
        ? pc.red("MISSING (required)")
        : r.status === "missing-optional"
          ? pc.gray("missing (optional)")
          : r.status === "outdated"
            ? pc.yellow(
                `older than ${r.adapter.minVersion}, the oldest the kit is tested with`,
              )
            : r.status === "version-unknown"
              ? pc.yellow(`version unparseable (min ${r.adapter.minVersion})`)
              : r.status === "not-needed"
                ? pc.dim("not needed")
                : pc.green("ok");
    const ver = r.avail.version ?? pc.dim("–");
    process.stdout.write(
      `  ${icon} ${pad(r.adapter.id, 14)} ${pad(r.adapter.layer, 13)} ${pad(ver, 10)} ${statusText}\n`,
    );
    if (
      r.status === "missing-required" ||
      r.status === "missing-optional" ||
      r.status === "outdated"
    ) {
      if (r.avail.problem)
        process.stdout.write(pc.dim(`      cannot run: ${r.avail.problem}\n`));
      process.stdout.write(
        pc.dim(
          `      ${r.status === "outdated" ? "to upgrade" : "install"}: ${r.adapter.installHint}\n`,
        ),
      );
    }
  }
  process.stdout.write("\n");
  if (missingRequired.length > 0) {
    process.stdout.write(
      pc.red(
        `✗ ${missingRequired.length} required tool(s) missing (exit 3)\n\n`,
      ),
    );
    return EXIT.INCOMPLETE;
  }
  if (outdatedRequired.length > 0) {
    process.stdout.write(
      pc.red(
        `✗ ${outdatedRequired.length} required tool(s) outdated (exit 3)\n\n`,
      ),
    );
    return EXIT.INCOMPLETE;
  }
  process.stdout.write(pc.green("✔ All required tools present\n\n"));
  return EXIT.CLEAN;
}
