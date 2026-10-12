// BUILD: app builder. Returns an UNSTARTED FastifyInstance so tests can drive it
// via app.inject() (in-process) or app.server with Supertest (real HTTP stack).
import cors from "@fastify/cors";
import fastifyPostgres from "@fastify/postgres";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import loginRoute from "./routes/login.js";
import usersRoute from "./routes/users.js";

export interface BuildAppOptions {
  /**
   * Postgres connection string. When omitted, @fastify/postgres is NOT
   * registered, so routes fall back to their in-memory seed data. This is the
   * testability key: unit/API/e2e layers build the app with no DB at all.
   */
  connectionString?: string;
  /**
   * Browser origin allowed to call the API. Defaults to the local Next app so
   * the DB-free E2E path can exercise the real Fastify server from Chromium.
   */
  corsOrigin?: string | false;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const corsOrigin = opts.corsOrigin ?? "http://localhost:3000";

  // Register Postgres ONLY when a connection string is supplied. Registration is
  // async under the hood but @fastify/postgres decorates synchronously enough
  // that callers must still `await app.ready()` before issuing requests.
  if (opts.connectionString !== undefined && opts.connectionString !== "") {
    void app.register(fastifyPostgres, {
      connectionString: opts.connectionString,
    });
  }

  if (corsOrigin !== false) {
    void app.register(cors, { origin: corsOrigin });
  }

  void app.register(loginRoute);
  void app.register(usersRoute);

  return app;
}
