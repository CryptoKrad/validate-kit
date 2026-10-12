import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { z } from "zod";
import type {
  BuiltCommand,
  Finding,
  PlanEnv,
  RawOutput,
  RunResult,
  Severity,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../core/types.js";
import { absPosix, finding, toolOptions } from "./base.js";

const LAKEFILES = new Set(["lakefile.lean", "lakefile.toml"]);
/** Files a Lake build reads besides the sources. */
const LAKE_INPUTS = new Set([
  ...LAKEFILES,
  "lean-toolchain",
  "lake-manifest.json",
]);
const MESSAGE_CHARS = 2000;

const LeanOptions = z
  .object({
    /** Axioms the project declares on purpose, by full name. */
    allowAxioms: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** One Lake project: its build, then the audit of what it built. */
interface LakeTask {
  kind: "lake";
  root: string;
  lakefile: string;
  /** The `.lean` files this project owns. */
  files: string[];
  allowAxioms: string[];
}
/** One `.lean` file outside every Lake project. */
interface FileTask {
  kind: "file";
  file: string;
  allowAxioms: string[];
}
type LeanTask = LakeTask | FileTask;

interface At {
  file: string;
  line: number;
  col: number;
}

function report(
  at: At,
  ruleId: string,
  message: string,
  severity: Severity = "error",
): Finding {
  return finding({
    tool: "lean",
    layer: "formal",
    ...at,
    ruleId: `lean/${ruleId}`,
    severity,
    message: message.slice(0, MESSAGE_CHARS),
    fixable: false,
  });
}

/** A Lean message as a finding: `sorry` is an error, info is dropped. */
function diagnostic(
  at: At,
  severity: string,
  message: string,
  sorry: boolean,
): Finding | undefined {
  if (sorry) return report(at, "sorry", message);
  if (severity === "error") return report(at, "error", message);
  if (severity === "warning") return report(at, "warning", message, "warning");
  return undefined;
}

interface LeanMessage {
  pos?: { line: number; column: number };
  severity?: string;
  kind?: string;
  data?: string;
}

/** `--json` output: one object per line; other lines are not Lean's. */
function jsonMessages(text: string): LeanMessage[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as LeanMessage);
}

/**
 * Runs after a successful build, on stdin to plain `lean --stdin --run`
 * (no Lake, so no lakefile code runs). Its search path is the build
 * directory (VK_LEAN_AUDIT_LIB) and, for a Lake project (VK_LEAN_AUDIT_ROOT),
 * every package in its lake-manifest.json. It imports the modules this
 * build produced (VK_LEAN_AUDIT_MODULES, from Lake's trace; else every
 * .olean in the directory), which runs none of their initializers, and
 * prints each declaration of theirs, private ones included, that rests on
 * an axiom besides Lean's own: its name, module and line. Then how many it
 * audited. Axioms are what Lean recorded when it wrote each `.olean`, so a
 * `sorry` counts however it was hidden.
 */
const AUDIT_PROGRAM = `import Lean
open Lean System

abbrev EnvM := StateM Environment
instance : MonadEnv EnvM where
  getEnv := get
  modifyEnv f := modify f

partial def oleans (dir : FilePath) (pre : String := "") : IO (Array String) := do
  let mut out := #[]
  for e in ← dir.readDir do
    if ← e.path.isDir then
      out := out ++ (← oleans e.path s!"{pre}{e.fileName}/")
    else if e.path.extension == some "olean" then
      out := out.push s!"{pre}{e.path.fileStem.getD ""}"
  return out

def packages (root : FilePath) : IO (List FilePath) := do
  let manifest := root / "lake-manifest.json"
  unless ← manifest.pathExists do return []
  let j ← IO.ofExcept (Json.parse (← IO.FS.readFile manifest))
  let dir := (j.getObjValAs? String "packagesDir").toOption.getD ".lake/packages"
  let pkgs := (j.getObjValAs? (Array Json) "packages").toOption.getD #[]
  return pkgs.toList.map fun p =>
    let name := (p.getObjValAs? String "name").toOption.getD ""
    let base : FilePath := match (p.getObjValAs? String "type").toOption with
      | some "path" => root / (p.getObjValAs? String "dir").toOption.getD name
      | _ => match (p.getObjValAs? String "subDir").toOption with
        | some sub => root / dir / name / sub
        | none => root / dir / name
    base / ".lake" / "build" / "lib" / "lean"

def standard : NameSet := [\`\`propext, \`\`Classical.choice, \`\`Quot.sound].foldl (·.insert ·) {}

def main : IO Unit := do
  try
    let some lib ← IO.getEnv "VK_LEAN_AUDIT_LIB"
      | throw (IO.userError "VK_LEAN_AUDIT_LIB is not set")
    let deps ← match ← IO.getEnv "VK_LEAN_AUDIT_ROOT" with
      | some root => packages root
      | none => pure []
    initSearchPath (← findSysroot) (lib :: deps)
    let listed ← match ← IO.getEnv "VK_LEAN_AUDIT_MODULES" with
      | some file => pure ((← IO.FS.lines file).filter (· != ""))
      | none => oleans lib
    let mut mods : Array Name := #[]
    for m in listed do
      if ← (System.FilePath.mk lib / (m ++ ".olean")).pathExists then
        mods := mods.push ((m.splitOn "/").foldl Name.str .anonymous)
    let env ← importModules (mods.map fun m => { module := m }) {} (trustLevel := 1024)
    let own : NameSet := mods.foldl (·.insert ·) {}
    let mut audited := 0
    for (n, _) in env.constants.map₁.toList do
      let some idx := env.getModuleIdxFor? n | continue
      let some mod := env.header.moduleNames[idx.toNat]? | continue
      let user := privateToUserName n
      let range := declRangeExt.find? env n
      -- Lean's own auxiliary declarations have no place in the source; a
      -- name the user wrote with a leading _ does.
      if !own.contains mod || (user.isInternalDetail && range.isNone) then continue
      audited := audited + 1
      let (axs, _) := (collectAxioms n : EnvM (Array Name)).run env
      let extra := axs.filter (!standard.contains ·)
      if !extra.isEmpty then
        let line := (range.map (·.selectionRange.pos.line)).getD 1
        IO.println (Json.compress (Json.mkObj [("decl", toJson user.toString), ("module", toJson mod.toString), ("line", toJson line), ("axioms", toJson (extra.map (·.toString)))]))
    IO.println (Json.compress (Json.mkObj [("audited", toJson audited), ("modules", toJson mods.size)]))
  catch e =>
    IO.println (Json.compress (Json.mkObj [("error", toJson e.toString)]))
`;

/** The audit program on stdin, its output on stderr. */
const RUN_AUDIT = `exec lean --stdin --run 1>&2 <<'VALIDATE_KIT_AUDIT'\n${AUDIT_PROGRAM}VALIDATE_KIT_AUDIT\n`;

/** A character that can be part of a Lean name. */
const NAME_CHAR = /[\p{L}\p{N}_'!?]/u;
const CHAR_LITERAL = /^'(?:\\.|[^\\'\n])'/;

/** Text as spaces, newlines kept. */
function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, " ");
}

