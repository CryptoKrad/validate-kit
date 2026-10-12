// BUILD: Vitest config for jsdom component/unit testing with the React plugin.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["test/**/*.{test,spec}.{ts,tsx}", "contract/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
