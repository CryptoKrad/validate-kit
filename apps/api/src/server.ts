// BUILD: process entrypoint. Reads config from env, starts the HTTP listener.
import { buildApp } from "./app.js";

const connectionString = process.env["DATABASE_URL"];
const corsOrigin = process.env["CORS_ORIGIN"] ?? "http://localhost:3000";
const port = Number(process.env["PORT"] ?? 3001);
const host = process.env["HOST"] ?? "0.0.0.0";

const app = buildApp({
  ...(connectionString !== undefined ? { connectionString } : {}),
  corsOrigin,
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await app.close();
    app.log.info(`api shut down after ${signal}`);
    process.exit(0);
  } catch (err) {
    console.error("failed to stop api", err);
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  const address = await app.listen({ port, host });
  app.log.info(`api listening on ${address}`);
} catch (err) {
  console.error("failed to start api", err);
  process.exit(1);
}