/** Index of the `"` closing the string opened at `start`. */
function stringEnd(text: string, start: number, interpolated: boolean): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') {
    if (text[j] === "\\") j += 2;
    else if (interpolated && text[j] === "{") j = codeEnd(text, j + 1);
    else j++;
  }
  return j;
}

/** Index just past the `}` closing an interpolation opened before `start`. */
function codeEnd(text: string, start: number): number {
  let depth = 1;
  let j = start;
  while (j < text.length && depth > 0) {
    const literal =
      text[j] === "'" && !NAME_CHAR.test(text[j - 1] ?? "")
        ? CHAR_LITERAL.exec(text.slice(j, j + 8))?.[0]
        : undefined;
    if (literal) j += literal.length;
    else if (text[j] === '"') j = stringEnd(text, j, text[j - 1] === "!") + 1;
    else {
      depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
      j++;
    }
  }
  return j;
}

/**
 * Lean source with comments (and, unless kept, string and character
 * literals) blanked to spaces, newlines kept, so positions still match the
 * file. Block comments `/- … -/` nest; `--` runs to the end of the line;
 * raw strings `r#"…"#` have no escapes; `s!"…{…}…"` holds code.
 */
function codeOnly(text: string, keepStrings = false): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const pair = text.slice(i, i + 2);
    const afterName = NAME_CHAR.test(text[i - 1] ?? "");
    const raw = afterName ? undefined : /^r(#*)"/.exec(text.slice(i, i + 32));
    const literal =
      c === "'" && !afterName
        ? CHAR_LITERAL.exec(text.slice(i, i + 8))?.[0]
        : undefined;
    let end: number;
    if (pair === "/-" || (depth > 0 && pair === "-/")) {
      depth += pair === "/-" ? 1 : -1;
      end = i + 1;
    } else if (depth > 0) {
      end = i;
    } else if (pair === "--") {
      const newline = text.indexOf("\n", i);
      end = (newline === -1 ? text.length : newline) - 1;
    } else if (keepStrings) {
      out += c;
      continue;
    } else if (raw) {
      const close = text.indexOf(`"${raw[1]}`, i + raw[0].length);
      end = close === -1 ? text.length - 1 : close + (raw[1]?.length ?? 0);
    } else if (c === '"') {
      end = stringEnd(text, i, text[i - 1] === "!");
    } else if (literal) {
      end = i + literal.length - 1;
    } else {
      out += c;
      continue;
    }
    out += blank(text.slice(i, end + 1));
    i = end;
  }
  return out;
}

