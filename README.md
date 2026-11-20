# validate-kit

One gate for code an AI agent wrote: a `check` CLI that runs the formatters, linters, type
checkers, custom ast-grep rules, security scans and formal checks a project uses, behind one exit
code, and applies the fixes that are safe.

| Exit | Meaning                               |
| ---- | ------------------------------------- |
| 0    | clean                                 |
| 1    | findings                              |
| 2    | configuration error                   |
| 3    | incomplete: a planned tool is missing |
| 4    | a tool crashed or timed out           |

## What is here

- `packages/validate-kit/`: the kit (the CLI engine, one adapter per tool, custom ast-grep and
  Semgrep rules, presets). Its README covers installing and using it.
- `apps/api/` (Fastify 5 and Postgres) and `apps/web/` (Next.js 16 and React 19): a small app the
  kit checks, tested at every layer: unit, component, API, contract (Pact), integration
  (Testcontainers), E2E and visual (Playwright), and load (k6, in `perf/`).
- `services/`: Rust, Go and Python services, each holding one construct a custom rule must catch.
- `scripts/`: the checks CI runs, the end-to-end smoke of the packed kit, and the preflight
  (`scripts/verify-clean.sh`).
- `tests/fixtures/`: TLA+, Lean and Quint fixtures for the smoke.

## Use it in another repository

```bash
pnpm --filter validate-kit pack --pack-destination ~/
cd /path/to/other-repo
pnpm add -D --allow-build=@ast-grep/cli ~/validate-kit-<version>.tgz   # pnpm 10; see below for 11
pnpm exec validate-kit init     # config, git hooks through lefthook, MCP entry
pnpm exec validate-kit doctor   # which tools this machine can run
pnpm exec validate-kit check
```

Never install it by name from npm: the unscoped name there belongs to an unrelated package.

With pnpm 11, leave `--allow-build` out and write `"@ast-grep/cli": true` under `allowBuilds` in
`pnpm-workspace.yaml` yourself: there the flag replaces the project's whole list, and an approval
the project already had (an `esbuild: true`) is gone afterwards (recorded on 11.9.0).

`init` wires two git hooks: `check --staged` before a commit and `check --profile ci` before a
push, both with `--quiet`. A passing hook prints nothing; a failing one prints one line per finding
and the exit code.

### A project, on Windows

In PowerShell, after the kit is installed in the project as above:

```powershell
winget install Git.Git            # once per machine: the hooks run in its shell
pnpm exec validate-kit init       # the same wizard as on macOS
pnpm exec validate-kit doctor     # each tool the project needs, with the install line for Windows
pnpm exec validate-kit check
```

