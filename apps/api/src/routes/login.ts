// BUILD: production login plugin + pure password helpers (unit-test targets).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { LoginBodySchema, LoginResultSchema } from "contracts";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

const scrypt = promisify(scryptCb);

// Stored format: "<saltHex>:<derivedKeyHex>". 16-byte salt, 64-byte key.
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Derive a salted scrypt hash for a plaintext password.
 * Returns a self-describing "<salt>:<hash>" string safe to store in a DB column.
 */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(pw, salt, KEY_BYTES)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Constant-time verification of a plaintext password against a stored hash.
 * Returns false (never throws) on any malformed/short hash so callers can treat
 * a bad credential and a corrupt record identically.
 */
export async function verifyPassword(
  pw: string,
  hash: string,
): Promise<boolean> {
  const sep = hash.indexOf(":");
  if (sep <= 0) return false;

  const saltHex = hash.slice(0, sep);
  const keyHex = hash.slice(sep + 1);
  if (saltHex.length === 0 || keyHex.length === 0) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;

  const derived = (await scrypt(pw, salt, KEY_BYTES)) as Buffer;
  // Lengths are equal here (both KEY_BYTES) so timingSafeEqual is safe to call.
  return timingSafeEqual(derived, expected);
}

/**
 * Mint a session token. STUB: base64 of "email:timestamp" — NOT a real JWT.
 * Kept dependency-free on purpose; swap for a signed token before production.
 */
function mintToken(email: string): string {
  return Buffer.from(`${email}:${Date.now()}`).toString("base64");
}

// In-memory credential store used when no DB is wired (unit/API/e2e layers).
// Mirrors migrations/001_init.sql seed users. The password for both is "password".
// Hash is computed at startup so the scrypt salt is fresh each boot.
async function buildSeedCredentials(): Promise<Map<string, string>> {
  const [aliceHash, bobHash] = await Promise.all([
    hashPassword("password"),
    hashPassword("password"),
  ]);
  return new Map([
    ["alice@example.com", aliceHash],
    ["bob@example.com", bobHash],
  ]);
}

const loginRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Resolve credentials once per plugin registration.
  const seedCredentials = await buildSeedCredentials();

  app.post("/login", async (request, reply) => {
    // Validate the INCOMING request body against the shared contract.
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    const { email, password } = parsed.data;

    let storedHash: string | undefined;
    if (app.hasDecorator("pg")) {
      const result = await app.pg.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE email = $1",
        [email],
      );
      storedHash = result.rows[0]?.password_hash;
    } else {
      storedHash = seedCredentials.get(email);
    }

    if (storedHash === undefined) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const ok = await verifyPassword(password, storedHash);
    if (!ok) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    // Validate the OUTGOING response against the shared contract (throws -> 500
    // on violation) so the provider can't ship a token shape the consumer rejects.
    return reply
      .code(200)
      .send(LoginResultSchema.parse({ token: mintToken(email) }));
  });
};

export default loginRoute;