/** Each match of `pattern` (global) in `text`, as a position in `file`. */
function positions(file: string, text: string, pattern: RegExp): At[] {
  return [...text.matchAll(pattern)].map((m) => {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    return { file, line, col: m.index - before.lastIndexOf("\n") };
  });
}

/** Commands that run code while a module builds, wherever they stand. */
const RUNS_CODE =
  /(?<![\p{L}\p{N}_'!?.#])(?:#eval!?|#exec|run_cmd|run_elab|run_meta|builtin_initialize|initialize|elab_rules|elab)(?![\p{L}\p{N}_'!?])/gu;
const KERNEL_OFF = /\bdebug\.skipKernelTC\b/gu;

/**
 * What the build cannot vouch for: code that runs while it builds (it can
 * print anything, Lake's own lines included), and declarations added
 * without the kernel checking them, which the axiom audit then trusts.
 */
function sourceFindings(files: readonly string[]): Finding[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const code = codeOnly(text);
    // A lakefile may set the option inside a string (-D…, leanOptions).
    const options = LAKEFILES.has(basename(file))
      ? file.endsWith(".lean")
        ? codeOnly(text, true)
        : text.replaceAll(/#.*$/gm, "")
      : code;
    return [
      ...positions(file, code, RUNS_CODE).map((at) =>
        report(
          at,
          "runs-code",
          "Code that runs while the project builds can print or write anything, Lake's own output included: the gate cannot vouch for what this build reports. Keep it out of proof files, or turn lean/runs-code off for files you trust",
          "warning",
        ),
      ),
      ...positions(file, options, KERNEL_OFF).map((at) =>
        report(
          at,
          "kernel-off",
          "debug.skipKernelTC adds declarations the kernel never checked, and the axiom audit trusts them: remove it",
        ),
      ),
    ];
  });
}

interface AuditLine {
  modules?: number;
  decl?: string;
  module?: string;
  line?: number;
  axioms?: string[];
  audited?: number;
  error?: string;
}

function why(axioms: readonly string[]): string {
  if (axioms.includes("sorryAx"))
    return "a sorry, here or in what it uses, whether the build warned about it or not";
  if (axioms.some((a) => a.includes("._native.")))
    return "a native-evaluation axiom (native_decide): it trusts the compiler, not the kernel";
  return "an axiom besides Lean's own (propext, Classical.choice, Quot.sound): list it in tools.lean.options.allowAxioms if it is meant";
}

