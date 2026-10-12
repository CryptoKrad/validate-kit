// @vitest-environment node
// BUILD: REAL consumer-driven contract test (Pact V4). The web consumer drives its
// ACTUAL api-client (getUsers/login, incl. the shared-Zod response parsing) against
// Pact's mock provider, recording the expected interactions to
// pacts/WebApp-UsersApi.json — which the provider then verifies against the live
// Fastify app (see apps/api provider verify). This is the canonical CDC
// demonstration; the *enforced* protection is the shared-Zod contract gate
// (packages/contracts) + the oasdiff breaking-change gate.
//
// Runs in the `node` environment (not jsdom) so the Pact FFI mock server + global
// fetch behave normally, with MSW stood down for the duration.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MatchersV3,
  PactV4,
  SpecificationVersion,
} from "@pact-foundation/pact";

import { getUsers, login } from "../lib/api-client";
import { server as mswServer } from "../vitest.setup";

const { eachLike, integer, string } = MatchersV3;
const here = dirname(fileURLToPath(import.meta.url));

const pact = new PactV4({
  consumer: "WebApp",
  provider: "UsersApi",
  dir: resolve(here, "../../../pacts"),
  spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
});

describe("consumer contract (Pact): WebApp -> UsersApi", () => {
  beforeAll(() => {
    mswServer.close();
  });
  afterAll(() => {
    mswServer.listen({ onUnhandledFrame: "error" });
  });

  it("GET /users serves the contracted user-list shape", async () => {
    await pact
      .addInteraction()
      .given("users exist")
      .uponReceiving("a request for the user list")
      .withRequest("GET", "/users", (b) =>
        b.headers({ Accept: "application/json" }),
      )
      .willRespondWith(200, (b) =>
        b
          .headers({ "Content-Type": "application/json" })
          .jsonBody(
            eachLike({ id: integer(1), email: string("alice@example.com") }),
          ),
      )
      .executeTest(async (mock) => {
        process.env.NEXT_PUBLIC_API_URL = mock.url;
        const users = await getUsers();
        expect(users.length).toBeGreaterThan(0);
        expect(typeof users[0]?.email).toBe("string");
      });
  });

  it("POST /login serves the contracted token response", async () => {
    await pact
      .addInteraction()
      .given("user alice exists")
      .uponReceiving("a valid login")
      .withRequest("POST", "/login", (b) =>
        b
          .headers({ "Content-Type": "application/json" })
          .jsonBody({ email: "alice@example.com", password: "password" }),
      )
      .willRespondWith(200, (b) =>
        b.jsonBody({ token: string("a-session-token") }),
      )
      .executeTest(async (mock) => {
        process.env.NEXT_PUBLIC_API_URL = mock.url;
        const result = await login("alice@example.com", "password");
        expect(typeof result.token).toBe("string");
      });
  });
});
