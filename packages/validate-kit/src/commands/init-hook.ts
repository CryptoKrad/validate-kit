import { existsSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import pc from "picocolors";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { run } from "../core/exec.js";
import { EXIT } from "../core/exit-codes.js";
import { toPosix } from "../detect/languages.js";

/**
 * Wiring the kit into git's hooks through lefthook, beside whatever hook
 * setup the repository already has: `check --staged` before a commit, and
 * before a push the run CI makes, so a push reaches CI already judged.
 * lefthook moves a hook it did not write to `<hook>.old` and never runs it
 * again, deletes one that mentions LEFTHOOK, refuses any core.hooksPath (even
 * `.git/hooks` spelled relatively), and with --force writes into a global or
 * tracked folder (docs/research/hooks/lefthook-existing-hooks.md). So init
 * decides, and says what it decided, before lefthook touches anything.
 */

/** What init writes; with `dryRun` it only says so. */
export interface Writer {
  dryRun: boolean;
  write(path: string, text: string, said: string): void;
}

/** The hooks init wires, in the order the config lists them. */
const HOOKS = ["pre-commit", "pre-push"] as const;
type Hook = (typeof HOOKS)[number];

/**
 * The kit command each hook runs. `--quiet`: one line per gating finding and
 * the exit code when it fails, nothing when it passes.
 */
const COMMANDS: Record<Hook, string> = {
  "pre-commit": "check --staged --quiet",
  // What CI runs: every tool the project chose, the deep tier, the whole
  // tree, read from the working tree (check says in one line when it holds
  // uncommitted changes, which the push does not carry).
  "pre-push": "check --profile ci --quiet",
};

/**
 * lefthook's config names, in the order it tries them: each extension over
 * all three names (lefthook-existing-hooks.md, 3).
 */
const CONFIG_NAMES = [".yml", ".yaml", ".json", ".jsonc", ".toml"].flatMap(
  (ext) => ["lefthook", ".lefthook", ".config/lefthook"].map((n) => n + ext),
);

// Absolute, so a hook run from a linked worktree finds the folder git uses.
const HOOKS_DIR = "$(git rev-parse --path-format=absolute --git-path hooks)";

const TOP = `# Written by validate-kit init.
assert_lefthook_installed: true
min_version: 1.10.0
`;

/**
 * lefthook prints a job's own output and, for a failure, its exit status:
 * with `--quiet`, a passing hook prints one empty line, or check's one line
 * about uncommitted changes (lefthook-existing-hooks.md, K).
 */
const OUTPUT = `# check --quiet prints what needs acting on: a failure's findings and exit
# code, or that a push was judged with uncommitted changes. Run the command
# without --quiet for the full report.
output:
  - failure
  - execution_out
`;

/**
 * The hook init moved aside, run first in every clone that has one. A
 * pre-push hook gets git's two arguments and the pushed refs on stdin.
 * lefthook pastes `{N}` into the command as it is, so a remote path with a
 * space needs the quotes (lefthook-existing-hooks.md, 2).
 */
function oldJob(hook: Hook): string {
  const old = `${HOOKS_DIR}/${hook}.old`;
  const push = hook === "pre-push";
  return `    - name: existing ${hook} hook
      # The ${hook} hook this clone had before validate-kit init, kept as
      # ${hook}.old in the git hooks folder. Clones without it skip this job.
      run: '"${old}"${push ? ' "{1}" "{2}"' : ""}'
${push ? "      use_stdin: true\n" : ""}      only:
        - run: 'test -x "${old}"'
`;
}

const kitJob = (hook: Hook, kit: string, root?: string): string =>
  `    - name: ${hook === "pre-commit" ? "validate" : "preflight"}
${root ? `      root: ${root}\n` : ""}      run: ${kit} ${COMMANDS[hook]}
`;

const section = (hook: Hook, kit: string, keepOld: boolean): string =>
  `\n${hook}:\n  parallel: false\n  jobs:\n${keepOld ? oldJob(hook) : ""}${kitJob(hook, kit)}`;

/** `kept`: the hooks whose moved-aside hook the config runs first. */
const initConfig = (kit: string, kept: readonly Hook[] = []): string =>
  TOP +
  OUTPUT +
  HOOKS.map((hook) => section(hook, kit, kept.includes(hook))).join("");

/** What init wrote before 0.2.2. */
const legacyConfig = (kit: string): string => `pre-commit:
  parallel: false
  commands:
    validate:
      run: ${kit} check --staged
`;

/** A config text with the kit's path taken out of its commands. */
const canonical = (text: string): string =>
  text.replace(/^(\s*run: )\S*\/(validate-kit )/gm, "$1$2");

/** A config as init wrote it before `--quiet`: no output block. */
const loud = (text: string): string =>
  text.replace(OUTPUT, "").replaceAll(" --quiet", "");

/**
 * A config init wrote, whichever install of the kit it names: replacing it
 * loses nothing the user wrote. Each earlier version's own text counts, so a
 * config the user edited (`--quiet` or the output block taken out) is theirs.
 */
function isInitConfig(text: string): boolean {
  const kit = "validate-kit";
  const current = ([[], ["pre-commit"], ["pre-push"], HOOKS] as const).map(
    (kept) => initConfig(kit, kept),
  );
  return [
    ...current,
    // The pre-push hook, before --quiet (unreleased).
    ...current.map(loud),
    // 0.2.2: the pre-commit hook alone.
    loud(TOP + section("pre-commit", kit, false)),
    loud(TOP + section("pre-commit", kit, true)),
    legacyConfig(kit),
  ].includes(canonical(text));
}

/** A line, not a comment, that runs the kit the way each hook needs. */
const RUNS: Record<Hook, RegExp> = {
  "pre-commit": /^[^#\n]*(?:validate-kit|\bexec check\b)[^#\n]*--staged/m,
  "pre-push":
    /^[^#\n]*(?:validate-kit|\bexec check\b)[^#\n]*--profile[= ]ci\b/m,
};

/**
 * The `run` commands a lefthook config gives `hook`, so a job under another
 * hook does not count; the whole text when the config does not parse.
 */
function hookRuns(text: string, path: string, hook: Hook): string[] {
  let config: unknown;
  try {
    config = path.endsWith(".toml") ? parseToml(text) : parseYaml(text);
  } catch {
    return [text];
  }
  const runs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node && typeof node === "object")
      for (const [key, value] of Object.entries(node))
        if (key === "run" && typeof value === "string") runs.push(value);
        else walk(value);
  };
  walk((config as Record<string, unknown> | null)?.[hook]);
  return runs;
}

/** Does this hook script hand `hook` to lefthook (not in a comment)? */
function callsLefthook(path: string, hook: Hook): boolean {
  try {
    return new RegExp(
      `^[^#\\n]*\\b(?:call_)?lefthook\\s+run\\s+["']?${hook}\\b`,
      "m",
    ).test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function git(root: string, args: string[]): Promise<string | undefined> {
  const raw = await run("git", args, { cwd: root, timeoutMs: 30_000 });
  return raw.spawnError || raw.exitCode !== 0 ? undefined : raw.stdout.trim();
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function refuse(line: string): void {
  process.stderr.write(pc.yellow(`${line}\n`));
}

/** The jobs a lefthook config needs, to paste into one init did not write. */
function printJobs(
  kit: string,
  hooks: readonly Hook[],
  kept: readonly Hook[] = [],
  root?: string,
): void {
  process.stderr.write(
    hooks
      .map(
        (hook) =>
          `${hook}:\n  jobs:\n${kept.includes(hook) ? oldJob(hook) : ""}${kitJob(hook, kit, root)}`,
      )
      .join(""),
  );
}

interface HookState {
  hook: Hook;
  path: string;
  old: string;
  present: boolean;
  /** It hands the hook to lefthook. */
  routed: boolean;
  hasOld: boolean;
  /** Present and not lefthook's: the user's own. */
  custom: boolean;
}

/**
 * Write lefthook's config and install the pre-commit and pre-push hooks.
 * Returns an exit code when the hooks could not be wired and the user has to
 * choose; a missing git repository or lefthook binary is reported and is not
 * one.
 */
export async function scaffoldHook(
  root: string,
  kit: string,
  out: Writer,
): Promise<number | undefined> {
  // The config lefthook will read, and only it: a second one is ambiguous.
  const envConfig = process.env["LEFTHOOK_CONFIG"];
  let config: string | undefined;
  if (envConfig) {
    config = resolve(root, envConfig);
    if (!existsSync(config)) {
      refuse(
        `LEFTHOOK_CONFIG names ${config}, which does not exist: no hook installed. Create it, or unset LEFTHOOK_CONFIG, then run init again`,
      );
      return EXIT.CONFIG;
    }
  } else {
    const found = CONFIG_NAMES.map((name) => join(root, name)).filter((path) =>
      existsSync(path),
    );
    if (found.length > 1) {
      refuse(
        `More than one lefthook config (${found.join(", ")}); lefthook reads only ${found[0]}. Merge them into one, then run init again`,
      );
      return EXIT.CONFIG;
    }
    config = found[0];
  }
  const configText = config ? readFileSync(config, "utf8") : undefined;
  const ours = configText === undefined || isInitConfig(configText);
  const target = config ?? join(root, "lefthook.yml");
  const writeConfig = (kept: readonly Hook[] = []): void => {
    const text = initConfig(kit, kept);
    if (configText !== text)
      out.write(
        target,
        text,
        HOOKS.map(
          (hook) =>
            `${hook}: ${kept.includes(hook) ? "the existing hook, then " : ""}${COMMANDS[hook]}`,
        ).join("; "),
      );
  };

  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) {
    if (ours) writeConfig();
    say(
      pc.dim(
        "Not a git repository: no hook installed; run init again after `git init`",
      ),
    );
    return undefined;
  }
  // lefthook reads its config at the work tree's root, and nowhere else.
  if (real(top) !== real(root)) {
    const sub = toPosix(relative(real(top), real(root)));
    refuse(
      `lefthook reads its config at the work tree's root, ${top}, not here: no hook installed. Run init there, or add these jobs to the lefthook config there:`,
    );
    printJobs(kit, HOOKS, [], `${sub}/`);
    return EXIT.CONFIG;
  }
  const [hooks, gitDir, common, local, global] = await Promise.all([
    git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
    git(root, ["rev-parse", "--absolute-git-dir"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["config", "--local", "--get", "core.hooksPath"]),
    git(root, ["config", "--global", "--get", "core.hooksPath"]),
  ]);
  const setting = local ?? global ?? "(set in another git config)";
  if (hooks === undefined || common === undefined || hooks === "/dev/null") {
    refuse(
      hooks === "/dev/null"
        ? "Hooks are turned off here (core.hooksPath=/dev/null): no hook installed"
        : `git cannot name its hooks folder (git 2.31 or later is needed; core.hooksPath=${setting}, and a relative value fails in a linked worktree): no hook installed`,
    );
    return EXIT.CONFIG;
  }
  const states: HookState[] = HOOKS.map((hook) => {
    const path = join(hooks, hook);
    const present = existsSync(path);
    const routed = callsLefthook(path, hook);
    return {
      hook,
      path,
      old: `${path}.old`,
      present,
      routed,
      hasOld: existsSync(`${path}.old`),
      custom: present && !routed,
    };
  });
  const ownHooks = join(common, "hooks");
  // This repository's own folder, named absolutely: what git uses when a
  // global core.hooksPath is set too.
  const ownLocal = `git config --local core.hooksPath "${ownHooks}"`;

  // A global folder, or one the repository keeps (.githooks, .husky): what
  // is installed there runs for every repository, or is tracked.
  if (real(hooks) !== real(ownHooks)) {
    const where = `Hooks folder: ${hooks} (core.hooksPath=${setting}, ${local ? "local" : "global"})`;
    if (ours) writeConfig();
    for (const hook of HOOKS) {
      const ignored = join(ownHooks, hook);
      if (existsSync(ignored))
        say(
          `${ignored} is not run by git while core.hooksPath is set; not added`,
        );
    }
    const unrouted = states.filter((state) => !state.routed);
    const missing = ours
      ? []
      : HOOKS.filter(
          (hook) =>
            !hookRuns(configText, target, hook).some((line) =>
              RUNS[hook].test(line),
            ),
        );
    if (unrouted.length === 0 && missing.length === 0) {
      say(where);
      say(
        `pre-commit and pre-push run through ${hooks}, where both call lefthook: nothing installed`,
      );
      return undefined;
    }
    refuse(where);
    if (unrouted.length > 0) {
      const tracked =
        local && (await git(root, ["ls-files", "--", local]))
          ? "tracked, "
          : "";
      for (const state of unrouted)
        refuse(
          `${state.present ? `${state.path} does not call lefthook` : `There is no ${state.path}`} (${tracked}outside this repository's git folder), and init installs nothing there.`,
        );
      refuse("Either:");
      refuse(
        `  add ${unrouted.map((state) => `\`lefthook run ${state.hook} "$@" || exit $?\` to ${state.path}`).join(" and ")}${local ? "" : " (global hooks)"}, or`,
      );
      refuse(
        local && global === undefined
          ? `  move its hooks into ${target} as jobs, run \`git config --local --unset core.hooksPath\`, then run init again`
          : `  ${local ? `move its hooks into ${target} as jobs, ` : ""}give this repository its own hooks: \`${ownLocal}\`, then run init again`,
      );
    }
    if (missing.length > 0) {
      refuse(
        `${target} does not run ${missing.map((hook) => `\`${kit} ${COMMANDS[hook]}\` (${hook})`).join(" or ")}: add ${missing.length > 1 ? "these jobs" : "this job"}`,
      );
      printJobs(kit, missing);
    }
    return EXIT.CONFIG;
  }

  // The repository's own hooks folder.
  say(
    `Hooks folder: ${hooks}${local ? ` (core.hooksPath=${local}, local)` : ""}`,
  );
  if (!ours) {
    // The user's config: init changes neither it nor the hooks.
    say(`${target} was not written by init: hooks not changed`);
    const problems: string[] = [];
    const needs: Hook[] = [];
    const kept: Hook[] = [];
    for (const state of states) {
      const { hook, path, old } = state;
      const lines = hookRuns(configText, target, hook);
      const keepsOld = lines.some((line) => line.includes(`${hook}.old`));
      const runs = lines.some((line) => RUNS[hook].test(line));
      if (!runs)
        problems.push(
          `${target} does not run \`${kit} ${COMMANDS[hook]}\` (${hook})`,
        );
      if (state.custom)
        problems.push(
          keepsOld
            ? `${path} is not lefthook's: move it to ${old} yourself (\`lefthook install\` deletes a hook that mentions LEFTHOOK), then run \`lefthook install\``
            : `${path} is not lefthook's: \`lefthook install\` would move it to ${hook}.old, which ${target} does not run`,
        );
      else if (state.hasOld && !keepsOld)
        problems.push(`${old} is run by nothing`);
      else if (!state.present)
        problems.push(`No ${hook} hook is installed: run \`lefthook install\``);
      const keepOld = !keepsOld && (state.hasOld || state.custom);
      if (keepOld) kept.push(hook);
      if (!runs || keepOld) needs.push(hook);
    }
    for (const problem of problems) refuse(problem);
    if (needs.length > 0) {
      refuse("Add these jobs:");
      printJobs(kit, needs, kept);
    }
    return problems.length === 0 ? undefined : EXIT.CONFIG;
  }

  const conflicts = states.filter((state) => state.custom && state.hasOld);
  for (const { path, old } of conflicts)
    refuse(
      `Both ${path} and ${old} exist and neither is lefthook's: init moves neither. Merge them into one, then run init again`,
    );
  // Carried, a moved-aside hook that calls lefthook would run itself again.
  const loops = states.filter(
    (state) => state.hasOld && callsLefthook(state.old, state.hook),
  );
  for (const { old } of loops)
    refuse(
      `${old} calls lefthook, so running it first would loop: keep only its own steps in it, or remove it, then run init again`,
    );
  if (conflicts.length > 0 || loops.length > 0) return EXIT.CONFIG;
  const custom = states.filter((state) => state.custom);
  // Every worktree shares the hooks folder, and lefthook runs a moved hook
  // only where its config is checked out.
  if (
    custom.length > 0 &&
    gitDir !== undefined &&
    real(gitDir) !== real(common)
  ) {
    refuse(
      `This is a linked worktree, and the hooks folder serves every worktree: init moves ${custom.map((state) => state.path).join(" and ")} only from the main one. Run init there`,
    );
    return EXIT.CONFIG;
  }
  // The steps of a hook an earlier `lefthook install` moved aside, or of one
  // init is about to move, keep running. A Git LFS pre-push hook is carried
  // too: lefthook also runs `git lfs pre-push` where git-lfs is installed,
  // and the second run finds nothing left to upload, but only the carried
  // hook still stops a push where git-lfs is missing.
  writeConfig(
    states.filter((state) => state.custom || state.hasOld).map((s) => s.hook),
  );
  if (states.every((state) => state.routed)) {
    say(
      `pre-commit and pre-push already call lefthook, which reads ${target}: nothing installed`,
    );
    return undefined;
  }
  // lefthook refuses any core.hooksPath but this folder spelled exactly
  // `<top>/.git/hooks` with no global one. The folder is this repository's
  // own, and init saves the files in it that --force could lose first.
  const force =
    global !== undefined ||
    (local !== undefined && normalize(local) !== join(top, ".git", "hooks"));
  // Only the hooks that do not call lefthook yet: one that does, such as a
  // wrapper with steps of its own, is left as it is.
  const install = [
    "install",
    ...states.filter((state) => !state.routed).map((state) => state.hook),
    ...(force ? ["--force"] : []),
  ];
  if (out.dryRun) {
    for (const { path, old } of custom) say(`Would move ${path} to ${old}`);
    say(`Would run \`lefthook ${install.join(" ")}\``);
    return undefined;
  }
  const probe = await run("lefthook", ["version"], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (probe.spawnError) {
    say(
      pc.dim(
        "lefthook is not installed: hooks not changed. Install it (`brew install lefthook`, or `CI=1 npm i -D lefthook` so its postinstall installs no hook), then run init again",
      ),
    );
    return undefined;
  }
  // init's own backups: lefthook deletes a hook that mentions LEFTHOOK, and
  // its --force overwrites an existing .old.
  const saved = new Map<HookState, Buffer>();
  for (const state of custom) {
    saved.set(state, readFileSync(state.path));
    renameSync(state.path, state.old);
    say(
      `Moved ${state.path} to ${state.hook}.old; lefthook runs it first wherever ${target} is checked out (commit it)`,
    );
  }
  const restore = (which: HookState[]): string =>
    which
      .filter((state) => saved.has(state))
      .map((state) => {
        if (existsSync(state.path)) return `; the old hook is ${state.old}`;
        renameSync(state.old, state.path);
        return `; ${state.path} is back in place`;
      })
      .join("");
  const raw = await run("lefthook", install, { cwd: root, timeoutMs: 30_000 });
  if (raw.spawnError || raw.exitCode !== 0) {
    const back = restore(custom);
    // lefthook explains itself on stdout.
    refuse(
      `\`lefthook ${install.join(" ")}\` failed (exit ${raw.exitCode})${back}:\n${`${raw.stdout}\n${raw.stderr}`.trim()}`,
    );
    return EXIT.CONFIG;
  }
  say(
    pc.green(
      `Ran \`lefthook ${install.join(" ")}\`${force ? " (core.hooksPath is set, which a plain install refuses)" : ""}`,
    ),
  );
  const broken = states.filter(
    (state) =>
      !callsLefthook(state.path, state.hook) ||
      !(saved.get(state)?.equals(readFileSync(state.old)) ?? true),
  );
  for (const state of broken) {
    const back = callsLefthook(state.path, state.hook) ? "" : restore([state]);
    refuse(
      saved.has(state)
        ? `After install, ${state.path} does not call lefthook or ${state.old} changed: check both${back}`
        : `After install, ${state.path} does not call lefthook: check it`,
    );
  }
  if (broken.length > 0) return EXIT.CONFIG;
  say(
    `Checked: pre-commit and pre-push call lefthook${saved.size === 0 ? "" : `; ${[...saved.keys()].map((state) => `${state.hook}.old`).join(" and ")} unchanged`}`,
  );
  if (local !== undefined && !isAbsolute(local))
    say(
      pc.yellow(
        `core.hooksPath=${local} is relative, so no hook runs in a linked worktree; ${global === undefined ? "`git config --local --unset core.hooksPath` uses the same folder" : `\`${ownLocal}\` names it absolutely`} and fixes that`,
      ),
    );
  return undefined;
}