/** A name with a part starting `_`: Lean's own (or one the user chose so). */
function auxiliary(decl: string): boolean {
  return /(^|\.)_/.test(decl);
}

/** A module name as a key: `«…»` quoting is how Lean prints, not the name. */
function moduleKey(module: string): string {
  return module.replaceAll(/[«»]/g, "");
}

/**
 * The audit's answers as findings, at each declaration's own line, in the
 * file its module was built from.
 */
function auditFindings(
  output: string,
  fileOf: (module: string) => string | undefined,
  fallback: At,
  allowAxioms: readonly string[],
  reported: readonly Finding[],
  expectedModules: number,
): Finding[] {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const answers = lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as AuditLine);
  const allowed = new Set(allowAxioms);
  const findings: Finding[] = [];
  // Auxiliary declarations (a native_decide's axiom) share their parent's
  // line: one finding per line, the user's own declaration first.
  answers.sort(
    (a, b) => Number(auxiliary(a.decl ?? "")) - Number(auxiliary(b.decl ?? "")),
  );
  const flagged = new Set<string>();
  for (const answer of answers) {
    if (answer.error !== undefined)
      findings.push(
        report(fallback, "audit-error", `axiom audit: ${answer.error}`),
      );
    const extra = (answer.axioms ?? []).filter((a) => !allowed.has(a));
    if (!answer.decl || extra.length === 0) continue;
    const file = answer.module ? fileOf(moduleKey(answer.module)) : undefined;
    const at = file ? { file, line: answer.line ?? 1, col: 1 } : fallback;
    // A sorry the build already reported on this line is not said twice.
    const known =
      extra.length === 1 &&
      extra[0] === "sorryAx" &&
      reported.some(
        (f) =>
          f.ruleId === "lean/sorry" && f.file === at.file && f.line === at.line,
      );
    const key = `${at.file}:${at.line}`;
    if (known || (flagged.has(key) && auxiliary(answer.decl))) continue;
    flagged.add(key);
    findings.push(
      report(
        at,
        "axioms",
        extra.length === 1 && extra[0] === answer.decl
          ? `'${answer.decl}' is an axiom besides Lean's own (propext, Classical.choice, Quot.sound): list it in tools.lean.options.allowAxioms if it is meant`
          : `'${answer.decl}' depends on ${extra.join(", ")}: ${why(extra)}`,
      ),
    );
  }
  // Without its closing count the audit did not finish (lean could not run
  // the program, e.g. a Lean whose API changed): nothing was vouched for.
  const done = answers.find((a) => a.audited !== undefined);
  if (!done && !answers.some((a) => a.error !== undefined))
    findings.push(
      report(
        fallback,
        "audit-error",
        `axiom audit did not finish: ${lines.filter((l) => !l.startsWith("{")).join(" ") || "no output"}`,
      ),
    );
  // Fewer modules than the build produced (a buildDir it could not see, a
  // module list that came out empty): the rest were not vouched for.
  if (done && (done.modules ?? 0) < expectedModules)
    findings.push(
      report(
        fallback,
        "audit-error",
        `axiom audit read ${done.modules ?? 0} of the ${expectedModules} modules this build produced`,
      ),
    );
  return findings;
}

interface LakeDiagnostic {
  severity: string;
  path: string;
  line: number;
  col: number;
  message: string;
}

const LAKE_DIAGNOSTIC = /^(error|warning|info): (.+?):(\d+):(\d+): (.*)$/;
const LAKE_UNLOCATED_ERROR = /^error: (.*)$/;
const LAKE_JOB = /^\S+ \[\d+\/\d+\] /;
/** A line that starts something new, so it continues no message. */
const LAKE_NEW_LINE =
  /^(?:error|warning|info|trace): |^\S+ \[\d+\/\d+\] |^Build completed|^Some required targets|^- |^$/;

const LAKE_LIB = "/.lake/build/lib/lean/";

