// BUILD: provider contract test. Boots the REAL Fastify app and asserts every
// response parses against the SHARED contract schema (packages/contracts) — the
// exact same object the web consumer validates incoming responses with. Because
// both sides reference one schema, the provider literally cannot ship a response
// the consumer would reject (and vice-versa) within a commit. Cross-commit
// breaking changes are caught separately by the oasdiff gate in CI.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Verifier } from "@pact-foundation/pact";
import type { FastifyInstance } from "fastify";
import { LoginResultSchema, UsersSchema } from "contracts";

import { buildApp } from "../../src/app.js";

describe("provider contract: responses satisfy the shared Users API contract", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildApp({});
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /users returns a payload that parses against UsersSchema", async () => {
    const response = await fetch(`${baseUrl}/users`, {
      headers: { Accept: "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // .parse() throws on ANY contract violation (wrong type, bad email, etc.).
    const users = UsersSchema.parse(await response.json());
    expect(users.length).toBeGreaterThan(0);
  });

  it("POST /login returns a payload that parses against LoginResultSchema", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "password",
      }),
    });

    expect(response.status).toBe(200);
    const result = LoginResultSchema.parse(await response.json());
    expect(result.token.length).toBeGreaterThan(0);
  });

  it("POST /login rejects a contract-invalid request body with 400", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    });
    // LoginBodySchema.safeParse fails (bad email + empty password) -> 400.
    expect(response.status).toBe(400);
  });
});

// Real Pact CDC verification: replay the consumer-generated pact
// (pacts/WebApp-UsersApi.json, written by apps/web/contract/users.consumer.pact.test.ts)
// against the LIVE Fastify provider. This is the canonical consumer-driven
// contract check — the provider must satisfy exactly what the consumer recorded.
describe("provider verification (Pact): UsersApi honours the WebApp contract", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildApp({});
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("replays the consumer pact against the live provider", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pactFile = resolve(here, "../../../../pacts/WebApp-UsersApi.json");
    // The in-memory seed (alice/bob, password "password") already satisfies the
    // pact's provider states ("users exist", "user alice exists"), so no
    // stateHandlers are required. verifyProvider() rejects on any mismatch.
    const output = await new Verifier({
      provider: "UsersApi",
      providerBaseUrl: baseUrl,
      pactUrls: [pactFile],
    }).verifyProvider();
    expect(output).toBeDefined();
  }, 30_000);
});
