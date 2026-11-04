import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The operator's global git config must not reach a fixture: a global
// core.hooksPath keeps git from running the .git/hooks these tests install
// and push through. An empty file, not /dev/null, so Windows works too.
const config = join(
  mkdtempSync(join(tmpdir(), "validate-kit-gitconfig-")),
  "config",
);
writeFileSync(config, "");
process.env["GIT_CONFIG_GLOBAL"] = config;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