There is one wizard, `init`, for both systems, and the files it writes are the same on both. On
Windows the hooks and the command gates run through the `sh` of Git for Windows, which the kit
finds by itself; when it finds none, `init` says so and prints `winget install Git.Git`. `doctor`
prints the install line a Windows machine can run: Scoop's where Scoop holds the tool (`scoop
install shellcheck`), else the tool's own way, and for a tool with no Windows build it says so.

## Work on this repository

On macOS or Linux:

```bash
git clone https://github.com/CryptoKrad/validate-kit.git && cd validate-kit
mise install && brew bundle      # runtimes, then the native tools (Brewfile)
cargo install --locked agnix-cli # the one tool of the gate that Homebrew does not hold
pnpm install --frozen-lockfile
pnpm run build                   # packages/validate-kit/dist/cli.js
pnpm run check                   # the gate CI runs
pnpm --filter validate-kit run test
pnpm run smoke:external-package  # packs the kit and runs it in temporary repositories
scripts/verify-clean.sh --ci     # what CI's push jobs run, on a clean worktree of HEAD
```

On Windows, in PowerShell (5.1 or 7):

```powershell
winget install Git.Git jdx.mise   # once per machine; then open a new terminal
git clone https://github.com/CryptoKrad/validate-kit.git; cd validate-kit
mise install                                                                      # node, pnpm, go, rust, python, uv
mise exec -- powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1   # the gate's tools, install, build, doctor
mise exec -- pnpm run check                                                       # in a new terminal
```

`mise exec --` runs one command with the runtimes of `mise.toml` on PATH and needs no profile.
`-ExecutionPolicy Bypass` holds for that one process: a Windows client's default policy runs no
script file. To drop the prefix, activate mise in your PowerShell profile (mise's "Getting
started"); a profile loads only after `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope
CurrentUser`.

`scripts/setup-windows.ps1` installs the gate's tools at the versions CI pins, into the folder
`uv tool dir --bin`: four with `uv tool install`, shfmt with `go install`, and shellcheck and
agnix from their releases, each checked against its SHA-256. It needs no admin rights. CI's
Windows leg runs this script on each change, under Windows PowerShell 5.1, then the gate, and `pnpm run workflow:check` fails
when a version in it differs from CI's. The preflight (`scripts/verify-clean.sh`) and this
repository's own git hooks need macOS or Linux: CI checks a push from Windows.

## Work with an agent

The kit checks what an agent wrote at three points. Each one follows Anthropic's write-up on
verification or its article on verification loops with skills.

- **When the agent ends a turn.** `validate-kit init` writes a Claude Code stop hook
  (`validate-kit hook claude`). It checks the files the agent changed. It prints nothing when
  they pass and hands the findings back when they do not: up to three times on one prompt for
  the main agent, and once for a subagent. After that the user reads what is still open.
  Start the Claude Code session in the folder where `init` ran: Claude Code loads hooks from the
  `.claude/` folder of the folder a session starts in, "with no parent-directory fallback" (its
  permissions page). The git hooks run from any folder.
- **When the agent shows its change running.** A `verify` skill beside the code says how to run
  it and what a pass shows. `apps/web/.claude/skills/verify/SKILL.md` and
  `apps/api/.claude/skills/verify/SKILL.md` are two examples; a project writes its own.
- **When the agent commits.** `scripts/commit-gate.mjs` stamps each commit of a Claude Code
  session with what verified it, for the tree it ran on: `Verified: review, security, verify`,
  some of them, or `none`. A security review (`/security-review`) is a step of its own.
  Nothing starts it in this copy. Its header names the four hook events to put in a
  `.claude/settings.json`, and `pnpm run smoke:commit-gate` runs every case. It reads a
  Bash command only: a commit made through the PowerShell tool on Windows gets no stamp.

Two more scripts read a repository's history. `scripts/review-scope.mjs` reads `REVIEW.md` and
the CODEOWNERS file from the base commit of a repository that has both, and prints the change's
risk tier and the checklist items it fires; this copy has no `REVIEW.md`.
`scripts/review-metrics.mjs` counts, from git, the changes that were reverted or that a later
fix had to touch again.

The `review-md` check holds a `REVIEW.md` to what Claude Code's Code Review reads: the size of
each file, the 150,000 bytes that the files of one folder chain share, the 64 links to
repository files a file may hold, the folders it never reads one from, and what an included
file or skill may be.

Property tests are the project's own: the kit's rules catch one that tests less than it looks,
and its `saved-failures` check keeps a failing case a library saved in the commit. The package
README names both. Seven rules now: the newest reports a setting that fast-check 4.10
deprecates in favour of a plugin, such as `timeout` (`fc-no-deprecated-setting`, strict preset).
The replay rule also reads the
settings of `test.prop(...)`, the form of fast-check's Vitest and Jest connectors. The kit's own properties run
fast-check's 100 cases in the tests and 2,000 in the preflight: `FC_NUM_RUNS` sets the number
for every property through `packages/validate-kit/test/fast-check.setup.ts`.

## What must be on PATH

On macOS: `git`, `brew` and `mise`, with mise activated in your shell so that the runtimes it installs are
on PATH. Nothing else by hand: the three install lines above put every tool of this
repository's gate in a folder mise adds, in Homebrew's folder or in `node_modules/.bin`.
`pnpm exec check doctor --profile ci` prints one line per tool with its version, or the install
line when it is missing. On Windows: Git for Windows and `mise`; the setup script puts
the rest in one folder and `uv tool update-shell` adds that folder to PATH.

The smoke that the preflight (`scripts/verify-clean.sh --ci`) and the plain
`scripts/verify-clean.sh` run also runs the formal tools, and requires three things: Lean (`brew bundle` installs elan), TLC (as the step "Install TLC"
of `.github/workflows/validate.yml` installs it) and a JDK. It installs its own pinned Quint.
The script adds `~/.local/bin`, where TLC's launcher goes, to the end of its own PATH, and when
one of the three is missing it stops at its start and prints the line that installs it.

Two installers keep their tools outside PATH, and the kit starts those itself: rustup's cargo,
and .NET's global tools (`~/.dotnet/tools`) for `dotnet stryker`. A tool you add with
`uv tool install` or `go install` lands in `~/.local/bin` or `~/go/bin`: put that folder on
PATH (`uv tool update-shell` does it for uv).

## CI

`.github/workflows/`: **validate** (build, kit tests, the smoke, the gate, workflow checks, and a
Windows leg: the machine setup script, the gate, and a project's setup from the packed kit), **poly** (Rust, Go and Python), **test-ts** (the app's tests on Node 22, 24 and 26),
**e2e** (Playwright), **perf** (k6, informational) and **security** (Semgrep and `pnpm audit`).

`pnpm run ci:metrics` prints what those workflows cost and what a pull request waits for: the
billed minutes, each job's time, the slowest steps, and the time from created to merged. It
also names each job whose median is over ten minutes, counts how often a workflow's push runs
went red and how long until the next pass, and counts the trees a workflow ran twice without
one result, which is the sign of a flaky test. Run it before and after a change to a workflow.

A pass of `scripts/verify-clean.sh` keeps the seconds of each step in its record, and the
report prints the slowest. `SMOKE_TIMINGS=1 pnpm run smoke:external-package` prints where the
smoke's time goes. `poly` keeps its two Go tools in a cache whose key hashes the workflow file
that pins them, and `pnpm run workflow:check` fails another key. In CI, a browser test that
passes only on a retry fails the run (`failOnFlakyTests`); the retry stays, because it leaves
the trace.

### An advisory with no fix

`pnpm audit --audit-level=high` is a hard gate. No advisory is left out of it now, and no
package is switched off. (From 2026-11-17 it failed on GHSA-fc5q-39xc-vjpf, picomatch, with no
fixed release; GitHub withdrew that advisory on 2026-11-18.) The audit prints two moderate
advisories (glob, minimatch) in this repository's test and lint dependencies; each fix is a major
version past what its parent asks for. What a project installs with the kit has none: `pnpm
audit --prod` prints `No known vulnerabilities found` (2026-11-19).

To accept an advisory that has no fixed release, for a short time:

1. Check that no fix exists (`pnpm view <package> version`, and the advisory's page), and
   that the advisory still stands (`withdrawn_at` in `https://api.github.com/advisories/<id>`).
2. Find out who can reach the flaw in your project, and write it down.
3. Add `auditConfig.ignoreGhsas` with the id to `pnpm-workspace.yaml` and a record to
   `scripts/audit-exceptions.json`: `id`, `package`, `through` (the last affected version),
   `accepted`, `expires` (at most 30 days later) and `reason`.

`pnpm run workflow:check` fails on an ignored id without a record, on a record without a
reason or longer than 30 days, from the day after `expires` (UTC), and when the package is no
longer installed at an affected version. It does not watch pnpm's other settings: the files
that hold an exception are owner files in `.github/CODEOWNERS`, and the owner approves each
one. Do not use `--ignore-unfixable`: it drops every advisory without a fix, the next one too,
unread.
