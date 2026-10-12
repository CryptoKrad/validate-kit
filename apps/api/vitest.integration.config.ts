// BUILD: vitest config for Docker-backed api integration tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.it.test.ts"],
    testTimeout: 30_000,
  },
});
