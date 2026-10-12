// BUILD: pure-logic and MSW-backed unit tests for api-client behavior.
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { ZodError } from "zod";
import { apiBase, getUsers, login } from "../../lib/api-client";
import { server } from "../../vitest.setup";

describe("apiBase()", () => {
  const original = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL;
    } else {
      process.env.NEXT_PUBLIC_API_URL = original;
    }
  });

  it("defaults to localhost:3001 when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(apiBase()).toBe("http://localhost:3001");
  });

  it("uses NEXT_PUBLIC_API_URL when set", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
    expect(apiBase()).toBe("https://api.example.com");
  });

  it("trims a trailing slash so path joins stay clean", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com/";
    expect(apiBase()).toBe("https://api.example.com");
  });
});

describe("api-client response validation", () => {
  it("rejects a successful /users response with an invalid user shape", async () => {
    server.use(
      http.get("*/users", () => {
        return HttpResponse.json([{ id: "1", email: null }]);
      }),
    );

    // The shared contract schema (UsersSchema) rejects the wrong-typed payload.
    await expect(getUsers()).rejects.toThrow(ZodError);
  });

  it("rejects a successful /login response without a usable token", async () => {
    server.use(
      http.post("*/login", () => {
        return HttpResponse.json({ token: "" });
      }),
    );

    await expect(login("user@example.com", "password")).rejects.toThrow(
      ZodError,
    );
  });
});
