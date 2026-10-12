// BUILD (Docker-gated): real Postgres login integration. Spins postgres:16-alpine,
// applies migrations/001_init.sql (real scrypt hashes of "password"), builds the
// app against the container, and exercises POST /login through the DB-backed path
// (verifyPassword vs the stored hash) — the production path the API/e2e seed layers
// never touch.
//
// SELF-SKIPS LOUDLY when Docker is unavailable so a missing daemon never
// masquerades as a passing test.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(here, "../../migrations/001_init.sql");

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  console.warn(
    "\n[login.it.test] SKIPPED: Docker is not available. " +
      "POST /login against a real Postgres container did NOT run. " +
      "Start Docker and re-run to exercise the DB-backed auth path.\n",
  );
}

const describeIfDocker = HAS_DOCKER ? describe : describe.skip;

describeIfDocker("POST /login (real Postgres)", () => {
  // Unset when beforeAll failed before starting them.
  let container: StartedPostgreSqlContainer | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const connectionString = container.getConnectionUri();

    const setup = new Client({ connectionString });
    await setup.connect();
    await setup.query(readFileSync(MIGRATION_PATH, "utf8"));
    await setup.end();

    app = buildApp({ connectionString });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (container !== undefined) await container.stop();
  }, 60_000);

  function started(): FastifyInstance {
    if (app === undefined) throw new Error("beforeAll did not start the app");
    return app;
  }

  function postLogin(body: unknown) {
    return started().inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("verifies the seeded credential against the DB hash and returns a token", async () => {
    const res = await postLogin({
      email: "alice@example.com",
      password: "password",
    });
    expect(res.statusCode).toBe(200);
    const token = res.json<{ token?: unknown }>().token;
    expect(typeof token).toBe("string");
    if (typeof token !== "string") throw new TypeError("expected login token");
    expect(token.length).toBeGreaterThan(0);
  });

  it("rejects a wrong password for a real DB user with 401", async () => {
    const res = await postLogin({
      email: "alice@example.com",
      password: "wrong",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown email with 401 (no matching row)", async () => {
    const res = await postLogin({
      email: "nobody@example.com",
      password: "password",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a contract-invalid body (bad email + empty password) with 400", async () => {
    const res = await postLogin({ email: "not-an-email", password: "" });
    expect(res.statusCode).toBe(400);
  });

  it("treats a SQL-injection-style email as input, never a 500 or auth bypass", async () => {
    const res = await postLogin({
      email: "alice@example.com' OR '1'='1",
      password: "password",
    });
    // The contract email check rejects it (400) before the parametrized query
    // ever sees it; either way it must NOT 500, and must NOT return a token.
    expect([400, 401]).toContain(res.statusCode);
    expect(res.json<{ token?: unknown }>().token).toBeUndefined();
  });
});
