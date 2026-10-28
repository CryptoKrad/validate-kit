import validRange from "semver/ranges/valid.js";
import { z } from "zod";
import type { ToolAdapter, ValidateConfig } from "../core/types.js";
import { LANGUAGES, LAYERS, TIERS } from "../core/types.js";

const severity = z.enum(["error", "warning", "info", "hint"]);
const preset = z.enum(["recommended", "strict", "security", "ci"]);

/** JSON values only: no functions, class instances, cycles or non-finite numbers. */
function isPlainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const proto = Object.getPrototypeOf(value) as unknown;
  const plain = Array.isArray(value)
    ? value.every((item) => isPlainData(item, seen))
    : (proto === Object.prototype || proto === null) &&
      Object.values(value).every((item) => isPlainData(item, seen));
  seen.delete(value);
  return plain;
}

const toolConfig = z
  .object({
    enabled: z.boolean().optional(),
    configPath: z.string().optional(),
    bin: z.string().min(1).optional(),
    extraArgs: z.array(z.string()).optional(),
    severity: severity.optional(),
    // Node runs a timer longer than 2^31-1 ms after 1 ms instead.
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    options: z
      .unknown()
      .refine(
        isPlainData,
        "must be plain JSON data (it is part of the config digest)",
      )
      .optional(),
  })
  .strict();

const langConfig = z
  .object({
    enabled: z.boolean().optional(),
    // An adapter reads its options from tools.<id>; a per-language value
    // would be accepted and never seen.
    tools: z.record(z.string(), toolConfig.omit({ options: true })).optional(),
  })
  .strict();

const layerConfig = z.object({ enabled: z.boolean().optional() }).strict();

// Shape only: z.function() would wrap the functions and break their `this`.
function isAdapterShape(value: unknown): value is ToolAdapter {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    candidate["id"] !== "" &&
    typeof candidate["layer"] === "string" &&
    Array.isArray(candidate["languages"]) &&
    typeof candidate["bin"] === "string" &&
    typeof candidate["buildArgs"] === "function" &&
    typeof candidate["parseOutput"] === "function"
  );
}

const invariant = z
  .object({
    id: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        "letters, digits, '.', '_' or '-', starting with a letter or digit",
      ),
    statement: z.string().min(1),
    covers: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (pattern) => !/^!?\//.test(pattern),
            "covers patterns are relative to the project root, not absolute",
          ),
      )
      .optional(),
    evidence: z.array(z.string().min(1)).optional(),
    check: z.string().min(1).optional(),
    expect: z.string().min(1).optional(),
    tier: z.enum(TIERS).optional(),
  })
  .strict()
  .refine(
    (inv) => inv.check !== undefined || (inv.evidence?.length ?? 0) > 0,
    "an invariant needs a check command, evidence paths, or both",
  )
  .refine(
    (inv) => inv.expect === undefined || inv.check !== undefined,
    "`expect` is text the check's output must contain, so it needs a `check`",
  );

const adapter = z.custom<ToolAdapter>(isAdapterShape, {
  message:
    "must be a tool adapter (id, layer, languages, bin, buildArgs, parseOutput). Adapters hold functions, so they need a JS or TS config, not JSON.",
});

const severityOverride = z
  .object({
    tool: z.string(),
    ruleId: z.string(),
    severity: z.union([severity, z.literal("off")]),
  })
  .strict();

const validateConfigSchema = z
  .object({
    // `extends: []` is the DOCUMENTED opt-out: no preset baseline at all
    // (for repos bringing their own sgconfig/rule library). Omitting the key
    // falls back to `recommended`. Pinned by config.test.ts.
    extends: z.union([preset, z.array(preset)]).optional(),
    languages: z.partialRecord(z.enum(LANGUAGES), langConfig).optional(),
    tools: z.record(z.string(), toolConfig).optional(),
    adapters: z.array(adapter).optional(),
    invariants: z.array(invariant).optional(),
    layers: z.partialRecord(z.enum(LAYERS), layerConfig).optional(),
    include: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    maxFileBytes: z.number().int().min(0).optional(),
    skipMinified: z.boolean().optional(),
    astGrep: z
      .object({
        ruleDirs: z.array(z.string()).optional(),
        ruleIds: z.array(z.string()).optional(),
        sgconfig: z.string().optional(),
      })
      .strict()
      .optional(),
    vulnAudit: z
      .object({
        enabled: z.boolean().optional(),
        scanPaths: z.array(z.string()).nonempty().optional(),
        configFile: z.string().optional(),
        offline: z.boolean().optional(),
      })
      .strict()
      .optional(),
    apiDiff: z
      .object({
        enabled: z.boolean().optional(),
        specs: z.array(z.string()).nonempty().optional(),
        // An empty ref (an unset GITHUB_BASE_REF) would read the index.
        baseRef: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    concurrency: z.number().int().positive().optional(),
    severityOverrides: z.array(severityOverride).optional(),
    kitVersion: z
      .string()
      .refine(
        (range) => range.trim() !== "" && validRange(range) !== null,
        'must be a semver range, e.g. "^0.2.0"',
      )
      .optional(),
    policyFiles: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (pattern) => !pattern.startsWith("/") && !pattern.startsWith(":"),
            "policyFiles are globs relative to the project root (`../` reaches above it), without git pathspec magic",
          ),
      )
      .optional(),
  })
  .strict();

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** One line per issue, for a ConfigError message. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

/** Validate a raw object as a ValidateConfig, throwing ConfigError on failure. */
export function parseConfig(raw: unknown, source: string): ValidateConfig {
  const result = validateConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid validate config at ${source}:\n${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}
