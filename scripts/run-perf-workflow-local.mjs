#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "3001";
const managedApiUrl = `http://${host}:${port}`;
const apiUrl = process.env.API_URL ?? managedApiUrl;
const readinessUrl = `${apiUrl}/users`;
const readinessAttempts = 60;
const readinessDelayMs = 500;

if (!hasCommand("k6")) {
  console.error(
    "k6 is required for the perf workflow smoke. Install with: mise install k6",
  );
  process.exit(127);
}

let apiProcess;
let apiExit;
if (!process.env.API_URL) {
  apiProcess = spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    cwd: "apps/api",
    env: {
      ...process.env,
      HOST: host,
      PORT: port,
      API_URL: apiUrl,
    },
    stdio: "inherit",
  });
  apiProcess.once("exit", (code, signal) => {
    apiExit = { code, signal };
  });
}

async function stopApi() {
  if (!apiProcess || apiExit) return;
  apiProcess.kill("SIGTERM");
  await Promise.race([waitForApiExit(), delay(5000)]);
  if (!apiExit) {
    apiProcess.kill("SIGKILL");
    await waitForApiExit();
  }
}

process.once("SIGINT", async () => {
  await stopApi();
  process.exit(130);
});
process.once("SIGTERM", async () => {
  await stopApi();
  process.exit(143);
});

try {
  await waitForApi(readinessUrl);
  assertManagedApiRunning();
  const result = spawnSync("k6", ["run", "perf/k6/users-smoke.js"], {
    cwd: process.cwd(),
    env: { ...process.env, API_URL: apiUrl },
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`failed to start k6: ${result.error.message}`);
    process.exit(1);
  }
  process.exitCode = result.status ?? 1;
} finally {
  await stopApi();
}

function hasCommand(command) {
  const result = spawnSync(command, ["version"], {
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

async function waitForApi(url) {
  await waitForApiAttempt(url, 1);
}

async function waitForApiAttempt(url, attempt) {
  if (attempt > readinessAttempts) {
    throw new Error(`API did not become ready at ${url}`);
  }

  assertManagedApiRunning();
  if (await canFetch(url)) {
    await delay(0);
    assertManagedApiRunning();
    return;
  }

  await delay(readinessDelayMs);
  await waitForApiAttempt(url, attempt + 1);
}

function assertManagedApiRunning() {
  if (!apiProcess || !apiExit) return;
  const reason =
    apiExit.signal === null || apiExit.signal === undefined
      ? `exit code ${apiExit.code}`
      : `signal ${apiExit.signal}`;
  throw new Error(`managed API exited before readiness with ${reason}`);
}

async function canFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readinessDelayMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function waitForApiExit() {
  if (!apiProcess || apiExit) return Promise.resolve();
  return new Promise((resolveExit) => {
    apiProcess.once("exit", resolveExit);
  });
}
