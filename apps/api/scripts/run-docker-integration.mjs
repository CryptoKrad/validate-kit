#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../", import.meta.url));

function installedVitest() {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (typeof bin !== "string")
    throw new Error("Installed Vitest has no CLI entry");
  return resolve(dirname(manifestPath), bin);
}

export function runApiDockerIntegration({
  run = spawnSync,
  vitest = installedVitest,
} = {}) {
  const docker = run("docker", ["info"], {
    cwd: apiRoot,
    stdio: "ignore",
    timeout: 30_000,
    shell: false,
  });
  if (docker.error || docker.status !== 0) {
    console.error("Docker is required for Testcontainers integration replay");
    return 1;
  }
  const result = run(
    process.execPath,
    [
      vitest(),
      "run",
      "--config",
      "vitest.integration.config.ts",
      "--reporter",
      "verbose",
    ],
    {
      cwd: apiRoot,
      stdio: "inherit",
      timeout: 180_000,
      shell: false,
    },
  );
  if (result.error)
    console.error("Testcontainers integration runner could not complete");
  return result.error || !Number.isInteger(result.status) ? 1 : result.status;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runApiDockerIntegration();
}
