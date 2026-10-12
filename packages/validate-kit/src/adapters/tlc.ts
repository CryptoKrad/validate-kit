import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, posix } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
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
import { toPosix } from "../detect/languages.js";
import { absPosix, finding, toolOptions } from "./base.js";

/** TLC's names for the property violations a twin may be expected to show. */
const KINDS = ["safety", "liveness", "assert"] as const;
type ViolationKind = (typeof KINDS)[number];

/** A spec checked against one config. */
interface TlcModel {
  spec: string;
  config: string;
  /** "violation": a twin that must fail, proving the property can. */
  expect: "holds" | "violation";
  /** The violation the twin must show; any property violation without it. */
  kind?: ViolationKind;
}

/** What one task checks: a model, or specs that no model checks. */
type TlcTask = { model: TlcModel; workers: string } | { unmodelled: string[] };

const TlcOptions = z
  .object({
    models: z
      .array(
        z
          .object({
            spec: z.string().min(1),
            config: z.string().min(1),
            expect: z.enum(["holds", "violation"]).optional(),
            kind: z.enum(KINDS).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Twins by config glob (relative to the project root): every model whose
     * .cfg matches is expected to be violated, with `kind` if given (DV12).
     */
    violations: z
      .array(
        z
          .object({ config: z.string().min(1), kind: z.enum(KINDS).optional() })
          .strict(),
      )
      .optional(),
    /** TLC's -workers value; default "auto" for one model, 1 for several. */
    workers: z
      .union([z.literal("auto"), z.number().int().positive()])
      .optional(),
  })
  .strict();
type TlcOptions = z.infer<typeof TlcOptions>;

/** Exit codes from tlc2/output/EC.java, as recorded from TLC 2.19. */
const VIOLATIONS: Record<number, ViolationKind | "assumption" | "deadlock"> = {
  10: "assumption",
  11: "deadlock",
  12: "safety",
  13: "liveness",
  14: "assert",
};
const EVAL_FAILURES = new Set([75, 76, 77]);
const SPEC_PARSE_FAILURE = 150;
const CONFIG_PARSE_FAILURE = 151;
const STATE_SPACE_TOO_LARGE = 152;

const TRACE_CHARS = 2000;

const keyOf = (model: { spec: string; config: string }): string =>
  `${model.spec}\0${model.config}`;

/**
 * Comments out, read left to right as SANY does: `\*` to end of line, and
 * `(* … *)`, which nests. A `(*` inside a line comment opens nothing.
 * Newlines are kept, so line numbers still match the file.
 */
function uncommented(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "(*") {
      depth++;
      i++;
    } else if (depth > 0 && pair === "*)") {
      depth--;
      i++;
    } else if (depth === 0 && pair === "\\*") {
      const end = text.indexOf("\n", i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (depth === 0 || text[i] === "\n") {
      out += text.charAt(i);
    }
  }
  return out;
}

/** The file TLC reads for module `name` used from `spec`: its directory. */
function moduleFile(spec: string, name: string): string {
  return `${dirname(spec)}/${name}.tla`;
}

/** Modules a spec names with EXTENDS or INSTANCE. */
function referencedModules(spec: string): string[] {
  const text = uncommented(readFileSync(spec, "utf8"));
  const names: string[] = [];
  // EXTENDS takes a comma-separated list on one or more lines.
  for (const m of text.matchAll(/\bEXTENDS\s+(\w+(?:\s*,\s*\w+)*)/g))
    names.push(...(m[1] ?? "").split(/\s*,\s*/));
  for (const m of text.matchAll(/\bINSTANCE\s+(\w+)/g)) names.push(m[1] ?? "");
  return names;
}

/**
 * Every model in scope (`Name.cfg` and the variants `Name-<variant>.cfg`
 * beside `Name.tla`, plus configured ones), and the specs no model checks:
 * neither a model's spec nor a module one reaches through EXTENDS or
 * INSTANCE.
 */
function discover(
  specs: readonly string[],
  env: PlanEnv,
  options: TlcOptions,
): { models: TlcModel[]; unmodelled: string[] } {
  const configured = options.models;
  const models = new Map<string, TlcModel>();
  // Variants come from the scope, so include/ignore decide them as they
  // decide the specs (Apify keeps several models per spec this way).
  const scopedConfigs = env.scopedFiles.filter((file) => file.endsWith(".cfg"));
  for (const spec of specs) {
    const stem = spec.slice(0, -4);
    const config = `${stem}.cfg`;
    if (existsSync(config))
      models.set(keyOf({ spec, config }), { spec, config, expect: "holds" });
    for (const variant of scopedConfigs) {
      // A config named after another spec beside it is that spec's model.
      if (
        variant.startsWith(`${stem}-`) &&
        !variant.slice(stem.length + 1).includes("/") &&
        !existsSync(`${variant.slice(0, -4)}.tla`)
      )
        models.set(keyOf({ spec, config: variant }), {
          spec,
          config: variant,
          expect: "holds",
        });
    }
  }
  // Twins named by glob, then models listed one by one, which win.
  const twins = (options.violations ?? []).map((rule) => ({
    matches: picomatch(rule.config, { dot: true }),
    kind: rule.kind,
  }));
  const root = toPosix(env.projectRoot);
  for (const model of models.values()) {
    const config = posix.relative(root, model.config);
    const twin = twins.find(({ matches }) => matches(config));
    if (!twin) continue;
    model.expect = "violation";
    if (twin.kind) model.kind = twin.kind;
  }
  for (const model of configured ?? []) {
    const spec = absPosix(env.projectRoot, model.spec);
    const config = absPosix(env.projectRoot, model.config);
    models.set(keyOf({ spec, config }), {
      spec,
      config,
      expect: model.expect ?? "holds",
      ...(model.kind ? { kind: model.kind } : {}),
    });
  }
  // Module name -> spec files of that name, for following references.
  const byName = new Map<string, string[]>();
  for (const spec of specs) {
    const name = basename(spec, ".tla");
    const same = byName.get(name);
    if (same) same.push(spec);
    else byName.set(name, [spec]);
  }
  const reached = new Set<string>();
  const queue = [...models.values()].map((model) => model.spec);
  for (let spec = queue.pop(); spec !== undefined; spec = queue.pop()) {
    if (reached.has(spec) || !existsSync(spec)) continue;
    reached.add(spec);
    // TLC looks in the spec's own directory first; a module of that name
    // elsewhere counts only when there is none beside it (a library path).
    for (const name of referencedModules(spec)) {
      const local = moduleFile(spec, name);
      queue.push(...(existsSync(local) ? [local] : (byName.get(name) ?? [])));
    }
  }
  return {
    models: [...models.keys()]
      .toSorted()
      .flatMap((key) => models.get(key) ?? []),
    unmodelled: specs.filter((spec) => !reached.has(spec)),
  };
}

/** `-tool` output: every message is wrapped with its code and class. */
function toolMessages(
  stdout: string,
): { code: number; cls: number; text: string }[] {
  const re = /@!@!@STARTMSG (\d+):(\d+) @!@!@\n([\s\S]*?)@!@!@ENDMSG \1 @!@!@/g;
  return [...stdout.matchAll(re)].map((m) => ({
    code: Number(m[1]),
    cls: Number(m[2]),
    // A message can wrap another (1000 around 5001): keep only the text.
    text: (m[3] ?? "").replace(/@!@!@(START|END)MSG [^@]*@!@!@/g, "").trim(),
  }));
}

/** The first line of `file` that matches, or 0. */
function lineMatching(file: string, pattern: RegExp): number {
  if (!existsSync(file)) return 0;
  return (
    uncommented(readFileSync(file, "utf8"))
      .split("\n")
      .findIndex((line) => pattern.test(line)) + 1
  );
}

/**
 * Where `name` (a TLA+ identifier) is defined: the spec, or a module it
 * EXTENDS beside it (a model spec that wraps the real one), else the spec's
 * first line.
 */
function definitionOf(
  spec: string,
  name: string | undefined,
): { file: string; line: number } {
  if (!name) return { file: spec, line: 1 };
  const definition = new RegExp(`^\\s*${name}\\s*(\\(|==)`);
  for (const file of [
    spec,
    ...referencedModules(spec).map((module) => moduleFile(spec, module)),
  ]) {
    const line = lineMatching(file, definition);
    if (line > 0) return { file, line };
  }
  return { file: spec, line: 1 };
}

/**
 * A config that checks no invariant or property, with deadlock checking off
 * (in the config, or by `-deadlock` in tools.tlc.extraArgs).
 */
function checksNothing(config: string, deadlockOff: boolean): boolean {
  const text = uncommented(readFileSync(config, "utf8"));
  return (
    !/\b(INVARIANTS?|PROPERT(Y|IES))\b/.test(text) &&
    (deadlockOff || /\bCHECK_DEADLOCK\s+FALSE\b/.test(text))
  );
}

function error(
  file: string,
  line: number,
  ruleId: string,
  message: string,
): Finding {
  return finding({
    tool: "tlc",
    layer: "formal",
    file,
    line,
    col: 1,
    ruleId: `tlc/${ruleId}`,
    severity: "error",
    message,
    fixable: false,
  });
}

/** Why a passing run (exit 0) is still a problem, if it is. */
function passProblem(
  model: TlcModel,
  counts: string,
  label: string,
  deadlockOff: boolean,
): { ruleId: string; message: string } | undefined {
  if (model.expect === "violation")
    return {
      ruleId: "expected-violation",
      message: `${label} was expected to be violated and holds: as written, its property cannot fail`,
    };
  const distinct = Number(
    /([\d,]+) distinct states found/.exec(counts)?.[1]?.replaceAll(",", "") ??
      "0",
  );
  if (distinct <= 1)
    return {
      ruleId: "vacuous",
      message: `${label} explored ${distinct} distinct state(s): it checks nothing`,
    };
  if (checksNothing(model.config, deadlockOff))
    return {
      ruleId: "checks-nothing",
      message: `${label} lists no INVARIANT or PROPERTY and turns deadlock checking off`,
    };
  return undefined;
}

/**
 * A spec that does not parse, filed on the module SANY names: a syntax
 * error ("Encountered … at line N" in "module X") or a semantic one ("line N,
 * col C to … of module X" and the reason after it).
 */
function parseError(
  model: TlcModel,
  stdout: string,
  errors: string[],
  label: string,
): Finding {
  const semantic =
    /line (\d+), col \d+ to line \d+, col \d+ of module (\w+)\s+([^\n]+)/.exec(
      stdout,
    );
  // "Encountered … at line N" (parse) or "Lexical error at line N … Encountered".
  const syntax =
    /Encountered [^\n]*?at line (\d+), column \d+[^\n]*|Lexical error at line (\d+), column \d+[^\n]*/.exec(
      stdout,
    );
  const module =
    semantic?.[2] ??
    /Could not parse module (\w+) from file/.exec(stdout)?.[1] ??
    basename(model.spec, ".tla");
  const file = moduleFile(model.spec, module);
  const why = semantic?.[3] ?? syntax?.[0];
  return error(
    existsSync(file) ? file : model.spec,
    Number(semantic?.[1] ?? syntax?.[1] ?? syntax?.[2] ?? 1),
    "parse-error",
    `${errors.join(" ") || "TLC could not parse the spec"}${why ? `: ${why.trim()}` : ""} (${label})`,
  );
}

/**
 * TLC — the TLA+ model checker. A project-level tool: it finds every model
 * in scope itself, so a changed module or config re-runs the models that may
 * depend on it, and each task checks one model.
 */
export const tlc: ToolAdapter = {
  id: "tlc",
  layer: "formal",
  languages: [],
  bin: "tlc",
  inputs: [".tla"],
  supportsFix: false,
  fixWriteBack: false,
  tier: "verify",
  timeoutMs: 600_000,
  minVersion: "2.19.0",
  installHint:
    'TLA+ tools: tla2tools.jar from github.com/tlaplus/tlaplus/releases, Java 11+, and a `tlc` launcher on PATH that runs `exec java -cp tla2tools.jar tlc2.TLC "$@"`',
  versionArgs: ["-h"],
  // TLC prints its help, version included, and exits 1.
  versionExitCodes: [0, 1],
  parseVersion: (out) => {
    const m = /Version (\d+)\.(\d+)/.exec(out);
    return m ? `${m[1]}.${m[2]}.0` : undefined;
  },

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // A changed-file run re-checks the models only when a spec or a config
    // changed: anything a model reads.
    // Options are checked first: a typo is a config error in every run.
    const options = toolOptions(env, "tlc", TlcOptions);
    if (
      env.changedPaths &&
      !env.changedPaths.some(
        (path) => path.endsWith(".tla") || path.endsWith(".cfg"),
      )
    )
      return [];
    const specs = env.scopedFiles.filter((file) => file.endsWith(".tla"));
    if (specs.length === 0 && !options.models?.length) return [];
    const { models, unmodelled } = discover(specs, env, options);
    // Models run side by side, so each takes one worker unless told otherwise.
    const workers = String(options.workers ?? (models.length > 1 ? 1 : "auto"));
    const tasks: TaskSeed[] = models.map((model) => ({
      cwd: dirname(model.spec),
      options: { model, workers } satisfies TlcTask,
    }));
    if (unmodelled.length > 0)
      tasks.push({ cwd: seed.cwd, options: { unmodelled } satisfies TlcTask });
    return tasks;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as TlcTask;
    if ("unmodelled" in task) {
      // Nothing to run; parseOutput reports the specs no model checks.
      return { bin: "sh", args: ["-c", "true"] };
    }
    if (!ctx.tempDir) throw new Error("tlc needs the runner's temp directory");
    // TLC writes the standard modules (Naturals, Sequences, …) into Java's
    // temp directory and parses them from there; models running side by side
    // that share it read each other's half-written copies. Each run gets its
    // own, through JAVA_TOOL_OPTIONS, which reaches java whatever the launcher.
    const javaTmp = ctx.tempDir();
    return {
      bin: this.bin,
      args: [
        "-tool",
        "-workers",
        task.workers,
        // States go to the run's temp directory, never into the repository.
        "-metadir",
        ctx.tempDir(),
        "-config",
        task.model.config,
        // Relative to cwd (the spec's directory): given the spec as an
        // absolute path, TLC 2.19 cannot find a config kept elsewhere.
        basename(task.model.spec),
        ...ctx.extraArgs,
      ],
      env: {
        JAVA_TOOL_OPTIONS: [
          process.env["JAVA_TOOL_OPTIONS"],
          // Quoted: the JVM splits the variable at whitespace and has no
          // escape, so a path holding `"` is quoted with `'`.
          javaTmp.includes('"')
            ? `'-Djava.io.tmpdir=${javaTmp}'`
            : `"-Djava.io.tmpdir=${javaTmp}"`,
        ]
          .filter(Boolean)
          .join(" "),
      },
      cwd: dirname(task.model.spec),
      // Every exit reaches parseOutput, which reports TLC's own message for
      // the ones it does not know (153 system error, 255 e.g. no config).
      okExitCodes: "any",
      // The launcher may not `exec` java: a timeout must still reach it.
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as TlcTask;
    const result = (findings: Finding[]): RunResult => ({
      findings,
      filesProcessed: "unmodelled" in task ? task.unmodelled.length : 1,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    });

    if ("unmodelled" in task) {
      return result(
        task.unmodelled.map((spec) =>
          error(
            spec,
            1,
            "no-model",
            "No model checks this spec: add Name.cfg beside it, list it in tools.tlc.options.models, or EXTEND it from a modelled spec",
          ),
        ),
      );
    }

    const { model } = task;
    const messages = toolMessages(raw.stdout);
    const errors = messages.filter((m) => m.cls === 1).map((m) => m.text);
    const label = `model ${basename(model.config)}`;
    const code = raw.exitCode;
    const fail = (ruleId: string, message: string, line = 1): RunResult =>
      result([error(model.spec, line, ruleId, message)]);

    if (code === 0) {
      const counts = messages.find((m) => m.code === 2199)?.text ?? "";
      const problem = passProblem(
        model,
        counts,
        label,
        ctx.extraArgs.includes("-deadlock"),
      );
      return problem ? fail(problem.ruleId, problem.message) : result([]);
    }

    const violation = VIOLATIONS[code];
    if (violation && model.expect === "violation") {
      const wanted = model.kind ? `a ${model.kind}` : "a property";
      // A property violation, of the twin's kind if it names one; a
      // deadlock or a false ASSUME never counts.
      const allowed: readonly string[] = model.kind ? [model.kind] : KINDS;
      return allowed.includes(violation)
        ? result([])
        : fail(
            "expected-violation",
            `${label} was expected to show ${wanted} violation and failed with a ${violation} violation instead`,
          );
    }
    if (violation) {
      const what = errors[0] ?? `TLC reported a ${violation} violation`;
      const states = messages.filter((m) => m.code === 2217);
      const trace = states.map((m) => m.text).join("\n");
      const name =
        /(?:Invariant|Property|Action property) (\w+) is violated/.exec(
          what,
        )?.[1];
      const at = definitionOf(model.spec, name);
      return result([
        error(
          at.file,
          at.line,
          violation,
          `${what} (${label}, trace of ${states.length} states)${trace ? `\n${trace.slice(0, TRACE_CHARS)}` : ""}`,
        ),
      ]);
    }

    if (code === CONFIG_PARSE_FAILURE) {
      // e.g. "The invariant Inv specified in the configuration file is not
      // defined in the specification."
      const named = /^The \w+ (\w+) specified in the configuration/m.exec(
        errors.join("\n"),
      )?.[1];
      const line = named
        ? lineMatching(model.config, new RegExp(`\\b${named}\\b`))
        : 0;
      return result([
        error(
          model.config,
          line || 1,
          "config-error",
          `${errors.join(" ") || "TLC could not read the config"} (${label})`,
        ),
      ]);
    }

    if (code === SPEC_PARSE_FAILURE) {
      return result([parseError(model, raw.stdout, errors, label)]);
    }

    if (EVAL_FAILURES.has(code) || code === STATE_SPACE_TOO_LARGE) {
      return fail(
        code === STATE_SPACE_TOO_LARGE ? "state-space-too-large" : "eval-error",
        `${errors.join(" ") || `TLC exited ${code}`} (${label})`,
      );
    }

    // Without -tool messages (java did not start), the reason is in the plain
    // output; the JVM's "Picked up JAVA_TOOL_OPTIONS" banner is not it.
    const plain = `${raw.stderr}\n${raw.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("Picked up "))
      .slice(0, 3)
      .join(" ");
    throw new Error(
      `tlc exited ${code} (${label}): ${errors.join(" ") || plain || "no message"}`,
    );
  },
};
