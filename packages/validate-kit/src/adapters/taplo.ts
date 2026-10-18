import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import type {
  BuiltCommand,
  Finding,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { byConfigFolder, finding, fromRealCwd, relativeFiles } from "./base.js";

/** taplo's config names, searched upward from the folder it runs in. */
const CONFIGS = [".taplo.toml", "taplo.toml"];

/** `ERROR the file is not properly formatted path="/abs/a.toml"` */
const UNFORMATTED = /^ERROR the file is not properly formatted path="(.+)"$/;
/** What taplo prints after its findings: `ERROR operation failed error=...`. */
const FAILED = /^ERROR operation failed error=(.*)$/;
/** The location line of a diagnostic's code frame: `┌─ /abs/a.toml:1:9`. */
const FRAME = /^\s*┌─ (.+):(\d+):(\d+)$/;

/**
 * taplo — the TOML formatter (`taplo fmt`): a file it would lay out
 * otherwise is a finding at line 1, and a file that does not parse is an
 * error at the place it stops. Never `taplo lint`: it fetches JSON schemas
 * over the network, even under `--no-schema` for a `#:schema` directive.
 * Runs where the project adopted it: a `.taplo.toml` or `taplo.toml` at or
 * above the file (from that config's folder, where taplo finds it),
 * `tools.taplo.enabled` or `tools.taplo.configPath`. `--fix` runs
 * `taplo fmt`, which changes only whitespace and layout unless the config
 * asks to reorder keys. Recorded on 0.10.0:
 * docs/research/lint-toolchain/sota-2026-10-18/infra-files.md, 2.
 */
export const taplo: ToolAdapter = {
  id: "taplo",
  layer: "format",
  languages: ["toml"],
  bin: "taplo",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "0.10.0",
  installHint: "brew install taplo  (or: cargo install taplo-cli --locked)",
  findingExitCodes: [1],

  // taplo exits 0 for a file that does not exist: only existing ones go in.
  expand: (seed, env) => byConfigFolder(seed, env, "toml", CONFIGS),

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^(--check|--diff|--stdin-filepath)(=|$)/.test(arg))
      ? "the kit decides when taplo checks and when it writes, and reads its stderr"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    return {
      bin: this.bin,
      args: [
        "fmt",
        ...(ctx.fix ? [] : ["--check"]),
        "--colors",
        "never",
        ...(ctx.configPath ? ["--config", ctx.configPath] : []),
        ...ctx.extraArgs,
        // Relative, so the config's `exclude` matches them; with no file
        // taplo would format every TOML file under the folder.
        "--",
        ...relativeFiles(ctx, "taplo"),
      ],
      okExitCodes: [0, 1],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    // A config that does not parse is skipped in silence, and the run passes.
    const config =
      ctx.configPath ??
      CONFIGS.map((name) => join(ctx.cwd, name)).find((path) =>
        existsSync(path),
      );
    if (config !== undefined)
      try {
        parse(readFileSync(config, "utf8"));
      } catch (error) {
        throw new Error(
          `taplo's config ${config} is not valid TOML: ${(error as Error).message.split("\n")[0] ?? ""}`,
          { cause: error },
        );
      }
    const findings: Finding[] = [];
    // taplo prints absolute real paths.
    const fileOf = fromRealCwd(ctx.cwd);
    const lines = raw.stderr.split(/\r?\n/);
    let title = "";
    lines.forEach((text, i) => {
      if (text.startsWith("error: ")) title = text.slice("error: ".length);
      const failed = FAILED.exec(text)?.[1];
      if (
        failed !== undefined &&
        failed !== "some files were not properly formatted" &&
        failed !== "some files were not formatted due to syntax errors"
      )
        throw new Error(`taplo could not run: ${failed}`);
      const unformatted = UNFORMATTED.exec(text);
      if (unformatted?.[1])
        findings.push(
          finding({
            tool: "taplo",
            layer: "format",
            language: "toml",
            file: fileOf(unformatted[1]),
            line: 1,
            col: 1,
            severity: "warning",
            message: "File is not taplo-formatted",
            fixable: true,
          }),
        );
      const frame = FRAME.exec(text);
      if (frame?.[1]) {
        // The label under the frame's underline: `╰^ expected "]"`.
        const end = lines.findIndex((next, j) => j > i && next.trim() === "");
        const label = lines
          .slice(i + 1, end < 0 ? undefined : end)
          .map((next) => /\^ (.+)$/.exec(next)?.[1])
          .find(Boolean);
        findings.push(
          finding({
            tool: "taplo",
            layer: "format",
            language: "toml",
            file: fileOf(frame[1]),
            line: Number(frame[2]),
            col: Number(frame[3]),
            ruleId: "syntax",
            severity: "error",
            message: `${title || "invalid TOML"}${label ? `: ${label}` : ""}`,
            fixable: false,
          }),
        );
      }
    });
    // A file that is not UTF-8 (which TOML must be) is skipped in silence.
    // shortcut: reads each file once more; fine for TOML, which is small.
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    for (const file of ctx.files ?? []) {
      try {
        utf8.decode(readFileSync(file));
      } catch {
        findings.push(
          finding({
            tool: "taplo",
            layer: "format",
            language: "toml",
            file: toPosix(file),
            line: 1,
            col: 1,
            ruleId: "syntax",
            severity: "error",
            message: "not UTF-8, which TOML must be: taplo skips the file",
            fixable: false,
          }),
        );
      }
    }
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