/**
 * A `-v` trace line (`… bin/lean <source> -o <root>/.lake/build/lib/lean/
 * <module>.olean …`) as the source's path relative to the root it names
 * (normalised: `srcDir = "./src"` and `"src/"` print `./` and `//`), and
 * the module. Relative, so a moved project's replayed traces still match.
 * Only a module whose `.olean` is in this project's build directory is the
 * project's: a dependency's lines name its own files.
 */
function traced(
  line: string,
  projectRoot: string,
): { source: string; module: string } | undefined {
  const o = line.lastIndexOf(" -o ");
  const right = line.slice(o + 4);
  const lib = right.indexOf(LAKE_LIB);
  if (o < 0 || lib < 0) return undefined;
  const root = right.slice(0, lib);
  const at = line.slice(0, o).lastIndexOf(`${root}/`);
  const modulePath = right
    .slice(lib + LAKE_LIB.length)
    .replace(/\.olean.*$/, "");
  if (at < 0 || !existsSync(join(projectRoot, LAKE_LIB, `${modulePath}.olean`)))
    return undefined;
  return {
    source: posix.normalize(line.slice(at + root.length + 1, o)),
    module: modulePath.split("/").join("."),
  };
}

/**
 * Lake's build log: diagnostics (with their continuation lines), errors with
 * no location, and from the trace lines (counted only right after a job
 * line, where Lake puts them) each source it compiled or replayed.
 */
function lakeLog(
  text: string,
  projectRoot: string,
): {
  diagnostics: LakeDiagnostic[];
  unlocated: string[];
  /** Source path relative to the root -> module. */
  built: Map<string, string>;
} {
  const diagnostics: LakeDiagnostic[] = [];
  const unlocated: string[] = [];
  const built = new Map<string, string>();
  let current: LakeDiagnostic | undefined;
  let afterJob = false;
  for (const line of text.split("\n")) {
    const located = LAKE_DIAGNOSTIC.exec(line);
    const bare = LAKE_UNLOCATED_ERROR.exec(line)?.[1];
    const trace =
      line.startsWith("trace: ") && afterJob && !current
        ? traced(line, projectRoot)
        : undefined;
    if (located) {
      current = {
        severity: located[1] ?? "",
        path: located[2] ?? "",
        line: Number(located[3]),
        col: Number(located[4]) + 1,
        message: located[5] ?? "",
      };
      diagnostics.push(current);
    } else if (trace) {
      built.set(trace.source, trace.module);
    } else if (LAKE_NEW_LINE.test(line)) {
      current = undefined;
      if (bare && bare !== "build failed") unlocated.push(bare);
    } else if (current) {
      current.message += `\n${line}`;
    }
    afterJob = LAKE_JOB.test(line);
  }
  return { diagnostics, unlocated, built };
}

function lakeFindings(
  task: LakeTask,
  log: string,
  status: number,
): { findings: Finding[]; built: Map<string, string> } {
  const atLakefile = { file: task.lakefile, line: 1, col: 1 };
  const { diagnostics, unlocated, built } = lakeLog(log, task.root);
  // A dependency's messages name its own files: they are not this project's.
  const owned = new Set([...task.files, task.lakefile]);
  const own = diagnostics.filter((d) => owned.has(absPosix(task.root, d.path)));
  const findings = own.flatMap((d) => {
    const found = diagnostic(
      { file: absPosix(task.root, d.path), line: d.line, col: d.col },
      d.severity,
      d.message,
      d.severity === "warning" &&
        d.message.startsWith("declaration uses `sorry`"),
    );
    return found ? [found] : [];
  });
  findings.push(...sourceFindings([...task.files, task.lakefile]));
  if (!existsSync(join(task.root, "lean-toolchain")))
    findings.push(
      report(
        atLakefile,
        "no-toolchain",
        "No lean-toolchain beside the lakefile: the build uses whatever toolchain is installed",
      ),
    );
  if (status !== 0) {
    if (!own.some((d) => d.severity === "error"))
      findings.push(
        report(
          atLakefile,
          "build-error",
          `lake build failed: ${unlocated.join("; ") || log.trim().split("\n").slice(-3).join(" ")}`,
        ),
      );
    return { findings, built };
  }
  // A file no build target compiled or replayed was never checked.
  for (const file of task.files) {
    if (!built.has(relative(task.root, file)))
      findings.push(
        report(
          { file, line: 1, col: 1 },
          "not-built",
          "No build target compiles this file, so nothing checks it: import it from a library root or add it to a lean_lib",
        ),
      );
  }
  return { findings, built };
}

