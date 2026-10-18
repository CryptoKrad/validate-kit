import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import pc from "picocolors";
import { ConfigError } from "../config/schema.js";
import { findConfigFile } from "../config/resolve.js";
import { EXIT } from "../core/exit-codes.js";
import { getKitRoot, KIT_PACKAGE_NAME } from "../core/paths.js";
import { LANGUAGES, type Language } from "../core/types.js";
import { upTo } from "../detect/adoption.js";
import {
  detectFromFiles,
  isUnder,
  languageForFile,
  listScopedFiles,
  toPosix,
} from "../detect/languages.js";
import { scaffoldHook, type Writer } from "./init-hook.js";

const BIN = "validate-kit";

const STARTER_BODY = (langs: string[]): string => `  extends: "recommended",
  // Detected: ${langs.join(", ") || "none yet"}
  // Add your own ast-grep rule directories:
  // astGrep: { ruleDirs: ["./.validate/rules"] },
  // Silence or re-level a specific rule:
  // severityOverrides: [{ tool: "eslint", ruleId: "no-console", severity: "off" }],
`;

/**
 * The starter imports the kit only when the kit is the project's own
 * dependency. Anywhere else the module does not resolve for the project's
 * type-checker or editor, so the config is a plain object.
 */
const starterModule = (langs: string[], kitAtRoot: boolean): string =>
  kitAtRoot
    ? `import { defineConfig } from "${KIT_PACKAGE_NAME}";

export default defineConfig({
${STARTER_BODY(langs)}});
`
    : `export default {
${STARTER_BODY(langs)}};
`;

const STARTER_JSON = `${JSON.stringify({ extends: "recommended" }, null, 2)}\n`;

/**
 * How the project runs this very kit when it is installed inside the project:
 * the root's own dependency (`node_modules/.bin/validate-kit`) or a tools
 * folder (`.tools/validate-kit/node_modules/.bin/validate-kit`, DV15).
 * Real paths are compared, not package names: the unscoped npm name belongs
 * to an unrelated package, and a copy of that in node_modules must never be
 * scaffolded as the command to run.
 */
function localKit(
  root: string,
): { command: string; atRoot: boolean } | undefined {
  let kit: string;
  let top: string;
  try {
    kit = realpathSync(getKitRoot());
    top = realpathSync(root);
  } catch {
    return undefined;
  }
  if (!isUnder(kit, top)) return undefined;
  for (const dir of upTo(dirname(kit), top)) {
    const rel = toPosix(relative(top, dir));
    // An install's own folder, never a package manager's store inside one.
    if (rel.split("/").includes("node_modules")) continue;
    try {
      if (
        realpathSync(join(dir, "node_modules", KIT_PACKAGE_NAME)) === kit &&
        existsSync(join(dir, "node_modules", ".bin", BIN))
      )
        return {
          command: `${rel ? `${rel}/` : ""}node_modules/.bin/${BIN}`,
          atRoot: rel === "",
        };
    } catch {
      /* not installed here */
    }
  }
  return undefined;
}

/**
 * Is the bin installed machine-wide? `node_modules/.bin` entries do not
 * count: package managers add them to PATH only while they run a command, so
 * a hook or an agent started later would not see them.
 */
function onPath(bin: string): boolean {
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .some(
      (dir) =>
        dir !== "" &&
        !dir.includes("node_modules") &&
        existsSync(join(dir, bin)),
    );
}

function writer(dryRun: boolean): Writer {
  return {
    dryRun,
    write(path, text, said) {
      if (dryRun) {
        process.stdout.write(
          `Would write ${path}${said ? ` (${said})` : ""}\n`,
        );
        return;
      }
      writeFileSync(path, text);
      process.stdout.write(
        pc.green(`Wrote ${path}${said ? ` (${said})` : ""}\n`),
      );
    },
  };
}

/**
 * Write the starter config unless the repo already has one. Returns an exit
 * code only when init has to stop.
 */
