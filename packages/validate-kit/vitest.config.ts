import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test file: the number of cases a property runs, and a git that
    // never reads the operator's global config (a core.hooksPath there keeps
    // a fixture's hooks from running).
    setupFiles: ["test/fast-check.setup.ts", "test/isolated-git.ts"],
    testTimeout: 30_000,
    // Native fixture trees and signal probes must not compete with other files.
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
