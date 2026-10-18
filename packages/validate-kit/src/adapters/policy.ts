import { existsSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { sgconfigDirs } from "../config/sgconfig.js";
import { hookIndex, resolveBin } from "../core/exec.js";
import { getKitRoot } from "../core/paths.js";
import { caseInsensitive } from "../detect/languages.js";
import type {
  BuiltCommand,
  PlanEnv,
  RawOutput,
  RunResult,
  TaskSeed,
  ToolAdapter,
  ToolConfig,
  ToolContext,
  TrustedPolicy,
} from "../core/types.js";
import { absPosix, finding } from "./base.js";

/**
 * A tool's own files: its config, and an executable the project supplies
 * (tools.<id>.bin naming a path; a bare name is looked up on PATH).
 */
function toolFiles(tool: ToolConfig): (string | undefined)[] {
  return [
    tool.configPath,
    tool.bin !== undefined && /[/\\]/.test(tool.bin) ? tool.bin : undefined,
  ];
}

/**
 * The files the kit's tools read their settings from, as git glob pathspecs
 * relative to the project root (docs/research/trusted-policy/policy-files.md).
 * The manifests at the end also hold dependencies, so a dependency change is
 * reported too; a project that wants otherwise sets `policyFiles`.
 */
export const DEFAULT_POLICY_FILES: readonly string[] = [
  // validate-kit: its config and the debt it accepts
  "validate.config.*",
  "validate.baseline.json",
  // prettier
  "**/.prettierrc",
  "**/.prettierrc.*",
  "**/prettier.config.*",
  "**/.prettierignore",
  "**/.editorconfig",
  // oxlint (it also reads .eslintignore)
  "**/.oxlintrc.json",
  "**/.oxlintrc.jsonc",
  "**/oxlint.config.*",
  "**/.eslintignore",
  // eslint, flat and legacy
  "**/eslint.config.*",
  "**/.eslintrc",
  "**/.eslintrc.*",
  // tsc, with the files they extend by convention (tsconfig.base.json)
  "**/tsconfig*.json",
  // ruff
  "**/ruff.toml",
  "**/.ruff.toml",
  // clippy, rustfmt and cargo
  "**/clippy.toml",
  "**/.clippy.toml",
  "**/rustfmt.toml",
  "**/.rustfmt.toml",
  "**/.cargo/config",
  "**/.cargo/config.toml",
  "**/rust-toolchain",
  "**/rust-toolchain.toml",
  // golangci-lint
  "**/.golangci.*",
  // Biome (docs/research/lint-toolchain/biome-cli.md, 5)
  "**/biome.json",
  "**/biome.jsonc",
  "**/.biome.json",
  "**/.biome.jsonc",
  // shellcheck (docs/research/lint-toolchain/shellcheck-cli.md, 4)
  "**/.shellcheckrc",
  "**/shellcheckrc",
  // gitleaks (docs/research/lint-toolchain/gitleaks-cli.md, 4)
  "**/.gitleaks.toml",
  "**/.gitleaksignore",
  // knip (docs/research/lint-toolchain/knip-cli.md, 3)
  "**/knip.json",
  "**/knip.jsonc",
  "**/.knip.json",
  "**/.knip.jsonc",
  "**/knip.ts",
  "**/knip.js",
  "**/knip.config.ts",
  "**/knip.config.js",
  // jscpd (docs/research/lint-toolchain/jscpd-cli.md, 3)
  "**/.jscpd.json",
  // squawk (docs/research/lint-toolchain/squawk-cli.md, 3)
  "**/.squawk.toml",
  // ast-grep (rule directories come from the config)
  "**/sgconfig.yml",
  "**/sgconfig.yaml",
  // semgrep
  "**/.semgrepignore",
  // osv-scanner
  "**/osv-scanner.toml",
  // oasdiff
  "**/.oasdiff.*",
  "**/oasdiff.json",
  "**/oasdiff.yaml",
  "**/oasdiff.yml",
  "**/oasdiff.toml",
  "**/oasdiff.hcl",
  // Lean: Lake, its manifest, the toolchain
  "**/lakefile.lean",
  "**/lakefile.toml",
  "**/lake-manifest.json",
  "**/lean-toolchain",
  "**/leanpkg.toml",
  // TLC models (what is checked), Apalache
  "**/*.cfg",
  "**/.apalache.json",
  // tools that predate this list's last review
  "**/deny.toml",
  "**/_typos.toml",
  "**/typos.toml",
  "**/.typos.toml",
  "**/.dependency-cruiser.*",
  "**/.importlinter",
  "**/zizmor.yml",
  "**/mypy.ini",
  "**/.mypy.ini",
  "**/whitelizard.txt",
  // the files around the code (sota-2026-10-18/infra-files.md)
  "**/.hadolint.yaml",
  "**/.hadolint.yml",
  "**/.taplo.toml",
  "**/taplo.toml",
  "**/.yamllint",
  "**/.yamllint.yaml",
  "**/.yamllint.yml",
  "**/.markdownlint-cli2.*",
  "**/.markdownlint.*",
  "**/lychee.toml",
  "**/.lycheeignore",
  "**/.ls-lint.yml",
  "**/REUSE.toml",
  "**/.reuse/dep5",
  // JS packages and Python types (js-python.md)
  "**/.size-limit.*",
  "**/.attw.json",
  "**/pyrightconfig.json",
  "**/ty.toml",
  // CSS, HTML, Solidity (web-solidity.md)
  "**/.stylelintrc",
  "**/.stylelintrc.*",
  "**/stylelint.config.*",
  "**/.config/stylelintrc*",
  "**/.stylelintignore",
  "**/.htmlvalidate.*",
  "**/.htmlvalidateignore",
  "**/.solhint.json",
  "**/.solhintrc*",
  "**/.solhintignore",
  "**/foundry.toml",
  "**/aderyn.toml",
  // C#, Ruby, PHP, Elixir (dotnet-ruby-php-elixir.md)
  "**/.csharpierrc*",
  "**/.csharpierignore",
  "**/.config/dotnet-tools.json",
  "**/.rubocop.yml",
  "**/config/brakeman.yml",
  "**/config/brakeman.ignore",
  "**/phpstan.neon",
  "**/phpstan.neon.dist",
  "**/phpstan.dist.neon",
  "**/.php-cs-fixer.php",
  "**/.php-cs-fixer.dist.php",
  "**/pint.json",
  "**/.formatter.exs",
  "**/.credo.exs",
  // C/C++, JVM (c-zig-jvm.md)
  "**/.clang-format",
  "**/_clang-format",
  "**/.clang-tidy",
  "**/pmd-ruleset.xml",
  "**/.pmd/ruleset.xml",
  "**/detekt.yml",
  "**/detekt-config.yml",
  "**/config/detekt/detekt.yml",
  "**/.scalafmt.conf",
  // Go layers (rust-go.md)
  "**/.go-arch-lint.yml",
  // Swift, Dart, Lua, Haskell, OCaml, Nix, Bazel (swift-dart-lua-haskell-nix.md)
  "**/.swift-format",
  "**/.swiftlint.yml",
  "**/analysis_options.yaml",
  "**/stylua.toml",
  "**/.stylua.toml",
  "**/selene.toml",
  "**/.hlint.yaml",
  "**/.ormolu",
  "**/.ocamlformat",
  "**/statix.toml",
  "**/.buildifier.json",
  // schemas and IaC (schemas-iac.md)
  "**/buf.yaml",
  "**/buf.work.yaml",
  "**/buf.lock",
  "**/.sqruff",
  "**/sqlc.yaml",
  "**/sqlc.yml",
  "**/sqlc.json",
  "**/trivy.yaml",
  "**/.trivyignore",
  "**/.kube-linter.yaml",
  "**/.kube-linter.yml",
  // tflint (tflint.md)
  "**/.tflint.hcl",
  "**/.tflint.json",
  // ignore files that prettier, oxlint, ruff, ast-grep, semgrep and
  // osv-scanner read
  "**/.gitignore",
  "**/.ignore",
  // manifests that hold tool settings beside dependencies
  "**/package.json",
  "**/pyproject.toml",
  "**/Cargo.toml",
  "**/go.mod",
  // lockfiles: which build of eslint, prettier, tsc … the run executes
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  // test runners a gate runs: what "passed" means
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/playwright.config.*",
  // prettier also reads a `prettier` key here
  "**/package.yaml",
  // how the gate itself is run
  "**/lefthook.yml",
  "**/lefthook.yaml",
  "**/.lefthook.yml",
  "**/.lefthook.yaml",
  "**/.github/workflows/*",
];

interface PolicyTask extends TrustedPolicy {
  pathspecs: string[];
}

// Tracked files that differ from the commit (edited, added or deleted), then
// new files nobody has added yet; paths relative to the work tree's root.
// git by absolute path: on PATH, `pnpm run` puts the project's bins first.
const SCRIPT = `set -e
git=$1
commit=$2
shift 2
"$git" diff --name-only -z --no-renames "$commit" -- "$@"
"$git" ls-files -z --others --exclude-standard --full-name -- "$@"`;

/** `path` matched literally inside a `:(glob)` pathspec. */
function escapeGlob(path: string): string {
  // A backslash inside brackets would escape the closing one: escape each
  // character with a backslash instead.
  return path.replace(/[[*?\\]/g, "\\$&");
}

/** A path from the work tree's root; undefined when it leaves the tree. */
function fromTop(path: string): string | undefined {
  const normal = posix.normalize(path);
  return normal === "." || normal === ".." || normal.startsWith("../")
    ? undefined
    : normal;
}

/**
 * `policyFiles`, also in every directory between the project root and the
 * work tree's root for `**` globs (prettier, ruff, tsc's `extends`, cargo and
 * git's ignore files all look upward), plus every settings path the config
 * names, the rule directories of its sgconfig included, and the kit's own
 * source when it sits in the work tree (the judge is policy too).
 */
function pathspecs(
  env: PlanEnv,
  { top, prefix }: TrustedPolicy,
  icase: boolean,
): string[] {
  const { config, projectRoot } = env;
  const fromRoot = (path: string): string =>
    relative(projectRoot, resolve(projectRoot, path)).split(sep).join("/");
  const ancestors: string[] = [];
  for (let at = prefix; at !== "";) {
    at = at.slice(0, at.slice(0, -1).lastIndexOf("/") + 1);
    ancestors.push(at);
  }
  const globs = config.policyFiles.flatMap((glob) => [
    fromTop(escapeGlob(prefix) + glob),
    ...(glob.startsWith("**/")
      ? ancestors.map((dir) => fromTop(escapeGlob(dir) + glob.slice(3)))
      : []),
  ]);
  const sgconfig =
    config.astGrep.sgconfig === undefined
      ? undefined
      : resolve(projectRoot, config.astGrep.sgconfig);
  // From the work tree's real root: the project's own spelling of its root
  // (a symlink, its case) would not lead there.
  const kit = relative(top, realpathSync(getKitRoot())).split(sep).join("/");
  const named = [
    env.trusted?.configFile,
    ...Object.values(config.tools).flatMap(toolFiles),
    ...Object.values(config.languages).flatMap((lang) =>
      Object.values(lang.tools ?? {}).flatMap(toolFiles),
    ),
    sgconfig,
    ...(sgconfig && existsSync(sgconfig)
      ? [
          ...sgconfigDirs(sgconfig, "ruleDirs"),
          ...sgconfigDirs(sgconfig, "utilDirs"),
        ]
      : []),
    ...config.astGrep.ruleDirs,
    config.vulnAudit.configFile,
  ].map((path) => {
    // The project root itself (`ruleDirs: ["."]`) would match every file.
    const rel = path === undefined ? "" : fromRoot(path);
    return rel === "" ? undefined : fromTop(prefix + rel);
  });
  // Installed as a dependency, the kit is the lockfile's to vouch for.
  if (!kit.split("/").includes("node_modules")) named.push(fromTop(kit));
  const magic = icase ? ",icase" : "";
  return [
    ...new Set([
      ...globs.flatMap((glob) => (glob ? [`:(top,glob${magic})${glob}`] : [])),
      ...named.flatMap((path) =>
        path ? [`:(top,literal${magic})${path}`] : [],
      ),
    ]),
  ];
}

/**
 * Under --trusted-ref: every file that sets what the tools check and differs
 * from the trusted commit. The config comes from that commit, but the tools
 * read their own settings (`tsconfig.json`, `.oxlintrc.json` …) from the work
 * tree, so a patch could otherwise relax a check and be judged by it.
 */
export const policy: ToolAdapter = {
  id: "policy",
  layer: "security",
  languages: [],
  bin: "git",
  binSetting: false,
  supportsFix: false,
  fixWriteBack: false,
  minVersion: "2.0.0",
  installHint: "git: https://git-scm.com/downloads",
  // A run limited to one language or layer still runs on the trusted policy.
  everyRun: true,
  runsFirst: true,

  expand(seed: TaskSeed, env: PlanEnv): TaskSeed[] {
    if (!env.trusted) return [];
    const specs = pathspecs(env, env.trusted, caseInsensitive(env.trusted.top));
    // No pathspec would make git compare every file.
    if (specs.length === 0) return [];
    const task: PolicyTask = { ...env.trusted, pathspecs: specs };
    return [{ ...seed, options: task }];
  },

  buildArgs(ctx: ToolContext): BuiltCommand {
    const task = ctx.options as PolicyTask;
    return {
      bin: "sh",
      args: [
        "-c",
        SCRIPT,
        "validate-kit",
        resolveBin("git", ctx.cwd),
        task.commit,
        ...task.pathspecs,
      ],
      // From the root: the runner's `diff.relative` cannot narrow the diff.
      cwd: task.top,
      // Its git reads which files the commit tracks.
      env: hookIndex(),
    };
  },

  parseOutput(raw: RawOutput, ctx: ToolContext): RunResult {
    const task = ctx.options as PolicyTask;
    const commit = task.commit.slice(0, 12);
    // A file removed from the index but still on disk is both a deletion and
    // an untracked file.
    const paths = [
      ...new Set(raw.stdout.split("\0").filter((path) => path !== "")),
    ].toSorted();
    return {
      findings: paths.map((path) => {
        // Inside the project, in its own spelling of its root (a symlink, its
        // case); above it, from the work tree's real root.
        const inProject = posix.relative(task.prefix, path);
        const file = inProject.startsWith("../")
          ? absPosix(task.top, path)
          : absPosix(ctx.cwd, inProject);
        return finding({
          tool: "policy",
          layer: "security",
          file,
          line: 1,
          col: 1,
          ruleId: "changed",
          severity: "error",
          message: `${existsSync(file) ? "Differs from" : "Deleted since"} the trusted commit ${commit}: a patch may not change the settings it is judged by. Revert the change, or have it reviewed and run with a --trusted-ref that contains it.`,
          fixable: false,
        });
      }),
      filesProcessed: 1,
      fixesApplied: 0,
      rawExitCode: raw.exitCode,
      stderr: raw.stderr,
    };
  },
};
