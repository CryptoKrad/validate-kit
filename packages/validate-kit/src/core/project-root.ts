import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError } from "../config/schema.js";

/** Resolve and validate the directory root used for detection, config, and execution. */
export function resolveProjectRoot(input?: string): string {
  const abs = resolve(input || process.cwd());
  if (!existsSync(abs)) {
    throw new ConfigError(`Path does not exist: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new ConfigError(`Path must be a directory: ${abs}`);
  }
  return abs;
}
