import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { run } from "../core/exec.js";
import { isUnder, toPosix } from "./languages.js";

/**
 * The packages a change can break, for a changed-file golangci-lint run:
 * the changed packages and every package in the module that imports them,
 * directly or through its tests (docs/research/lint-toolchain/
 * golangci-changed-packages.md, 6). Linting only those reports, for each of
 * them, what `./...` reports, at 1–3 s instead of a whole module's 12–33 s.
 */
export interface ChangedPackages {
  /** `./dir` patterns, `.` for the module root; absent: the whole module. */
  patterns?: string[];
  /** Importers left out above the cap, which the full run checks. */
  skipped?: number;
}

/** Above this many packages a commit's run would cost a whole module's. */
export const PACKAGE_CAP = 50;

const DEPENDENCY_FILES = new Set([
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
]);

// One line per package. `go list ./...` lists no folder without buildable
// files, so every listed package is one a pattern can name.
const TEMPLATE = [
  "{{.ImportPath}}",
  "{{.Dir}}",
  '{{join .Imports " "}}',
  '{{join .TestImports " "}} {{join .XTestImports " "}}',
  "{{if .Error}}error{{end}}",
  '{{join .EmbedFiles " "}} {{join .CFiles " "}} {{join .HFiles " "}} {{join .SFiles " "}} {{join .CXXFiles " "}} {{join .SysoFiles " "}}',
].join("\t");

/** A folder `go list ./...` skips (`go help packages`), `""` the root. */
function hiddenFolder(rel: string): boolean {
  return rel
    .split("/")
    .some(
      (seg) => seg === "testdata" || seg.startsWith(".") || seg.startsWith("_"),
    );
}

/** Records that `by` imports `dep`. */
function link(map: Map<string, string[]>, dep: string, by: string): void {
  const list = map.get(dep);
  if (list) list.push(by);
  else map.set(dep, [by]);
}

interface Package {
  path: string;
  dir: string;
  imports: string[];
  testImports: string[];
  failed: boolean;
}

/**
 * Patterns for the module at `moduleDir` from the paths a change touched
 * (relative to `projectRoot`). `undefined`: nothing in the module changed
 * that golangci-lint reads, so no run. `{}` (no patterns): the whole module,
 * for a dependency or lint-config change, or when `go list` fails.
 */
