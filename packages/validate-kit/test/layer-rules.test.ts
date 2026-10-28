import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyCruiser } from "../src/adapters/dependency-cruiser.js";
import { importLinter } from "../src/adapters/import-linter.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolContext,
} from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// Each output below was recorded (dependency-cruiser 18.6.0, import-linter
// 2.15) against a fixture with a forbidden import planted, then trimmed
// (docs/research/lint-toolchain/layer-rules.md).

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function ctx(cwd: string, options?: unknown): ToolContext {
  return { cwd, fix: false, extraArgs: [], options, tempDir: () => cwd };
}

function env(root: string, scoped: string[], options?: unknown): PlanEnv {
  return {
    projectRoot: root,
    scopedFiles: scoped.map((file) => `${root}/${file}`),
    config: {
      tools: options ? { "dependency-cruiser": { options } } : {},
      ignore: [],
    },
  } as unknown as PlanEnv;
}

/** dependency-cruiser's plan for `root`, as a run makes it. */
function cruisePlan(
  root: string,
  scoped: string[],
  options?: unknown,
): TaskSeed[] {
  return (dependencyCruiser.expand?.(
    { cwd: root },
    env(root, scoped, options),
  ) ?? []) as TaskSeed[];
}

const ran = (exitCode: number, stdout = "", stderr = ""): RawOutput => ({
  stdout,
  stderr,
  exitCode,
});

/** dependency-cruiser's report of `modules`, with its TypeScript compiler found or not. */
const compiler = (available: boolean) => ({
  environment: {
    transpilersFound: [
      { name: "typescript", version: ">=2.0.0 <7.0.0", available },
    ],
  },
});
const cruised = (modules: string[], available: boolean) =>
  JSON.stringify({
    modules: modules.map((source) => ({ source })),
    summary: { violations: [], ...compiler(available) },
  });

