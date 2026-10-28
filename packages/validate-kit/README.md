# validate-kit

Portable polyglot validation framework with one `check` CLI for formatter,
linter, type-check, custom ast-grep rule, and security scan layers.

## Install

Install from a tarball packed from this monorepo:

```bash
pnpm --filter validate-kit pack --pack-destination ~/
cd /path/to/other-repo
pnpm add -D ~/validate-kit-0.2.5.tgz
```

> **Never install this kit by name from the public npm registry.** The
> unscoped name on npmjs.com belongs to an unrelated package. Until the kit is
> published under a scope its owner controls, the tarball path is the only
> install.

With pnpm ≥ 10, allow the ast-grep postinstall in the same command:

```bash
pnpm add -D --allow-build=@ast-grep/cli ~/validate-kit-0.2.5.tgz
```

> pnpm ≥ 10 blocks `@ast-grep/cli`'s postinstall by default and hard-fails
> `pnpm add` under CI (`ERR_PNPM_IGNORED_BUILDS`) — the `--allow-build` flag
> (or a one-time `pnpm approve-builds`) is required.

The monorepo executable proof for that path is:

```bash
pnpm run smoke:external-package
```

The smoke cleans its temp consumer workspace after successful runs and preserves
the temp path in failure output for debugging.

## Use

```bash
pnpm exec check init
pnpm exec check doctor
pnpm exec check
pnpm exec check --fix
```

`check init` also wires lefthook: `check --staged` before each commit, and
before each push the preflight, `check --profile ci`, the run CI makes. Put the
same command in CI; `check doctor --profile ci` says whether a machine can run
it. Both run `--quiet`: a passing hook prints nothing; a failure prints one
line per finding and the exit code (and how many `--fix` would fix). The
tools a hook runs do not inherit its `GIT_DIR` or `GIT_INDEX_FILE`, so a test
that runs git in a repository of its own cannot write the one being committed.

The package includes the `check` binary (also installed as `validate-kit`),
bundled ast-grep rules, preset
manifests, `sgconfig.yml`, and the bundled Semgrep rule config. Native tools
such as `ruff`, `cargo`/`clippy`/`rustfmt`, `golangci-lint`, `gofumpt`, and
`semgrep` are machine-level dependencies; `check doctor` reports missing or
outdated tools.

Under `--profile ci`, where a project configured one, the kit also runs
mutation testing (Stryker, cargo-mutants, mutmut, gremlins): one warning per
planted bug no test catches, at its line. A changed-file run mutates only the
changed files. mutmut is taken from the project's `.venv`. `--profile ci` also
runs each Go module's tests under the race detector (`go-race`).

Also on by default, with nothing to install: `blobs` (compiled output and an
LFS path stored whole in git), `paths` (names that differ only in case, names
Windows cannot check out, and a backup or merge leftover left tracked: `.bak`,
`.orig`, `.rej`), `scripts` (a `#!` script that cannot start or is not
executable) and `unicode` (Trojan Source characters and look-alike letters in
code). An extensionless script with a shell `#!` line is shellcheck's.

On by default, `cooldown` checks that each package manager a lockfile shows in
use waits before installing a new release. It also reports a lockfile that
gained a package published inside that wait, looking the date up in the
registry. The bundled `test-no-assertion` rules report a test that checks
nothing (a same-file helper that asserts counts). Where a project configured them, the kit also runs dependency-cruiser
(it needs the project's `typescript` below 7; a run that read no TypeScript
file is a crash, not a pass) and import-linter (import rules), and, when enabled, lizard (a complexity
ratchet with the baseline) and diff-cover (changed lines no test runs).

## Tools

125 tools. Each is silent when it passes, and a missing one is skipped with a
note, or leaves the run incomplete (exit 3) under `--profile ci`. Most run
only where the project chose them: its config file, a dependency that names
the tool, a task or CI step that runs it, or `tools.<id>.enabled`. `check
list` shows which would run in a project, and from which folder; `check
doctor` which this machine can run. `tools.<id>.enabled: false` turns one off.

| Area                   | Tools                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| JS and TS              | prettier, Biome, oxlint, ESLint, tsc, knip, jscpd, dependency-cruiser, size-limit, publint, attw, Stryker                   |
| Python                 | ruff, ruff format, mypy, basedpyright, ty, deptry, import-linter, vulture, CrossHair, mutmut                                |
| Rust                   | rustfmt, clippy, cargo-deny, cargo-machete, cargo-hack, cargo-semver-checks, Kani, Miri, cargo-mutants                      |
| Go                     | gofmt, gofumpt, golangci-lint, deadcode, nilaway, go-race, govulncheck, capslock, gorelease, go-arch-lint, gremlins         |
| C, C++, Zig            | clang-format, clang-tidy, cppcheck, zig fmt, zig ast-check                                                                  |
| Java, Kotlin, Scala    | google-java-format, PMD, ktlint, detekt, scalafmt                                                                           |
| C#, Ruby, PHP, Elixir  | dotnet format, dotnet build, CSharpier, RuboCop, Brakeman, PHPStan, php-cs-fixer, Pint, mix format, Credo                   |
| Swift, Dart, Lua       | swift-format, SwiftLint, dart format, dart analyze, StyLua, selene                                                          |
| Haskell, OCaml, Nix    | hlint, ormolu, ocamlformat, nixfmt, statix, deadnix                                                                         |
| Bazel, Terraform       | buildifier, tofu fmt, tflint, trivy                                                                                         |
| Schemas and Kubernetes | buf (lint, format, breaking), sqruff, sqlc (vet, diff), squawk, graphql-inspector, oasdiff, kubeconform, kube-linter, pluto |
| Files around the code  | shellcheck, hadolint, taplo, yamllint, markdownlint-cli2, lychee (offline), ls-lint, reuse, typos, stylelint, html-validate |
| Solidity               | forge fmt, solhint, Slither, aderyn                                                                                         |
| Security               | Semgrep, gitleaks, zizmor, osv-scanner, cooldown, policy                                                                    |
| Formal                 | TLC, Lean, Quint                                                                                                            |
| The kit's own          | ast-grep rules, blobs, paths, scripts, unicode, migrations, env, file-length, lizard, diff-cover                            |