async function scaffoldConfig(
  root: string,
  existingConfig: string | undefined,
  force: boolean,
  kitAtRoot: boolean,
  out: Writer,
): Promise<number | undefined> {
  const files = await listScopedFiles(root, {});
  const detection = detectFromFiles(root, files);
  const langs = LANGUAGES.filter((l) => detection.has(l));
  // A .ts (or .mjs) config is itself a source file, so the format follows
  // the project root, not any file in the tree (DV1): .ts only where a root
  // tsconfig makes the root a TypeScript project (anywhere else type-aware
  // linters would meet a file outside every project), .mjs where the root is
  // a JS package or holds JS or TS files in the root folder itself, JSON
  // otherwise, so a Go repo whose TypeScript is one app below the root, or a
  // Rust repo with scripts under docs/, gains no language there.
  const top = toPosix(resolve(root));
  const atRoot = (lang: Language): boolean =>
    files.some(
      (file) => languageForFile(file) === lang && posix.dirname(file) === top,
    );
  const scripted = detection.has("ts") || detection.has("js");
  const format =
    detection.has("ts") && existsSync(join(root, "tsconfig.json"))
      ? "ts"
      : scripted &&
          (existsSync(join(root, "package.json")) ||
            atRoot("ts") ||
            atRoot("js"))
        ? "mjs"
        : "json";
  const scaffoldPath = join(root, `validate.config.${format}`);

  if (existingConfig && existingConfig !== scaffoldPath && force) {
    // --force is strictly "overwrite the same-path config": it must never
    // create a second config beside one in another format.
    process.stderr.write(
      pc.yellow(
        `Validate config already exists at ${existingConfig}; not creating ${scaffoldPath}. Delete or migrate it first.\n`,
      ),
    );
    return EXIT.CONFIG;
  }
  if (existingConfig && !force) {
    // Any existing config is the repo's config, whatever its format: a repo
    // that got validate.config.json before it gained TypeScript must still be
    // able to re-run init for the hook and the MCP entry.
    process.stderr.write(
      pc.yellow(
        `${basename(existingConfig)} already exists (use --force to overwrite)\n`,
      ),
    );
  } else {
    out.write(
      scaffoldPath,
      format === "json" ? STARTER_JSON : starterModule(langs, kitAtRoot),
      "",
    );
  }
  return undefined;
}

/**
 * Register the MCP server in .mcp.json so every teammate's agent gets the
 * validate-kit tools automatically. Merge-safe: existing servers and manual
 * edits to the validate-kit entry are never clobbered.
 */
function registerMcpServer(
  root: string,
  kitCommand: string,
  out: Writer,
): void {
  const mcpPath = join(root, ".mcp.json");
  try {
    const existing = existsSync(mcpPath)
      ? (JSON.parse(readFileSync(mcpPath, "utf8")) as {
          mcpServers?: Record<string, unknown>;
        })
      : {};
    const servers = existing.mcpServers ?? {};
    if (!servers["Tester.MCP"]) {
      servers["Tester.MCP"] = { command: kitCommand, args: ["mcp"] };
      out.write(
        mcpPath,
        `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`,
        "the Tester.MCP server",
      );
    }
  } catch (err) {
    process.stderr.write(
      pc.yellow(
        `Could not update ${mcpPath} (${err instanceof Error ? err.message : String(err)}) — add the validate-kit MCP server manually.\n`,
      ),
    );
  }
}

/**
 * Scaffold a starter validate config, the MCP entry, and the pre-commit and
 * pre-push hooks; `hook: false` and `mcp: false` leave those out, `dryRun`
 * writes nothing.
 */
export async function initCommand(flags: {
  force?: boolean;
  cwd?: string;
  hook?: boolean;
  mcp?: boolean;
  dryRun?: boolean;
}): Promise<number> {
  const root = resolve(flags.cwd ?? process.cwd());
  let existingConfig: string | undefined;
  try {
    existingConfig = findConfigFile(root);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG;
    }
    throw err;
  }

  const local = localKit(root);
  // Never a registry fetch (npx / dlx): the scaffolded command is either the
  // project's own installed bin or the machine-wide one on PATH.
  const kitCommand = local?.command ?? BIN;
  const out = writer(flags.dryRun === true);

  const stop = await scaffoldConfig(
    root,
    existingConfig,
    flags.force === true,
    local?.atRoot === true,
    out,
  );
  if (stop !== undefined) return stop;
  if (flags.mcp !== false) registerMcpServer(root, kitCommand, out);
  const hookExit =
    flags.hook === false
      ? undefined
      : await scaffoldHook(root, kitCommand, out);

  if (!local && !onPath(BIN) && (flags.mcp !== false || flags.hook !== false)) {
    // Fail-closed is correct here (a hook that cannot find the gate blocks
    // the commit), but say so now rather than at the first commit.
    process.stderr.write(
      pc.yellow(
        `\`${BIN}\` is not on PATH: the scaffolded hook and MCP entry will fail until it is installed on this machine.\n`,
      ),
    );
  }

  // The pre-push hook runs the ci profile, which needs every tool it plans.
  const doctor = flags.hook === false ? "doctor" : "doctor --profile ci";
  process.stdout.write(
    pc.dim(
      `\nRun \`${kitCommand} ${doctor}\` to verify your toolchain, then \`${kitCommand} check\`.\n`,
    ),
  );
  return hookExit ?? EXIT.CLEAN;
}
