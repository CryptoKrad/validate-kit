import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config/schema.js";
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
import { absPosix, finding, toolOptions } from "./base.js";

/** A Quint definition or module name, safe to pass to the shell. */
const QuintName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_:]*$/u, "not a Quint definition name");

const QuintOptions = z
  .object({
    specs: z
      .array(
        z
          .object({
            spec: z.string().min(1),
            /** Invariants the spec must keep, checked by simulation. */
            invariants: z.array(QuintName).optional(),
            /** The module to check, when the file holds several. */
            main: QuintName.optional(),
            init: QuintName.optional(),
            step: QuintName.optional(),
          })
          .strict(),
      )
      .optional(),
    /** Samples per test and per invariant run. */
    maxSamples: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional(),
    /** Fixed, so two runs give the same verdict. */
    seed: z
      .string()
      .regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/u, "a number or 0x… hex")
      .optional(),
  })
  .strict();

interface QuintTask {
  spec: string;
  invariants: string[];
  main?: string;
  /** The modules the file defines. */
  modules: string[];
  /** It defines `run` definitions, so `quint test` has something to run. */
  hasTests: boolean;
  init: string;
  step: string;
  maxSamples: number;
  maxSteps: number;
  seed: string;
  /** Another spec imports it, so it need not be checked on its own. */
  imported: boolean;
}

/**
 * Prints one JSON line for a step's `--out` file (without the module AST):
 * errors, test names, run status, and the trace as plain values (sets,
 * lists and tuples as arrays, records as objects, big integers as text).
 */
const SUMMARY = `
const fs = require("fs");
const [step, exit, file, log, invariant] = process.argv.slice(1);
let d;
try {
  d = JSON.parse(fs.readFileSync(file, "utf8"), (k, v, c) =>
    typeof v === "number" && !Number.isSafeInteger(v) && c && c.source ? c.source : v);
} catch {
  const tail = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").slice(-3).join(" ") : "";
  console.log(JSON.stringify({ step, exit: Number(exit), invariant, missing: true, tail }));
  process.exit(0);
}
const value = (e) => {
  if (!e) return "…";
  if (["int", "bool", "str"].includes(e.kind)) return e.value;
  if (e.kind === "app" && e.opcode === "Rec") {
    const record = {};
    for (let i = 0; i + 1 < e.args.length; i += 2) record[e.args[i].value] = value(e.args[i + 1]);
    return record;
  }
  if (e.kind === "app" && ["Set", "List", "Tup", "Map"].includes(e.opcode)) return e.args.map(value);
  return "…";
};
console.log(JSON.stringify({ step, exit: Number(exit), invariant, errors: d.errors || [],
  passed: d.passed, failed: d.failed, status: d.status, seed: d.seed,
  states: (d.trace || []).map(value) }));
`;

/**
 * typecheck (every module in the file); if it passed, test (when there are
 * tests) and one run per invariant, with the same main module, seed and
 * sample count. Each
 * writes `--out` JSON into the task's scratch directory and its console
 * output to a log beside it; node prints the summary lines.
 * `--backend typescript`: the Rust backend downloads itself on first use.
 */
const SCRIPT = `spec="$1"; out="$2"; main="$3"; tests="$4"; init="$5"; step="$6"; samples="$7"; steps="$8"; seed="$9"; shift 9
summary() { "$VK_NODE" -e "$VK_QUINT_SUMMARY" "$@"; }
quint typecheck --out "$out/typecheck.json" "$spec" > "$out/typecheck.log" 2>&1
status=$?; summary typecheck "$status" "$out/typecheck.json" "$out/typecheck.log"
[ "$status" = 0 ] || exit 0
if [ "$tests" = 1 ]; then
  quint test --backend=typescript \${main:+"--main=$main"} --seed="$seed" --max-samples="$samples" --out "$out/test.json" "$spec" > "$out/test.log" 2>&1
  summary test "$?" "$out/test.json" "$out/test.log"
fi
i=0
for inv in "$@"; do
  i=$((i + 1))
  quint run --backend=typescript \${main:+"--main=$main"} --out "$out/run-$i.json" --invariant="$inv" --init="$init" --step="$step" --max-samples="$samples" --max-steps="$steps" --seed="$seed" "$spec" > "$out/run-$i.log" 2>&1
  summary run "$?" "$out/run-$i.json" "$out/run-$i.log" "$inv"
done
`;

interface QuintError {
  explanation?: string;
  locs?: { source?: string; start?: { line: number; col: number } }[];
}