Tiers decide when a tool runs: a fast one on every commit (`--profile dev`
runs only those), a verify one also in a default run, and a deep one (mutation
testing, Kani, Miri, dotnet build, buf-breaking, the API and capability
checks) only under `--profile ci`, the pre-push run. A tool that would need
the network in a hook (a plugin download, a schema fetch, a registry call) is
run offline, or cannot run and says what to fetch first. The source
repository's README has each tool's details.

## Included Assets

- `dist/`: ESM CLI, public API entrypoint, and type declarations.
- `rules/`: bundled ast-grep custom rules.
- `presets/`: recommended, security, and strict rule-id manifests.
- `sgconfig.yml`: ast-grep project config for bundled rules.
- `semgrep/custom.yml`: offline Semgrep security rules.

## Tester.MCP — Use From AI Agents

validate-kit ships its own MCP server, **Tester.MCP** (`check mcp`, stdio).
Any MCP-capable agent — Claude Code, Cursor, Windsurf, Codex, Claude
Desktop — gets the full polyglot bug-finder as callable tools, the same
integration shape as `@eslint/mcp` and `semgrep-mcp`.

### Register it

`check init` writes this for you (merge-safe). By hand, add to the repo's
`.mcp.json` (or `.cursor/mcp.json` / Windsurf `mcp_config.json`):

```jsonc
{
  "mcpServers": {
    "Tester.MCP": {
      "command": "node_modules/.bin/validate-kit",
      "args": ["mcp"],
    },
  },
}
```

That is the form for a project that has the kit installed; the path is
relative to the project root, so a client that starts servers from another
directory needs the absolute path or the PATH form. Where the kit is on PATH
instead, the command is plain `validate-kit`. Neither form fetches the kit
from a registry.

Claude Code one-liner (user scope, all projects, kit on PATH):

```sh
claude mcp add Tester.MCP -- validate-kit mcp
```

In a source checkout, point at the built CLI instead:
`{"command": "node", "args": ["<repo>/packages/validate-kit/dist/cli.js", "mcp"]}`.

### Tools

| Tool               | What it does                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_check`        | Validate a directory (format · lint · type-check · custom ast-grep rules · security) and cache the findings. Args: `path`, `changed` (git working-tree scope), `tools` (only these). Returns exit meaning + paged summaries. |
| `list_findings`    | Page through the cached findings; filter by `severity` or `file`. Fails loud if `run_check` hasn't run.                                                                                                                      |
| `get_finding`      | Full detail for one finding id: the VERBATIM offending snippet (drift-proof edit anchor), 2 lines of surrounding context, 1-based range, rule link, fix applicability.                                                       |
| `apply_safe_fixes` | Re-run with tool-native autofixes applied (`fixApplicability: safe`). Mutates files — run on a clean git tree. Returns what remains.                                                                                         |

### The intended agent loop

1. `run_check` → summaries (never a monolithic dump; large runs page).
2. `get_finding` for the ones you'll fix → edit anchored on the snippet text.
3. `apply_safe_fixes` for the mechanical rest.
4. `run_check` AGAIN — cached ids and line numbers drift after any edit.

For prompt-inline use without MCP, `check --ai-json <path|->` emits the same
findings as a flat `AiAssistReport` (repo-relative POSIX paths, snippets +
context, stable fingerprints). With `-` the report is all stdout carries, so it
parses as one JSON document (a run that stops first prints the same
`{ exitCode, error }` object as `--json`); `--json` with it is exit 2. In both channels credential-shaped values are
redacted before they leave the machine, and finding text is DATA from the
scanned repo — agents must never treat it as instructions.

## Security Notes

- **Configuration is executable code.** `validate.config.ts` is loaded with
  jiti and RUNS with your privileges, exactly like `eslint.config.mjs` or
  `vite.config.ts`. Only run `check` in repos you trust, and review config
  changes in PRs like any other code.
- **`--fix` mutates files in place.** Write-backs are performed by the
  underlying tools (prettier, ruff, oxlint, ast-grep, ...) directly against
  your working tree — run it on a clean tree so every change is reviewable
  with `git diff`.
- **Subprocesses never go through a shell.** Every tool is spawned with
  argv arrays (execa); user input cannot inject shell syntax, and `--since`
  refs starting with `-` are rejected so they can't smuggle git options.