function isLeanInput(path: string): boolean {
  return path.endsWith(".lean") || LAKE_INPUTS.has(basename(path));
}

/** The first lines of a command's output, for a crash message. */
function plainOutput(raw: RawOutput): string {
  return (
    `${raw.stdout}\n${raw.stderr}`.trim().split("\n").slice(0, 3).join(" ") ||
    "no message"
  );
}

/** stderr: the compile or build status, then the audit's output. */
function statusAndAudit(raw: RawOutput): { status: number; audit: string } {
  const [status = "", ...rest] = raw.stderr.split("\n");
  if (!/^\d+$/.test(status))
    throw new Error(
      `lean: the task ended before it said how the build went: ${plainOutput(raw)}`,
    );
  return { status: Number(status), audit: rest.join("\n") };
}

function parseFile(task: FileTask, raw: RawOutput): Finding[] {
  const { status, audit } = statusAndAudit(raw);
  const findings = jsonMessages(raw.stdout).flatMap((m) => {
    const found = diagnostic(
      {
        file: task.file,
        line: m.pos?.line ?? 1,
        col: (m.pos?.column ?? 0) + 1,
      },
      m.severity ?? "",
      m.data ?? "",
      m.kind === "hasSorry",
    );
    return found ? [found] : [];
  });
  if (status !== 0 && !findings.some((f) => f.severity === "error"))
    throw new Error(
      `lean exited ${status} on ${task.file}: ${plainOutput(raw)}`,
    );
  findings.push(...sourceFindings([task.file]));
  if (status !== 0) return findings;
  return [
    ...findings,
    ...auditFindings(
      audit,
      () => task.file,
      { file: task.file, line: 1, col: 1 },
      task.allowAxioms,
      findings,
      1,
    ),
  ];
}

function parseLake(task: LakeTask, raw: RawOutput): Finding[] {
  const { status, audit } = statusAndAudit(raw);
  // Lake exits 0 or 1; anything else (4: restart after a toolchain update)
  // is not a verdict on the code.
  if (status !== 0 && status !== 1)
    throw new Error(`lake build exited ${status}: ${plainOutput(raw)}`);
  const { findings, built } = lakeFindings(task, raw.stdout, status);
  if (status !== 0) return findings;
  const fileOf = new Map(
    [...built].map(([source, module]) => [
      moduleKey(module),
      join(task.root, source),
    ]),
  );
  return [
    ...findings,
    ...auditFindings(
      audit,
      (module) => fileOf.get(module),
      { file: task.lakefile, line: 1, col: 1 },
      task.allowAxioms,
      findings,
      built.size,
    ),
  ];
}

/**
 * Lean 4 — proofs checked by the Lean kernel. Project-level: Lake projects
 * (a `lakefile.lean` or `lakefile.toml`) are built with Lake; `.lean` files
 * outside any project are compiled one by one with `lean`. Then every
 * declaration they define is audited for axioms, `sorryAx` included.
 */