interface StepSummary {
  step: "typecheck" | "test" | "run";
  exit: number;
  invariant?: string;
  missing?: boolean;
  tail?: string;
  errors?: QuintError[];
  passed?: string[];
  failed?: string[];
  status?: string;
  states?: unknown[];
}

function error(
  file: string,
  line: number,
  col: number,
  ruleId: string,
  message: string,
): Finding {
  return finding({
    tool: "quint",
    layer: "formal",
    file,
    line,
    col,
    ruleId: `quint/${ruleId}`,
    severity: "error",
    message,
    fixable: false,
  });
}

/** Quint source without `//` and `/* … *\/` comments, newlines kept. */
function uncommented(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, (c) =>
    c.replaceAll(/[^\n]/g, " "),
  );
}

/** Finds definition lines in one spec, reading it once. */
function definitions(spec: string): (name: string) => number {
  const lines = uncommented(readFileSync(spec, "utf8")).split("\n");
  return (name) => {
    const definition = new RegExp(
      `^\\s*(?:pure\\s+)?(?:val|def|run|temporal|action)\\s+${name}\\b`,
    );
    return lines.findIndex((line) => definition.test(line)) + 1 || 1;
  };
}

/** Specs another spec imports (`import M.* from "./m"`, or `"m"`). */
function importedSpecs(texts: ReadonlyMap<string, string>): Set<string> {
  const imported = new Set<string>();
  for (const [spec, text] of texts) {
    for (const m of text.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const target = resolve(dirname(spec), m[1] ?? "");
      imported.add(target.endsWith(".qnt") ? target : `${target}.qnt`);
    }
  }
  return imported;
}

function stepFindings(
  task: QuintTask,
  summary: StepSummary,
  lineOf: (name: string) => number,
): Finding[] {
  if (summary.missing)
    throw new Error(
      `quint ${summary.step} wrote no result (exit ${summary.exit}): ${summary.tail || "no output"}`,
    );
  const errors = summary.errors ?? [];
  const findings = errors.map((e) => {
    const at = e.locs?.[0];
    // An error with no place, from a run, is about what the config named.
    if (!at && summary.step === "run")
      return error(
        task.spec,
        lineOf(summary.invariant ?? ""),
        1,
        "config-error",
        `invariant '${summary.invariant}': ${e.explanation ?? "quint could not run it"}`,
      );
    return error(
      at?.source ?? task.spec,
      (at?.start?.line ?? 0) + 1,
      (at?.start?.col ?? 0) + 1,
      "error",
      e.explanation ?? "quint reported an error",
    );
  });
  if (summary.step === "typecheck" && summary.exit !== 0 && errors.length === 0)
    throw new Error(
      `quint typecheck exited ${summary.exit} with no error: ${summary.tail || "no output"}`,
    );
  const main = task.main ? ` --main=${task.main}` : "";
  for (const name of summary.failed ?? [])
    findings.push(
      error(
        task.spec,
        lineOf(name),
        1,
        "test-failed",
        `test '${name}' failed; repeat: quint test --backend=typescript${main} --match=${name} --seed=${task.seed} --max-samples=${task.maxSamples} ${task.spec}`,
      ),
    );
  if (summary.step !== "run" || errors.length > 0) return findings;
  const states = summary.states ?? [];
  const at = lineOf(summary.invariant ?? "");
  const runs = `seed ${task.seed}, ${task.maxSamples} runs of up to ${task.maxSteps} steps`;
  const repeat = `quint run --backend=typescript${main} --invariant=${summary.invariant} --init=${task.init} --step=${task.step} --max-samples=${task.maxSamples} --max-steps=${task.maxSteps} --seed=${task.seed} ${task.spec}`;
  if (summary.status === "violation")
    findings.push(
      error(
        task.spec,
        at,
        1,
        "invariant",
        `invariant '${summary.invariant}' violated after ${Math.max(0, states.length - 1)} step(s) (${runs}); repeat: ${repeat}\n${states.map((s, i) => `${i}: ${JSON.stringify(s)}`).join("\n")}`,
      ),
    );
  else if (states.length <= 1)
    findings.push(
      error(
        task.spec,
        at,
        1,
        "vacuous",
        `invariant '${summary.invariant}' was checked on ${states.length === 0 ? "no state: init cannot hold" : "the initial state only: step never fires"} (${runs}); repeat: ${repeat}`,
      ),
    );
  return findings;
}

/**
 * Quint — specifications checked by its type checker, their tests, and
 * simulation of named invariants. Project-level: one task per `.qnt` file.
 * Simulation samples runs; it is not exhaustive checking.
 */
