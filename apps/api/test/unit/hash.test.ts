// BUILD: unit tests for the pure scrypt password helpers (no app, no DB).
import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/routes/login.js";

describe("password hashing", () => {
  it("verify accepts the correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
  });

  it("verify rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("Tr0ub4dor&3", hash)).resolves.toBe(false);
  });

  it("produces a salted '<salt>:<hash>' shape with a fresh salt each call", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    // Distinct salts mean identical inputs never collide on the stored value.
    expect(a).not.toBe(b);
  });

  it("verify returns false (does not throw) on a malformed hash", async () => {
    await expect(verifyPassword("whatever", "not-a-valid-hash")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("whatever", "")).resolves.toBe(false);
  });
});
