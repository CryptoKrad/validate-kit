// BUILD: users plugin. DB-backed when app.pg is present; in-memory seed otherwise.
import { UsersSchema } from "contracts";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

export interface UserRow {
  id: number;
  email: string;
}

// In-memory seed used when no Postgres is wired (unit / API / e2e layers run
// without a container). Mirrors the seed rows in migrations/001_init.sql so the
// shape and ordering match the DB-backed path.
const SEED_USERS: readonly UserRow[] = [
  { id: 1, email: "alice@example.com" },
  { id: 2, email: "bob@example.com" },
];

const usersRoute: FastifyPluginAsync = (app: FastifyInstance) => {
  app.get("/users", async (): Promise<UserRow[]> => {
    // app.pg is only decorated when @fastify/postgres was registered with a
    // connectionString. Without a DB we fall back to the seed array so the API
    // and e2e layers function offline.
    // Validate the OUTGOING response against the shared contract before it
    // leaves the server. Unlike a bare Fastify response schema (which only
    // filters), UsersSchema.parse() THROWS on a shape violation -> 500, so the
    // provider can never silently ship a response the contract forbids.
    if (app.hasDecorator("pg")) {
      const result = await app.pg.query<UserRow>(
        "SELECT id, email FROM users ORDER BY id",
      );
      return UsersSchema.parse(result.rows);
    }
    return UsersSchema.parse([...SEED_USERS]);
  });
  return Promise.resolve();
};

export default usersRoute;