export const quint: ToolAdapter = {
  id: "quint",
  layer: "formal",
  languages: [],
  bin: "quint",
  inputs: [".qnt"],
  binSetting: false,
  supportsFix: false,
  fixWriteBack: false,
  tier: "verify",
  timeoutMs: 600_000,
  minVersion: "0.32.0",
  installHint:
    "Quint: `npm install -g @informalsystems/quint@0.32.0` (puts `quint` on PATH)",
  versionArgs: ["--version"],
  parseVersion: (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(_seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // Options are checked first: a typo is a config error in every run.
    const options = toolOptions(env, "quint", QuintOptions);
    const configured = new Map(
      (options.specs ?? []).map((entry, i) => {
        const spec = absPosix(env.projectRoot, entry.spec);
        if (!existsSync(spec))
          throw new ConfigError(
            `tools.quint.options.specs.${i}.spec: ${entry.spec} does not exist`,
          );
        return [spec, entry];
      }),
    );
    if (env.changedPaths && !env.changedPaths.some((p) => p.endsWith(".qnt")))
      return [];
    const specs = [
      ...new Set([
        ...env.scopedFiles.filter((file) => file.endsWith(".qnt")),
        ...configured.keys(),
      ]),
    ].toSorted();
    const texts = new Map(
      specs.map((spec) => [spec, uncommented(readFileSync(spec, "utf8"))]),
    );
    const imported = importedSpecs(texts);
    return specs.map((spec) => {
      const entry = configured.get(spec);
      const text = texts.get(spec) ?? "";
      const task: QuintTask = {
        spec,
        invariants: entry?.invariants ?? [],
        ...(entry?.main ? { main: entry.main } : {}),
        modules: [...text.matchAll(/^\s*module\s+([A-Za-z_]\w*)/gm)].map(
          (m) => m[1] ?? "",
        ),
        hasTests: /\brun\s+[A-Za-z_]\w*\s*=/.test(text),
        init: entry?.init ?? "init",
        step: entry?.step ?? "step",
        maxSamples: options.maxSamples ?? 10_000,
        maxSteps: options.maxSteps ?? 20,
        seed: options.seed ?? "0x1",
        imported: imported.has(spec),
      };
      return { cwd: dirname(spec), options: task };
    });
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as QuintTask;
    if (!ctx.tempDir)
      throw new Error("quint needs the runner's temp directory");
    return {
      bin: "sh",
      args: [
        "-c",
        SCRIPT,
        "validate-kit",
        task.spec,
        ctx.tempDir(),
        task.main ?? "",
        task.hasTests ? "1" : "0",
        task.init,
        task.step,
        String(task.maxSamples),
        String(task.maxSteps),
        task.seed,
        ...task.invariants,
      ],
      env: { VK_NODE: process.execPath, VK_QUINT_SUMMARY: SUMMARY },
      cwd: dirname(task.spec),
      okExitCodes: "any",
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as QuintTask;
    const summaries = raw.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as StepSummary);
    const typecheck = summaries.find((s) => s.step === "typecheck");
    // Every step it should have taken, or a summary went missing.
    const expected =
      typecheck?.exit === 0
        ? 1 + (task.hasTests ? 1 : 0) + task.invariants.length
        : 1;
    if (!typecheck || summaries.length < expected)
      throw new Error(
        `quint gave ${summaries.length} of ${expected} results: ${raw.stderr.trim().split("\n").slice(-3).join(" ") || "no output"}`,
      );
    const lineOf = definitions(task.spec);
    const findings = summaries.flatMap((s) => stepFindings(task, s, lineOf));
    // A file with several modules checks the one named after it, unless
    // `main` says otherwise: the others' tests would never run.
    if (task.modules.length > 1 && !task.main)
      findings.push(
        error(
          task.spec,
          1,
          1,
          "config-error",
          `This file defines modules ${task.modules.join(", ")}: name the one to check in tools.quint.options.specs[].main`,
        ),
      );
    const test = summaries.find((s) => s.step === "test");
    const tests = (test?.passed?.length ?? 0) + (test?.failed?.length ?? 0);
    // Type-correct and nothing else asked of it: nothing checks what it says.
    if (
      typecheck.exit === 0 &&
      summaries.every((s) => (s.errors ?? []).length === 0) &&
      tests === 0 &&
      task.invariants.length === 0 &&
      !task.imported
    )
      findings.push(
        error(
          task.spec,
          1,
          1,
          "unchecked",
          "Nothing checks this spec beyond its types: add tests (run …Test), or list its invariants in tools.quint.options.specs",
        ),
      );
    return {
      findings,
      filesProcessed: 1,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
