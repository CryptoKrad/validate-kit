// BUILD (Docker-gated): real Postgres via @testcontainers/postgresql.
// Spins postgres:16-alpine, applies migrations/001_init.sql, builds the app
// against the container, asserts GET /users returns the 2 seeded rows.
//
// SELF-SKIPS LOUDLY when Docker is unavailable (it.skipIf + console.warn) so a
// missing daemon never masquerades as a passing test.
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

/** Runtime Docker probe: `docker info` succeeds only with a reachable daemon. */
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
    "\n[users.it.test] SKIPPED: Docker is not available. " +
      "Integration tests against a real Postgres container did NOT run. " +
      "Start Docker and re-run to exercise this layer.\n",
  );
}

const describeIfDocker = HAS_DOCKER ? describe : describe.skip;

describeIfDocker("GET /users (real Postgres)", () => {
  // Unset when beforeAll failed before starting them.
  let container: StartedPostgreSqlContainer | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const connectionString = container.getConnectionUri();

    // Apply the migration (DDL + idempotent seed) over a one-shot client.
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    const setup = new Client({ connectionString });
    await setup.connect();
    await setup.query(migrationSql);
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

  it("returns the 2 seeded rows from the database", async () => {
    const res = await started().inject({ method: "GET", url: "/users" });
    expect(res.statusCode).toBe(200);
    const rows = res.json<Array<{ id: number; email: string }>>();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });
});
