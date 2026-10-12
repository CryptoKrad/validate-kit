// BUILD: vitest config for the api package.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**/*.it.test.ts", "node_modules/**"],
    testTimeout: 30_000,
  },
});