describe("dependency-cruiser", () => {
  const report = {
    modules: [
      { source: "src/ui/page.ts" },
      { source: "src/lib/a.ts" },
      { source: "src/lib/b.ts" },
    ],
    summary: {
      violations: [
        {
          type: "dependency",
          from: "src/ui/page.ts",
          to: "src/db/client.ts",
          unresolvedTo: "../db/client",
          rule: { severity: "error", name: "ui-not-to-db" },
        },
        {
          type: "cycle",
          from: "src/lib/a.ts",
          to: "src/lib/b.ts",
          unresolvedTo: "./b",
          rule: { severity: "warn", name: "no-circular" },
          cycle: [{ name: "src/lib/b.ts" }, { name: "src/lib/a.ts" }],
        },
        // A fixture the kit's config leaves out of scope.
        {
          type: "dependency",
          from: "fixtures/bad.ts",
          to: "src/db/client.ts",
          unresolvedTo: "../src/db/client",
          rule: { severity: "error", name: "ui-not-to-db" },
        },
      ],
      ruleSetUsed: {
        forbidden: [
          {
            name: "ui-not-to-db",
            comment: "The UI goes through the API, never the database layer.",
          },
          { name: "no-circular" },
        ],
      },
    },
  };

  it("reports each violation in scope at the import's line, with the rule's comment", () => {
    const root = tmp("vk-depcruise-");
    write(root, {
      // A comment quoting the specifier is not the import.
      "src/ui/page.ts":
        '/** Never import "../db/client" here. */\n\nimport { query } from "../db/client";\n',
      "src/lib/a.ts": '// The a side.\n\nimport { b } from "./b";\n',
    });
    const task = {
      paths: ["src"],
      scope: ["src/ui/page.ts", "src/lib/a.ts", "src/lib/b.ts"],
    };
    const result = dependencyCruiser.parseOutput(
      ran(0, JSON.stringify(report)),
      ctx(root, task),
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
        f.message,
      ]),
    ).toEqual([
      [
        "src/ui/page.ts",
        3,
        "ui-not-to-db",
        "error",
        "src/ui/page.ts → src/db/client.ts: The UI goes through the API, never the database layer.",
      ],
      [
        "src/lib/a.ts",
        3,
        "no-circular",
        "warning",
        "src/lib/a.ts → src/lib/b.ts → src/lib/a.ts",
      ],
    ]);
  });

  it("starts from src/, else each top-level folder with code, never every file", () => {
    const root = tmp("vk-depcruise-");
    write(root, {
      ".dependency-cruiser.cjs": "module.exports = {};\n",
      "node_modules/.keep": "",
      "src/a.ts": "",
      "web/b.ts": "",
      "vite.config.ts": "",
    });
    const scoped = ["src/a.ts", "web/b.ts", "vite.config.ts"];
    const plan = (options?: unknown) =>
      cruisePlan(root, scoped, options)[0]?.options as
        { paths: string[] } | undefined;
    expect(plan()?.paths).toEqual(["src"]);
    expect(plan({ paths: ["src", "web"] })?.paths).toEqual(["src", "web"]);
    const flat = tmp("vk-depcruise-");
    write(flat, {
      ".dependency-cruiser.cjs": "module.exports = {};\n",
      "node_modules/.keep": "",
      "web/b.ts": "",
      "api/c.ts": "",
      "eslint.config.js": "",
    });
    const [seed] = cruisePlan(flat, [
      "web/b.ts",
      "api/c.ts",
      "eslint.config.js",
    ]);
    expect((seed?.options as { paths: string[] } | undefined)?.paths).toEqual([
      "api",
      "web",
    ]);
    expect(
      dependencyCruiser.buildArgs(ctx(root, { paths: ["src"], scope: [] }))
        .args,
    ).toEqual(["--output-type", "json", "--config", "--", "src"]);
  });

  it("is adopted by its config only, and cannot run without one", () => {
    const root = tmp("vk-depcruise-");
    write(root, {
      "package.json": '{"devDependencies":{"dependency-cruiser":"18.6.0"}}\n',
      "node_modules/.keep": "",
      "src/a.ts": "",
    });
    expect(dependencyCruiser.adoptedAt?.(root, root)).toBe(false);
    const [seed] = cruisePlan(root, ["src/a.ts"]);
    expect(seed?.cannotRun).toMatch(/no .dependency-cruiser.js/);
    write(root, { ".dependency-cruiser.cjs": "module.exports = {};\n" });
    expect(dependencyCruiser.adoptedAt?.(root, root)).toBe(true);
  });

  it("refuses a report it cannot read, and the flags that change it", () => {
    const root = tmp("vk-depcruise-");
    const task = { paths: [], scope: [] };
    expect(() =>
      dependencyCruiser.parseOutput(
        ran(1, "", "ERROR: config not found"),
        ctx(root, task),
      ),
    ).toThrow(/no JSON report: ERROR: config not found/);
    expect(() =>
      dependencyCruiser.parseOutput(ran(0, "{}"), ctx(root, task)),
    ).toThrow(/no summary.violations/);
    // With TypeScript 7 only, 18.6.0 cruised no module of a .ts cycle and
    // reported none (docs/research/agent-tooling-gaps/gemini-2026-10-27).
    const both = { paths: ["src/"], scope: ["src/a.ts", "src/b.ts"] };
    expect(() =>
      dependencyCruiser.parseOutput(
        ran(0, cruised([], false)),
        ctx(root, both),
      ),
    ).toThrow(/read none of the TypeScript files under src\/: .*>=2\.0\.0 <7/);
    // A report from before the environment block: cruising no .ts says it.
    expect(() =>
      dependencyCruiser.parseOutput(
        ran(0, '{"modules":[],"summary":{"violations":[]}}'),
        ctx(root, both),
      ),
    ).toThrow(/read none of the TypeScript files/);
    // The config's own exclude leaving the .ts tests out is a real run.
    expect(
      dependencyCruiser.parseOutput(
        ran(0, cruised(["src/a.js"], true)),
        ctx(root, { paths: ["src"], scope: ["src/a.js", "src/a.test.ts"] }),
      ).findings,
    ).toEqual([]);
    expect(dependencyCruiser.refuseArgs?.(["--output-type", "err"])).toMatch(
      /JSON report/,
    );
  });
});

