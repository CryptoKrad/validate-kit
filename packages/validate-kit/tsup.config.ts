import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // tsup sets baseUrl for its declaration build, which TypeScript 6 deprecates
  // (docs/research/upgrades-2026-10/typescript-7.md).
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: ({ format }) =>
    format === "esm" ? { js: "#!/usr/bin/env node" } : {},
});
