import type {
  BuiltCommand,
  RawOutput,
  RunResult,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { biomeFiles, prettierAdopted } from "../detect/adoption.js";
import { languageForFile } from "../detect/languages.js";
import { absPosix, finding } from "./base.js";

function jsFiles(ctx: ToolContext): string[] {
  if (ctx.files && ctx.files.length > 0) {
    return ctx.files.filter((f) =>
      /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs|json|css|md)$/.test(f),
    );
  }
  // Full-mode default: format SOURCE files only. Deliberately excludes json/yaml
  // so `--fix` never rewrites a consumer's lockfile or tsconfig. (prettier skips
  // node_modules by default; staging a .json explicitly still formats it.)
  return ["**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,css,scss,md,mdx}"];
}

/** prettier — JS/TS/JSON/CSS/MD formatter. Optional (only runs if installed). */
export const prettier: ToolAdapter = {
  id: "prettier",
  layer: "format",
  languages: ["ts", "js"],
  bin: "prettier",
  supportsFix: true,
  fixWriteBack: true,
  optional: true,
  minVersion: "3.0.0",
  installHint: "pnpm add -D prettier",
  adoptedAt: prettierAdopted,
  replacedIn: biomeFiles,
  adoptHint:
    "Add a prettier config, a `prettier` key or dependency in package.json, or set `tools.prettier.enabled: true`.",
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  buildArgs(ctx: ToolContext): BuiltCommand {
    const args = ctx.fix ? ["--write"] : ["--list-different"];
    if (ctx.configPath) args.push("--config", ctx.configPath);
    args.push(...ctx.extraArgs, ...jsFiles(ctx));
    // 0 = clean, 1 = files differ, 2 = "no matching files" (treated as no findings).
    return { bin: this.bin, args, okExitCodes: [0, 1, 2] };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    if (raw.exitCode === 2) {
      const text = `${raw.stdout}\n${raw.stderr}`;
      if (!/No files matching the pattern were found/.test(text)) {
        const firstLine = text
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean);
        throw new Error(
          `prettier failed with exit code 2${firstLine ? `: ${firstLine}` : ""}`,
        );
      }
    }

    const findings = [];
    if (!ctx.fix) {
      for (const line of raw.stdout.split("\n")) {
        const file = line.trim();
        if (!file) continue;
        const lang = languageForFile(file);
        findings.push(
          finding({
            tool: "prettier",
            layer: "format",
            language: lang,
            file: absPosix(ctx.cwd, file),
            line: 1,
            col: 1,
            severity: "warning",
            message: "File is not prettier-formatted",
            fixable: true,
          }),
        );
      }
    }
    return {
      findings,
      filesProcessed: 0,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
