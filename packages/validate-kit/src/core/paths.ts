import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The npm package name. The unscoped name is not ours on the public registry
 * (docs/research/distribution/npm-name-validate-kit.md); a rename to a scope
 * changes this constant and package.json, nothing else.
 */
export const KIT_PACKAGE_NAME = "validate-kit";

let cached: string | undefined;

/**
 * Absolute path to the installed validate-kit package root (where `rules/`,
 * `sgconfig.yml`, `presets/` live). Works whether running bundled (dist/) or
 * from source/tests (src/) by walking up to the package.json named validate-kit.
 */
export function getKitRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const name = (
          JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }
        ).name;
        if (name === KIT_PACKAGE_NAME) {
          cached = dir;
          return dir;
        }
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return cached;
}

let cachedVersion: string | undefined;

/** The running kit's version, read once from its own package.json. */
export function kitVersion(): string {
  if (cachedVersion === undefined) {
    const pkg = JSON.parse(
      readFileSync(join(getKitRoot(), "package.json"), "utf8"),
    ) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  }
  return cachedVersion;
}

export const kitSgconfig = (): string => join(getKitRoot(), "sgconfig.yml");
export const kitRulesDir = (): string => join(getKitRoot(), "rules");
export const kitPresetsDir = (): string => join(getKitRoot(), "presets");
export const kitSemgrepConfig = (): string =>
  join(getKitRoot(), "semgrep", "custom.yml");
