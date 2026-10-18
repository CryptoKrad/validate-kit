import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { gitSync, mainBase } from "../detect/git.js";
import { isUnder, toPosix } from "../detect/languages.js";
import { absPosix, finding, fromRealCwd } from "./base.js";
import {
  cargoAdopted,
  cargoEnv,
  cargoToml,
  chosenCrates,
  cratesAt,
  selectsPackages,
} from "./cargo.js";
import { formatChanged } from "./mutation.js";

interface SemverTask {
  /** The main branch's merge base with HEAD: the public API to keep. */
  base: string;
  /** The library crates to check (`-p`): name and folder (absolute, POSIX). */
  crates: { name: string; dir: string }[];
  /** The crate root's path in the git work tree, "" or ending in "/". */
  prefix: string;
}

/** `--- failure function_missing: pub fn removed or renamed ---` */
const FAILURE = /^--- failure (\S+): (.+) ---$/;
/**
 * `  function sema::sub, previously in file <baseline copy>/src/lib.rs:2`,
 * `  struct S in <crate>/src/lib.rs:4`
 */
const ITEM = /^\s+(.+?)(, previously)? in (?:file )?(.+):(\d+)$/;
/** `ref: https://doc.rust-lang.org/cargo/reference/semver.html#item-remove` */
const REF = /^\s*ref: (\S+)$/;
/** The baseline's copy: `<target>/semver-checks/git-<rev>/<sha>/<path in the repo>`. */
const BASELINE_COPY = /\/semver-checks\/[^/]+\/[0-9a-f]{40}\/(.+)$/;

const NO_BASE =
  "no main branch to compare the public API with (no origin/HEAD, origin/main or origin/master, as in a shallow CI checkout): fetch origin's default branch (fetch-depth: 0), or pass --trusted-ref";

/**
 * cargo-semver-checks — the crate's public API against the main branch's:
 * a public item removed or renamed, a function that takes another
 * argument, a trait that gained a required method, under a version number
 * that does not say so (a 0.x crate counts as major). Each failed item is
 * an error where it is now, or, removed, on its crate's Cargo.toml naming
 * it, with the version its crate needs. The main branch is origin's default
 * branch (`origin/HEAD`, else `origin/main` or `origin/master`), or the
 * trusted ref under --trusted-ref, at its merge base with HEAD; without one
 * the run cannot run (exit 3 under ci). A crate the main branch does not
 * have yet has no API to keep. For library crates where the Cargo.toml has
 * `[package.metadata.cargo-semver-checks]` (or the workspace's: every
 * member), a member's own table, or `tools.cargo-semver-checks.enabled`,
 * the `deep` tier: it builds both versions' rustdoc, fetching their
 * dependencies. Recorded on 0.51.0:
 * docs/research/lint-toolchain/sota-2026-10-18/rust-go.md, 2.
 */
