---
name: verify
description: Prove a change to the API by running the service and calling the route the change touches. Use after any change under apps/api, before the commit.
---

# Verify a change to the API

Run the service and call it. A passing unit test is not this.

1. Start it. It needs no database: it serves its seed users.

   ```bash
   pnpm --filter api run start   # http://localhost:3001
   ```

2. Call the route that changed and compare with the table. Each line was run on 2026-11-16.

   | Call                                                                     | A pass shows                                               |
   | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
   | `curl -s localhost:3001/users`                                           | 200, `[{"id":1,"email":"alice@example.com"},{"id":2,...}]` |
   | `POST /login` with `{"email":"alice@example.com","password":"password"}` | 200, `{"token":"..."}`                                     |
   | `POST /login` with a wrong password                                      | 401, `{"error":"invalid credentials"}`                     |
   | `POST /login` with no password                                           | 400, `{"error":"email and password are required"}`         |

   ```bash
   curl -s -w ' [%{http_code}]\n' -X POST localhost:3001/login \
     -H 'content-type: application/json' \
     -d '{"email":"alice@example.com","password":"password"}'
   ```

3. Stop the server, then run the suite: `pnpm --filter api run test` (about one second). The
   tests against a real Postgres need Docker: `pnpm --filter api run test:integration:docker`.
   Say so when Docker is not running; do not report them as passed.
4. A change to a response is a change to the contract: `apps/api/openapi.json` and the pact in
   `pacts/` move in the same commit, and `pnpm run check` holds both.
5. A new route or a new refusal is seen failing once: break it, call it again, restore it.
