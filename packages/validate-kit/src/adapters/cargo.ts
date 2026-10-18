import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ToolContext } from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { cargoWorkspaceMembers } from "../detect/roots.js";
import { scratchOf } from "./base.js";

/**
 * What the Rust tools share: the cargo they run, where they build, and
 * which crates of a workspace they cover
 * (docs/research/lint-toolchain/sota-2026-10-18/rust-go.md).
 */

/** Where rustup puts its proxies: the cargo that honours `+toolchain`. */
export const RUSTUP_BIN = join(
  process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
  "bin",
);

const rustupPath = () => `${RUSTUP_BIN}${delimiter}${process.env.PATH ?? ""}`;

/**
 * The environment a cargo tool runs in: rustup's proxies first on PATH (a
 * Homebrew or mise cargo first knows no `+nightly` and finds no rustup
 * component), and a target dir of its own in the task's scratch folder: two
 * builds sharing one made a failing feature combination pass, and two rustc
 * versions writing one break each other (rust-go.md, 1).
 */
export function cargoEnv(ctx: ToolContext): Record<string, string> {
  return {
    PATH: rustupPath(),
    CARGO_TARGET_DIR: join(scratchOf(ctx), "target"),
  };
}

/** The parts of a Cargo.toml the Rust tools read. */
export interface CargoToml {
  package?: { name?: unknown; metadata?: Record<string, unknown> };
  workspace?: { metadata?: Record<string, unknown> };
  lib?: unknown;
}

/** The Cargo.toml in `dir`, parsed; undefined when there is none or it does not parse. */
export function cargoToml(dir: string): CargoToml | undefined {
  try {
    return parseToml(readFileSync(join(dir, "Cargo.toml"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The packages a run at `root` covers, by name: their folders (absolute,
 * POSIX). The root package, and a workspace's members (its `members`
 * globs less `exclude`).
 */
export function cratesAt(root: string): Map<string, string> {
  const crates = new Map<string, string>();
  for (const dir of [toPosix(root), ...(cargoWorkspaceMembers(root) ?? [])]) {
    const name = cargoToml(dir)?.package?.name;
    if (typeof name === "string") crates.set(name, dir);
  }
  return crates;
}

/**
 * Which crates at `root` chose `tool` by its metadata table: all of them,
 * by the root's `[workspace.metadata.<tool>]` or `[package.metadata.<tool>]`;
 * else the members whose own `[package.metadata.<tool>]` names it.
 */
export function chosenCrates(root: string, tool: string): "all" | string[] {
  const toml = cargoToml(root);
  if (
    toml?.package?.metadata?.[tool] !== undefined ||
    toml?.workspace?.metadata?.[tool] !== undefined
  )
    return "all";
  return [...cratesAt(root)].flatMap(([name, dir]) =>
    cargoToml(dir)?.package?.metadata?.[tool] === undefined ? [] : [name],
  );
}

/** Some crate at `root` chose `tool` by its metadata table. */
export function cargoAdopted(root: string, tool: string): boolean {
  const chosen = chosenCrates(root, tool);
  return chosen === "all" || chosen.length > 0;
}

/** Where a cargo run at a crate stands in its workspace. */
export interface CargoPlace {
  /**
   * The workspace root, spelled as the crate's folder is: rustc and Kani
   * name files relative to it, whichever member runs.
   */
  workspaceRoot: string;
  /** The run is at the root, so it must name every member (`--workspace`). */
  atRoot: boolean;
}

/** The project's own `-p`, `--workspace` or `--exclude`. */
export const selectsPackages = (extraArgs: readonly string[]): boolean =>
  extraArgs.some((arg) =>
    /^(-p|--package|--workspace|--all|--exclude)(=|$)/.test(arg),
  );

/**
 * `--workspace` for a run at a workspace root, which otherwise covers only
 * the root package and passes with every member unchecked; nothing when the
 * project's own arguments pick the packages.
 */
export function everyMember(ctx: ToolContext): string[] {
  return (ctx.options as CargoPlace).atRoot && !selectsPackages(ctx.extraArgs)
    ? ["--workspace"]
    : [];
}

/** `dir`'s workspace, as cargo finds it; `dir` itself when cargo cannot say. */
export function cargoPlace(dir: string): CargoPlace {
  const own = toPosix(dir);
  try {
    const manifest = execFileSync(
      "cargo",
      ["locate-project", "--workspace", "--message-format", "plain"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: rustupPath() },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    // cargo names real paths (/private/var on macOS).
    const up = posix.relative(
      toPosix(realpathSync(dir)),
      toPosix(dirname(manifest)),
    );
    return { workspaceRoot: posix.join(own, up), atRoot: up === "" };
  } catch {
    return { workspaceRoot: own, atRoot: true };
  }
}
