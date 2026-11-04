// BUILD: emit the Users API OpenAPI 3.0 spec FROM the shared contract schemas
// (packages/contracts) so the committed spec can never drift from the Zod source
// of truth. The oasdiff gate (openapi:check) compares this spec across commits to
// fail PRs that introduce breaking API changes. Run: tsx scripts/emit-openapi.ts
import { z } from "zod";
import { LoginBodySchema, LoginResultSchema, UsersSchema } from "contracts";

// zod 4 emits a safe-integer range on every integer and a pattern on every
// email; the committed spec never had them, so the gate would see a change
// that is not one (docs/research/upgrades-2026-10/zod-4.md).
const opts = {
  target: "openapi-3.0",
  override: (ctx: { jsonSchema: Record<string, unknown> }) => {
    const s = ctx.jsonSchema;
    if (s["type"] === "integer") {
      delete s["minimum"];
      delete s["maximum"];
    }
    if (s["format"] === "email") delete s["pattern"];
  },
} as const;

const doc = {
  openapi: "3.0.3",
  info: {
    title: "Users API",
    version: "1.0.0",
    description:
      "The users list and the login that mints a session token, as the Zod contracts in packages/contracts define them.",
    contact: {
      name: "validate-kit monorepo",
      url: "https://github.com/CryptoKrad/validate-kit",
    },
  },
  servers: [
    { url: "http://localhost:3001", description: "The API in development" },
  ],
  tags: [
    { name: "users", description: "The user list" },
    { name: "auth", description: "Sessions" },
  ],
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        summary: "List users",
        description: "Every user, as the contract's UsersSchema shapes them.",
        tags: ["users"],
        responses: {
          "200": {
            description: "The user list",
            content: {
              "application/json": {
                schema: z.toJSONSchema(UsersSchema, opts),
              },
            },
          },
        },
      },
    },
    "/login": {
      post: {
        operationId: "login",
        summary: "Authenticate and mint a session token",
        description:
          "Checks the credentials in the body and returns a session token.",
        tags: ["auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: z.toJSONSchema(LoginBodySchema, opts),
            },
          },
        },
        responses: {
          "200": {
            description: "A session token",
            content: {
              "application/json": {
                schema: z.toJSONSchema(LoginResultSchema, opts),
              },
            },
          },
          "400": { description: "Invalid request body" },
          "401": { description: "Invalid credentials" },
        },
      },
    },
  },
};

process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