export async function changedPackages(
  moduleDir: string,
  projectRoot: string,
  changedPaths: readonly string[],
  opts: { configPath?: string; env?: Record<string, string> } = {},
): Promise<ChangedPackages | undefined> {
  const module = toPosix(moduleDir);
  const root = toPosix(projectRoot);
  const changed = changedPaths.map((path) => posix.join(root, toPosix(path)));
  // The module a path belongs to: the nearest go.mod above it, even when its
  // folder was deleted. A nested module's paths are its own task's.
  const moduleOf = (file: string): string | undefined => {
    for (let dir = posix.dirname(file); isUnder(dir, root);) {
      if (existsSync(posix.join(dir, "go.mod"))) return dir;
      const parent = posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  };
  // What every package reads: its dependencies, and golangci-lint's own
  // settings (in its cache key, and its exclusions apply anywhere).
  const config = opts.configPath ? toPosix(opts.configPath) : undefined;
  if (
    changed.some(
      (file) =>
        file === config ||
        ((DEPENDENCY_FILES.has(posix.basename(file)) ||
          /^\.golangci\.(?:ya?ml|toml|json)$/.test(posix.basename(file))) &&
          isUnder(module, posix.dirname(file))),
    )
  )
    return {};
  const folderOf = (file: string): string =>
    posix.relative(module, posix.dirname(file));
  const own = changed.filter(
    (file) => moduleOf(file) === module && !hiddenFolder(folderOf(file)),
  );
  if (own.some((file) => folderOf(file).split("/")[0] === "vendor")) return {};
  if (own.length === 0) return undefined;

  const listed = await run("go", ["list", "-e", "-f", TEMPLATE, "./..."], {
    cwd: moduleDir,
    timeoutMs: 120_000,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (listed.spawnError || listed.exitCode !== 0) return {};
  const byPath = new Map<string, Package>();
  const bySource = new Map<string, Package>();
  for (const line of listed.stdout.split("\n")) {
    const [path, dir, imports, testImports, failed, sources] = line.split("\t");
    if (!path || dir === undefined) continue;
    const pkg: Package = {
      path,
      dir: toPosix(dir),
      imports: (imports ?? "").split(" ").filter(Boolean),
      testImports: (testImports ?? "").split(" ").filter(Boolean),
      failed: failed === "error",
    };
    byPath.set(pkg.path, pkg);
    for (const file of (sources ?? "").split(" ").filter(Boolean))
      bySource.set(posix.join(pkg.dir, file), pkg);
  }
  const modulePath = /^module\s+(\S+)/m.exec(
    existsSync(posix.join(module, "go.mod"))
      ? readFileSync(posix.join(module, "go.mod"), "utf8")
      : "",
  )?.[1];
  if (modulePath === undefined) return {};
  // A deleted package keeps its import path, which its importers still name.
  const pathOf = (dir: string): string => {
    const rel = posix.relative(module, dir);
    return rel === "" ? modulePath : `${modulePath}/${rel}`;
  };

  const changedPkgs = new Set<string>();
  // Only a change outside _test.go files reaches importers: an importer
  // never compiles another package's tests.
  const seeds = new Set<string>();
  for (const file of own) {
    let path: string | undefined;
    if (file.endsWith(".go")) path = pathOf(posix.dirname(file));
    else
      path = (
        bySource.get(file) ??
        // A deleted embedded file leaves the package that read it, the
        // deepest above it, with an error.
        [...byPath.values()]
          .filter((pkg) => pkg.failed && isUnder(file, pkg.dir))
          .toSorted((a, b) => b.dir.length - a.dir.length)[0]
      )?.path;
    if (path === undefined) continue;
    changedPkgs.add(path);
    if (!file.endsWith("_test.go")) seeds.add(path);
  }

  const importers = new Map<string, string[]>();
  const testImporters = new Map<string, string[]>();
  for (const pkg of byPath.values()) {
    for (const dep of pkg.imports)
      if (dep !== pkg.path) link(importers, dep, pkg.path);
    for (const dep of pkg.testImports)
      if (dep !== pkg.path) link(testImporters, dep, pkg.path);
  }
  const reached = new Set(seeds);
  const queue = [...seeds];
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const importer of importers.get(next) ?? [])
      if (!reached.has(importer)) {
        reached.add(importer);
        queue.push(importer);
      }
  // A package whose tests import one of them: one hop, since only its test
  // variant depends on it.
  const all = new Set([...changedPkgs, ...reached]);
  for (const path of reached)
    for (const tester of testImporters.get(path) ?? []) all.add(tester);

  // A deleted package has nothing left to lint; its importers do.
  const toPatterns = (paths: Iterable<string>): string[] =>
    [
      ...new Set(
        [...paths].flatMap((path) => {
          const pkg = byPath.get(path);
          if (!pkg) return [];
          const dir = posix.relative(module, pkg.dir);
          return [dir === "" ? "." : `./${dir}`];
        }),
      ),
    ].toSorted();
  const patterns = toPatterns(all);
  if (patterns.length === 0) return undefined;
  if (patterns.length > PACKAGE_CAP) {
    const changedOnly = toPatterns(changedPkgs);
    // Deleted packages with many importers: those are what to lint.
    return changedOnly.length === 0
      ? {}
      : {
          patterns: changedOnly,
          skipped: patterns.length - changedOnly.length,
        };
  }
  // About half the module or more: the same result, a shorter command.
  if (patterns.length * 2 > byPath.size) return {};
  return { patterns };
}
