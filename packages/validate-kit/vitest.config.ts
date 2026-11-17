import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Native fixture trees and signal probes must not compete with other files.
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
