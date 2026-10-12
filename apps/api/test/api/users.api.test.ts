// BUILD: API-layer test. Drives the REAL HTTP stack with Supertest against
// app.server, using the in-memory seed (no DB). Proves wiring + serialization.
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({}); // no connectionString => in-memory seed path
  await app.ready();
  // Bind an ephemeral port so app.server is a live HTTP server for Supertest.
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

describe("GET /users (HTTP)", () => {
  it("returns 200 and the seeded users as JSON", async () => {
    const res = await request(app.server).get("/users").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual([
      { id: 1, email: "alice@example.com" },
      { id: 2, email: "bob@example.com" },
    ]);
  });
});

describe("POST /login (HTTP)", () => {
  it("allows the web app origin to preflight login POSTs", async () => {
    const res = await request(app.server)
      .options("/login")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain(
      "content-type",
    );
  });

  it("rejects bad credentials with 401", async () => {
    await request(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "wrong" })
      .expect(401);
  });

  it("rejects a field the published contract does not have, even with valid credentials", async () => {
    // openapi.json: the login body has additionalProperties: false.
    const res = await request(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "password", role: "admin" })
      .expect(400);
    expect((res.body as { token?: unknown }).token).toBeUndefined();
  });

  it("accepts the seeded credential and returns a token", async () => {
    const res = await request(app.server)
      .post("/login")
      .send({ email: "alice@example.com", password: "password" })
      .expect(200);
    const token = (res.body as { token?: unknown }).token;
    expect(typeof token).toBe("string");
    if (typeof token !== "string") throw new TypeError("expected login token");
    expect(token.length).toBeGreaterThan(0);
  });
});
