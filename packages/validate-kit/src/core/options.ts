import { ConfigError } from "../config/schema.js";
import type { ChangedMode } from "../detect/git.js";
import {
  LANGUAGES,
  LAYERS,
  type Language,
  type Layer,
  type Tier,
} from "./types.js";

export type ValidationProfile = "default" | "dev" | "ci" | "fixtures";

/** @public scripts/validate-user-stories.mjs reads this list from the source. */
export const PROFILES = [
  "default",
  "dev",
  "ci",
  "fixtures",
] as const satisfies readonly ValidationProfile[];

const CHANGED_MODES = ["changed", "staged", "since"] as const;

/** What a profile changes about a run; every profile rule lives here. */
export interface ProfileSettings {
  /**
   * A missing planned tool is incomplete coverage (exit 3), optional or not,
   * and a full-scope run that plans nothing is a config error.
   */
  strict: boolean;
  /** Without --changed/--staged/--since, check only changed files. */
  changedByDefault: boolean;
}

export function profileSettings(profile: ValidationProfile): ProfileSettings {
  return {
    strict: profile === "ci",
    changedByDefault: profile === "dev",
  };
}

/**
 * Which tiers a profile runs: `dev` (every commit) only the fast ones, `ci`
 * everything, anything else fast and verify.
 */
export function profileRunsTier(
  profile: ValidationProfile,
  tier: Tier = "fast",
): boolean {
  if (profile === "ci") return true;
  if (profile === "dev") return tier === "fast";
  return tier !== "deep";
}

function validateValues<T extends string>(
  values: readonly string[] | undefined,
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  if (!values?.length) return undefined;
  const invalid = values.find((value) => !allowed.includes(value as T));
  if (invalid) {
    throw new ConfigError(
      `Invalid ${label} '${invalid}'. Expected one of: ${allowed.join(", ")}`,
    );
  }
  return [...values] as T[];
}

export function validateProfile(
  value: string | undefined,
): ValidationProfile | undefined {
  if (!value) return undefined;
  if (PROFILES.includes(value as ValidationProfile))
    return value as ValidationProfile;
  throw new ConfigError(
    `Invalid profile '${value}'. Expected one of: ${PROFILES.join(", ")}`,
  );
}

export function validateConcurrency(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `Invalid concurrency '${value}'. Expected a positive integer.`,
    );
  }
  return value;
}

export function parseConcurrency(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  return validateConcurrency(Number(value));
}

export interface ValidatedCheckFilters {
  layers?: Layer[];
  languages?: Language[];
  disabledTools?: string[];
  onlyTools?: string[];
}

/**
 * Layers and languages are fixed lists, so the CLI can check them before a
 * config is loaded. Tool names cannot be checked that early: a config may add
 * tools. They are passed through and checked by `validateCheckFilters`.
 */
export function validateStaticFilters(opts: {
  layers?: readonly string[];
  languages?: readonly string[];
  disabledTools?: readonly string[];
  onlyTools?: readonly string[];
}): ValidatedCheckFilters {
  const layers = validateValues(opts.layers, LAYERS, "layer");
  const languages = validateValues(opts.languages, LANGUAGES, "language");
  return {
    ...(layers ? { layers } : {}),
    ...(languages ? { languages } : {}),
    ...(opts.disabledTools?.length
      ? { disabledTools: [...opts.disabledTools] }
      : {}),
    ...(opts.onlyTools?.length ? { onlyTools: [...opts.onlyTools] } : {}),
  };
}

/** `toolIds` is the resolved registry: built-ins plus the project's own. */
export function validateCheckFilters(
  opts: {
    layers?: readonly string[];
    languages?: readonly string[];
    disabledTools?: readonly string[];
    onlyTools?: readonly string[];
  },
  toolIds: readonly string[],
): ValidatedCheckFilters {
  const layers = validateValues(opts.layers, LAYERS, "layer");
  const languages = validateValues(opts.languages, LANGUAGES, "language");
  const onlyTools = validateValues(opts.onlyTools, toolIds, "tool");
  const disabledTools = validateValues(opts.disabledTools, toolIds, "tool");
  const overlap = onlyTools?.filter((tool) => disabledTools?.includes(tool));

  if (overlap?.length) {
    throw new ConfigError(
      `Tool cannot be both --only and --disable: ${overlap.join(", ")}`,
    );
  }

  return {
    ...(layers ? { layers } : {}),
    ...(languages ? { languages } : {}),
    ...(disabledTools ? { disabledTools } : {}),
    ...(onlyTools ? { onlyTools } : {}),
  };
}

export function validateChangedMode(
  value: string | undefined,
): ChangedMode | undefined {
  if (!value) return undefined;
  if (CHANGED_MODES.includes(value as ChangedMode)) return value as ChangedMode;
  throw new ConfigError(
    `Invalid changed mode '${value}'. Expected one of: ${CHANGED_MODES.join(", ")}`,
  );
}