export const lean: ToolAdapter = {
  id: "lean",
  layer: "formal",
  languages: [],
  bin: "lean",
  inputs: [".lean"],
  binSetting: false,
  supportsFix: false,
  fixWriteBack: false,
  tier: "verify",
  timeoutMs: 1_200_000,
  minVersion: "4.34.0",
  installHint:
    "Lean 4 through elan (github.com/leanprover/elan): `lean` and `lake` on PATH; a project's lean-toolchain picks the version",
  versionArgs: ["--version"],
  parseVersion: (out) => /version (\d+\.\d+\.\d+)/.exec(out)?.[1],

  expand(_seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    // Options are checked first: a typo is a config error in every run.
    const allowAxioms = toolOptions(env, "lean", LeanOptions).allowAxioms ?? [];
    if (env.changedPaths && !env.changedPaths.some(isLeanInput)) return [];
    const lakefiles = env.scopedFiles.filter((f) => LAKEFILES.has(basename(f)));
    const roots = [...new Set(lakefiles.map((f) => dirname(f)))].toSorted();
    // Each file belongs to the nearest project above it, else it is loose.
    const nearestFirst = roots.toSorted((a, b) => b.length - a.length);
    const owned = new Map<string, string[]>(roots.map((root) => [root, []]));
    const loose: string[] = [];
    for (const file of env.scopedFiles) {
      if (!file.endsWith(".lean") || LAKEFILES.has(basename(file))) continue;
      const root = nearestFirst.find((r) => file.startsWith(`${r}/`));
      if (root) owned.get(root)?.push(file);
      else loose.push(file);
    }
    const tasks: TaskSeed[] = roots.map((root) => {
      const task: LakeTask = {
        kind: "lake",
        root,
        // Lake reads lakefile.lean when both exist.
        lakefile: lakefiles.includes(`${root}/lakefile.lean`)
          ? `${root}/lakefile.lean`
          : `${root}/lakefile.toml`,
        files: owned.get(root) ?? [],
        allowAxioms,
      };
      return { cwd: root, options: task };
    });
    for (const file of loose) {
      const task: FileTask = { kind: "file", file, allowAxioms };
      tasks.push({ cwd: dirname(file), options: task });
    }
    return tasks;
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as LeanTask;
    // stdout: the build log (or lean's JSON). stderr: the build's status,
    // then, if it passed, the audit's answers. The audit runs after the
    // build in the same task, so nothing builds the package meanwhile.
    if (!ctx.tempDir) throw new Error("lean needs the runner's temp directory");
    const scratch = ctx.tempDir();
    if (task.kind === "lake") {
      return {
        bin: "sh",
        args: [
          "-c",
          // Lake writes some failures (a bad lakefile, an unknown target) to
          // stderr: the build's log is both streams. The modules to audit
          // are the ones this build's trace names, not every .olean left in
          // the build directory (a renamed module's old one would clash).
          `scratch="$1"; shift
{ lake build --no-ansi -v "$@" 2>&1; echo "$?" > "$scratch/status"; } | tee "$scratch/build.log"
status=$(cat "$scratch/status"); printf '%s\\n' "$status" >&2
[ "$status" = 0 ] || exit 0
sed -n 's#^trace: .* -o .*/\\.lake/build/lib/lean/\\(.*\\)\\.olean -i .*#\\1#p' "$scratch/build.log" > "$scratch/modules"
export VK_LEAN_AUDIT_ROOT="$PWD" VK_LEAN_AUDIT_LIB="$PWD/.lake/build/lib/lean" VK_LEAN_AUDIT_MODULES="$scratch/modules"
${RUN_AUDIT}`,
          "validate-kit",
          scratch,
          ...ctx.extraArgs,
        ],
        cwd: task.root,
        okExitCodes: "any",
        processGroup: true,
      };
    }
    // A loose file is compiled to an .olean in the task's scratch directory
    // (named after the file: -R its directory), then audited from there.
    return {
      bin: "sh",
      args: [
        "-c",
        `file="$1"; out="$2"; shift 2
lean --json "$@" -R "$(dirname "$file")" -o "$out/$(basename "$file" .lean).olean" "$file" 2>&1; status=$?; printf '%s\\n' "$status" >&2
[ "$status" = 0 ] || exit 0
export VK_LEAN_AUDIT_LIB="$out"
${RUN_AUDIT}`,
        "validate-kit",
        task.file,
        scratch,
        ...ctx.extraArgs,
      ],
      cwd: dirname(task.file),
      okExitCodes: "any",
      processGroup: true,
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as LeanTask;
    return {
      findings:
        task.kind === "file" ? parseFile(task, raw) : parseLake(task, raw),
      filesProcessed: task.kind === "file" ? 1 : task.files.length,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