describe("import-linter", () => {
  const chain = `
Contracts: 0 kept, 2 broken.


----------------
Broken contracts
----------------

The web layer does not import the database layer
------------------------------------------------

shop.web is not allowed to import shop.db:

-   shop.web.page -> shop.svc.orders (l.3)
    shop.svc.orders -> shop.db.client (l.1)


Only svc touches db
-------------------

Illegal imports of protected package shop.db:

- shop.domain.c -> shop.db.client (l.1, 4)
`;
  // A layers route with two starting modules (recorded on 2.15).
  const layers = `
Contracts: 0 kept, 1 broken.


----------------
Broken contracts
----------------

Layers
------

shop.domain is not allowed to import shop.api:

- shop.domain.a (l.1)
  & shop.domain.b -> shop.util.x (l.2)
  shop.util.x -> shop.api.views (l.1)
`;

  it("reports each broken contract at the import that starts the chain, with its own heading", () => {
    const root = tmp("vk-importlinter-");
    write(root, {
      "src/shop/web/page.py": "",
      "src/shop/domain/c.py": "",
      "shop/domain/a.py": "",
    });
    const direct = importLinter.parseOutput(ran(1, chain), ctx(root));
    expect(
      direct.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.message,
      ]),
    ).toEqual([
      [
        "src/shop/web/page.py",
        3,
        "the-web-layer-does-not-import-the-database-layer",
        "The web layer does not import the database layer: shop.web.page -> shop.svc.orders -> shop.db.client (shop.web is not allowed to import shop.db)",
      ],
      // The heading is this contract's, not the one before it.
      [
        "src/shop/domain/c.py",
        1,
        "only-svc-touches-db",
        "Only svc touches db: shop.domain.c -> shop.db.client (Illegal imports of protected package shop.db)",
      ],
    ]);
    // A route with two starts, in a package at the root rather than src/;
    // colour codes from FORCE_COLOR are read through.
    const layered = importLinter.parseOutput(
      ran(1, layers.replace("Layers\n", "\u001b[1mLayers\u001b[0m\n")),
      ctx(root),
    );
    expect(
      layered.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.message,
      ]),
    ).toEqual([
      [
        "shop/domain/a.py",
        1,
        "Layers: shop.domain.a, shop.domain.b -> shop.util.x -> shop.api.views (shop.domain is not allowed to import shop.api)",
      ],
    ]);
  });

  it("places a contract it cannot trace in full at the contracts, and fails loud on no contract", () => {
    const root = tmp("vk-importlinter-");
    write(root, {
      "pyproject.toml": '[project]\nname = "shop"\n\n[tool.importlinter]\n',
      "src/shop/a.py": "",
    });
    // acyclic_siblings names no line; the module of the other is not here.
    const siblings = `Contracts: 0 kept, 1 broken.

----------------
Broken contracts
----------------

Siblings
--------

- shop.a -> shop.b (2 imports)
`;
    expect(
      importLinter
        .parseOutput(ran(1, siblings), ctx(root))
        .findings.map((f) => [f.file.slice(root.length + 1), f.line, f.ruleId]),
    ).toEqual([["pyproject.toml", 4, "siblings"]]);
    expect(
      importLinter.parseOutput(
        ran(0, "Contracts: 1 kept, 0 broken.\n"),
        ctx(root),
      ).findings,
    ).toEqual([]);
    expect(() =>
      importLinter.parseOutput(
        ran(1, "Could not read any configuration.\n"),
        ctx(root),
      ),
    ).toThrow(/checked no contract: Could not read any configuration/);
  });

  it("is adopted where the project keeps its own contracts, not by a dependency", () => {
    const root = tmp("vk-importlinter-");
    write(root, {
      "pyproject.toml":
        '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["import-linter"]\n',
    });
    expect(importLinter.adoptedAt?.(root, root)).toBe(false);
    write(root, { ".importlinter": "[importlinter]\nroot_package = x\n" });
    expect(importLinter.adoptedAt?.(root, root)).toBe(true);
    // Rich wraps a piped report at 80 columns unless told otherwise.
    expect(importLinter.buildArgs(ctx(root)).env?.COLUMNS).toBe("100000");
  });
});
