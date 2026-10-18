import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

/**
 * One link of a chain: `- shop.web.page -> shop.svc.orders (l.3)`, then
 * indented `shop.svc.orders -> shop.db.client (l.1, l.4)`; a route with
 * several starts is `- shop.domain.a (l.1)` then `& shop.domain.b ->
 * shop.util.x (l.2)`. `(2 imports)` (acyclic_siblings) names no line.
 */
const LINK = /^(-|&)?\s*(\S+?)(?: -> (\S+))? \(l\.(\d+)(?:, (?:l\.)?\d+)*\)$/;
/** `shop.web is not allowed to import shop.db:` and the like. */
const HEADER = /^\S.*:$/;
/** The colour codes Rich writes when FORCE_COLOR is set. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** `Contracts: 0 kept, 1 broken.` */
const TOTALS = /^Contracts: (\d+) kept, (\d+) broken\.$/m;

/** A contract's name as a rule id: `the-web-layer-does-not-import-...`. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "contract";

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The file of a dotted module, in a src/ layout or at the root. */
function moduleFile(root: string, module: string): string | undefined {
  const parts = module.split(".");
  for (const base of [join(root, "src"), root]) {
    for (const file of [
      join(base, ...parts) + ".py",
      join(base, ...parts, "__init__.py"),
    ])
      if (existsSync(file)) return file;
  }
  return undefined;
}

/** Where the project keeps its contracts, and the line they start at. */
function contractsAt(
  root: string,
  configPath?: string,
): { file: string; line: number } | undefined {
  if (configPath) return { file: configPath, line: 1 };
  for (const [name, header] of [
    [".importlinter", /^\[importlinter\]/],
    ["pyproject.toml", /^\[tool\.importlinter\]/],
    ["setup.cfg", /^\[importlinter\]/],
  ] as const) {
    const text = read(join(root, name));
    if (text === undefined) continue;
    const at = text.split("\n").findIndex((line) => header.test(line));
    if (at >= 0) return { file: join(root, name), line: at + 1 };
  }
  return undefined;
}

/**
 * import-linter — the project's own contracts on which Python package may
 * import which (layers, forbidden, independence), read from its
 * `[tool.importlinter]`, `.importlinter` or `setup.cfg`. Each broken
 * contract is reported at the line of the import that starts the chain, in
 * the importing module, naming the whole chain. It has no JSON output, so
 * the text report is read (layer-rules.md); a broken contract it cannot
 * place is reported at the contracts' own line. It finds the root package
 * through the import path, so the project's `src/` and root are put on
 * PYTHONPATH. Recorded on 2.15: docs/research/lint-toolchain/layer-rules.md.
 */
export const importLinter: ToolAdapter = {
  id: "import-linter",
  layer: "lint",
  languages: ["python"],
  bin: "lint-imports",
  pythonEnv: true,
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  tier: "verify",
  optional: true,
  minVersion: "2.0.0",
  installHint:
    "uv add --dev import-linter  (or: uv tool install import-linter)",
  // Where this project keeps contracts: a dev dependency at a monorepo's
  // root must not adopt every nested project, which has none.
  adoptedAt: (root) => contractsAt(root) !== undefined,

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(verbose|debug|show-timings)$/.test(arg))
      ? "--verbose, --debug and --show-timings add text to the report the kit reads"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const src = join(ctx.cwd, "src");
    return {
      bin: this.bin,
      // --no-cache: otherwise it writes .import_linter_cache into the project.
      args: [
        "--no-logo",
        "--no-cache",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
      ],
      env: {
        // Rich wraps a piped report at 80 columns, splitting a long chain.
        COLUMNS: "100000",
        NO_COLOR: "1",
        PYTHONPATH: [
          existsSync(src) ? src : undefined,
          ctx.cwd,
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(delimiter),
      },
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const stdout = raw.stdout.replace(ANSI, "");
    const totals = TOTALS.exec(stdout);
    if (!totals)
      throw new Error(
        `import-linter checked no contract: ${`${stdout}\n${raw.stderr}`.trim().split("\n").at(-1) ?? ""}`,
      );
    const broken = Number(totals[2]);
    const cwd = toPosix(ctx.cwd);
    const findings: Finding[] = [];
    const report = (
      file: string,
      line: number,
      name: string,
      message: string,
    ) =>
      findings.push(
        finding({
          tool: "import-linter",
          layer: "lint",
          language: "python",
          file: absPosix(cwd, toPosix(file)),
          line,
          col: 1,
          ruleId: slug(name),
          severity: "error",
          message: `${name}: ${message}`,
          fixable: false,
        }),
      );
    // Each broken contract: its name underlined with dashes, then its block.
    const section = stdout.split(/^Broken contracts\n-+\n/m)[1] ?? "";
    const lines = section.split("\n");
    const contracts: { name: string; body: string[] }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() !== "" && /^-{3,}$/.test(lines[i + 1] ?? "")) {
        contracts.push({ name: line.trim(), body: [] });
        i++;
      } else contracts.at(-1)?.body.push(line);
    }
    const unplaced: string[] = [];
    for (const { name, body } of contracts) {
      let rule = "";
      let traced = true;
      let placed = false;
      for (let i = 0; i < body.length; i++) {
        const line = body[i] ?? "";
        if (!line.startsWith("-")) {
          if (HEADER.test(line)) rule = line.slice(0, -1);
          continue;
        }
        const first = LINK.exec(line);
        if (!first?.[2] || !first[4]) {
          traced = false;
          continue;
        }
        // The chain: its first module, then each module the links reach.
        const starts = [first[2]];
        const chain = first[3] ? [first[3]] : [];
        for (; i + 1 < body.length && /^\s+\S/.test(body[i + 1] ?? ""); i++) {
          const next = LINK.exec((body[i + 1] ?? "").trim());
          if (!next?.[2]) break;
          if (next[1] === "&") starts.push(next[2]);
          if (next[3]) chain.push(next[3]);
        }
        const file = moduleFile(ctx.cwd, first[2]);
        if (!file) {
          traced = false;
          continue;
        }
        placed = true;
        report(
          file,
          Number(first[4]),
          name,
          `${[starts.join(", "), ...chain].join(" -> ")}${rule ? ` (${rule})` : ""}`,
        );
      }
      if (!placed || !traced) unplaced.push(name);
    }
    // A broken contract the kit could not trace to an import, in full or
    // in part: at the contracts' own line.
    const at = contractsAt(ctx.cwd, ctx.configPath) ?? {
      file: join(ctx.cwd, "pyproject.toml"),
      line: 1,
    };
    for (const name of unplaced)
      report(
        at.file,
        at.line,
        name,
        "the contract is broken (not every import could be placed): run lint-imports for the details",
      );
    if (broken > 0 && findings.length === 0)
      throw new Error(
        `import-linter reports ${broken} broken contract(s) the kit could not read: its output format may have changed; refusing to report it.`,
      );
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
