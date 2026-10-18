import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";
import { hunkStarts, relativeFiles } from "./schemas-iac.js";

/**
 * OpenTofu fmt — Terraform and OpenTofu files (`.tf`, `.tfvars`, `.tofu`,
 * `.tftest.hcl`)
 * not in the canonical HCL layout, one finding per changed block, from
 * `tofu fmt -check -diff` (exit 3); `--fix` rewrites them (`tofu fmt`,
 * layout only). The default formatter wherever such files are, as gofmt is
 * for Go. Never `tofu init` or `validate`: init downloads providers and
 * writes `.terraform/` into the project. Recorded on 1.13.1:
 * docs/research/lint-toolchain/sota-2026-10-18/schemas-iac.md, 5.
 */
export const tofu: ToolAdapter = {
  id: "tofu",
  layer: "format",
  languages: ["terraform"],
  bin: "tofu",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "1.13.1",
  installHint: "brew install opentofu",
  parseVersion: (out) => /OpenTofu v(\d+\.\d+\.\d+)/.exec(out)?.[1],
  // 3: files would change; 2: a bad path or a file that does not parse; 1:
  // a bad flag. The last two are crashes, on stderr.
  findingExitCodes: [3],

  // `tofu fmt` refuses a named `.tf.json` or `.tfvars.json` (exit 2,
  // "Invalid file extension"); walking a folder, it skips them.
  expand(seed) {
    const files = seed.files?.filter((file) => !file.endsWith(".json"));
    if (files === undefined) return [seed];
    return files.length > 0 ? [{ ...seed, files }] : [];
  },

  refuseArgs: (extraArgs) =>
    extraArgs.some((arg) => /^-(check|diff|list|write)(=|$)/.test(arg))
      ? "the kit sets -check, -diff, -list and -write"
      : undefined,

  buildArgs(ctx: ToolContext): BuiltCommand {
    const files = relativeFiles(ctx);
    return {
      bin: this.bin,
      args: [
        "fmt",
        ...(ctx.fix ? [] : ["-check", "-diff"]),
        "-recursive",
        "-no-color",
        ...ctx.extraArgs,
        ...(files.length > 0 ? files : ["."]),
      ],
      okExitCodes: ctx.fix ? [0] : [0, 3],
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const findings = ctx.fix
      ? []
      : hunkStarts(raw.stdout, "new/").map(({ file, line }) =>
          finding({
            tool: "tofu",
            layer: "format",
            language: "terraform",
            file: absPosix(ctx.cwd, file),
            line,
            col: 1,
            severity: "warning",
            message:
              "not in OpenTofu's canonical format: run `tofu fmt` (or `check --fix`)",
            fixable: true,
          }),
        );
    return {
      findings,
      filesProcessed: ctx.files?.length ?? 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