export const cargoSemverChecks: ToolAdapter = {
  id: "cargo-semver-checks",
  layer: "lint",
  languages: ["rust"],
  // A cargo subcommand: called by name it needs cargo's `semver-checks` first.
  bin: "cargo-semver-checks",
  versionArgs: ["semver-checks", "--version"],
  parseVersion: (out) => /cargo-semver-checks (\d+\.\d+\.\d+)/.exec(out)?.[1],
  minVersion: "0.51.0",
  supportsFix: false,
  fixWriteBack: false,
  fileScoped: false,
  rootedAtMarker: true,
  optional: true,
  tier: "deep",
  timeoutMs: 600_000,
  installHint: "cargo install --locked cargo-semver-checks",
  adoptedAt: (root) => cargoAdopted(root, "cargo-semver-checks"),

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // Enabled: every library crate the run covers.
    const chosen =
      env.toolConfig.enabled === true
        ? []
        : chosenCrates(seed.cwd, "cargo-semver-checks");
    const every = chosen === "all" || chosen.length === 0;
    // Only a library has a public API to keep.
    const libraries = [...cratesAt(seed.cwd)].flatMap(([name, dir]) =>
      (every || chosen.includes(name)) &&
      (cargoToml(dir)?.lib !== undefined ||
        existsSync(join(dir, "src", "lib.rs")))
        ? [{ name, dir }]
        : [],
    );
    if (libraries.length === 0) return [];
    const base = mainBase(seed.cwd, env.trusted?.commit);
    if (!base) return [{ ...seed, cannotRun: NO_BASE }];
    // A crate the main branch does not have yet (the change that adds it)
    // has no API to keep, and the tool fails on it.
    const crates = libraries.filter(
      ({ dir }) =>
        gitSync(dir, ["cat-file", "-e", `${base}:./Cargo.toml`]) !== undefined,
    );
    if (crates.length === 0) return [];
    const task: SemverTask = {
      base,
      crates,
      prefix: gitSync(seed.cwd, ["rev-parse", "--show-prefix"])?.trim() ?? "",
    };
    return [{ ...seed, options: task }];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^--(baseline-[a-z]+|color)(=|$)/.test(arg))
      ? "the baseline and --color are the kit's: it compares with the main branch and reads the plain report"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as SemverTask;
    return {
      bin: this.bin,
      args: [
        "semver-checks",
        "--baseline-rev",
        task.base,
        "--color",
        "never",
        ...(selectsPackages(ctx.extraArgs)
          ? []
          : task.crates.flatMap((crate) => ["-p", crate.name])),
        ...ctx.extraArgs,
      ],
      // The baseline is cloned and built under the target dir.
      env: cargoEnv(ctx),
      // 100: a check failed; 101 an error (a bad revision, no manifest).
      okExitCodes: [0, 100],
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as SemverTask;
    const cwd = toPosix(ctx.cwd);
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });
    if (raw.exitCode === 0) return result([]);
    // stderr names each crate as it is checked, then what its version
    // needs: `Checking sema v1.0.0 -> v1.0.0 (...)`, then `Summary semver
    // requires new major version: 1 major and 0 minor checks failed`.
    const needs = new Map<string, string>();
    let checking = "";
    for (const line of raw.stderr.split(/\r?\n/)) {
      checking = /^\s*Checking (\S+) v/.exec(line)?.[1] ?? checking;
      const need = /^\s*Summary semver requires (.+?):/.exec(line)?.[1];
      if (need) needs.set(checking, need);
    }
    // An item's file as the project's: the baseline's copy names it from
    // the git top-level, the current tree by its real path.
    const real = fromRealCwd(cwd);
    const fileOf = (path: string): string | undefined => {
      const copy = BASELINE_COPY.exec(path)?.[1];
      if (copy === undefined) return real(path);
      return copy.startsWith(task.prefix)
        ? absPosix(cwd, copy.slice(task.prefix.length))
        : undefined;
    };
    const crateOf = (file: string | undefined) =>
      file === undefined
        ? undefined
        : task.crates
            .filter((crate) => isUnder(file, crate.dir))
            .toSorted((a, b) => b.dir.length - a.dir.length)[0];
    const blocks: {
      id: string;
      what: string;
      url?: string;
      items: {
        name: string;
        previously: boolean;
        path: string;
        line: number;
      }[];
    }[] = [];
    let listing = false;
    for (const line of raw.stdout.split(/\r?\n/)) {
      const head = FAILURE.exec(line.trim());
      if (head?.[1] && head[2]) {
        blocks.push({ id: head[1], what: head[2], items: [] });
        listing = false;
        continue;
      }
      const current = blocks.at(-1);
      if (!current) continue;
      if (line.trim() === "Failed in:") listing = true;
      const ref = REF.exec(line);
      if (ref?.[1] && current.url === undefined) current.url = ref[1];
      const item = listing ? ITEM.exec(line) : null;
      if (item?.[1] && item[3] && item[4])
        current.items.push({
          name: item[1],
          previously: item[2] !== undefined,
          path: toPosix(item[3]),
          line: Number(item[4]),
        });
    }
    if (blocks.length === 0)
      throw formatChanged(
        "cargo-semver-checks",
        "exited 100 (a check failed) but printed no `--- failure` block",
      );
    const findings: Finding[] = [];
    for (const block of blocks) {
      const at = (
        place: { file: string; line: number },
        ruleId: string,
        message: string,
      ) =>
        findings.push(
          finding({
            tool: "cargo-semver-checks",
            layer: "lint",
            language: "rust",
            ...place,
            col: 1,
            ruleId,
            severity: "error",
            message,
            fixable: false,
            ...(block.url ? { url: block.url } : {}),
          }),
        );
      if (block.items.length === 0)
        at(
          { file: absPosix(cwd, "Cargo.toml"), line: 1 },
          block.id,
          `${block.what} (no item named): restore it, or release a version that says so`,
        );
      for (const item of block.items) {
        const file = fileOf(item.path);
        const crate = crateOf(file);
        const need =
          needs.get(crate?.name ?? "") ??
          (needs.size === 1 ? [...needs.values()][0] : undefined);
        const why = `${need ? `; ${crate?.name ?? "the crate"} needs a ${need}` : ""}: restore it, or release that version`;
        if (!item.previously && file)
          at(
            { file, line: item.line },
            block.id,
            `${block.what}: ${item.name}${why}`,
          );
        // Gone from the tree: on its crate's Cargo.toml, the item in the
        // rule, so a baseline that accepts one removal accepts no other.
        else
          at(
            {
              file: crate
                ? posix.join(crate.dir, "Cargo.toml")
                : absPosix(cwd, "Cargo.toml"),
              line: 1,
            },
            `${block.id}:${item.name}`,
            `${block.what}: ${item.name}, previously at ${file ? posix.relative(cwd, file) : item.path}:${item.line}${why}`,
          );
      }
    }
    return result(findings);
  },
};
