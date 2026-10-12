#!/usr/bin/env node
// Committed launcher for the `check` and `validate-kit` bins. A package
// manager links a bin only if its target exists at install time, and dist/ is
// not there on a fresh checkout until the first build; this file always is.
import { existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  process.stderr.write(
    "validate-kit is not built yet (dist/cli.js is missing). In the validate-kit source repo run `pnpm run build`.\n",
  );
  process.exit(3);
}
await import(cli.href);
