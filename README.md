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

## Work on this repository

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

## Work with an agent

The kit checks what an agent wrote at three points. Each one follows Anthropic's write-up on
verification or its article on verification loops with skills.

- **When the agent ends a turn.** `validate-kit init` writes a Claude Code stop hook
  (`validate-kit hook claude`). It checks the files the agent changed. It prints nothing when
  they pass and hands the findings back when they do not: up to three times on one prompt for
  the main agent, and once for a subagent. After that the user reads what is still open.
- **When the agent shows its change running.** A `verify` skill beside the code says how to run
  it and what a pass shows. `apps/web/.claude/skills/verify/SKILL.md` and
  `apps/api/.claude/skills/verify/SKILL.md` are two examples; a project writes its own.
- **When the agent commits.** `scripts/commit-gate.mjs` stamps each commit of a Claude Code
  session with what verified it, for the tree it ran on: `Verified: review, verify`, or `none`.
  Nothing starts it in this copy. Its header names the four hook events to put in a
  `.claude/settings.json`, and `pnpm run smoke:commit-gate` runs every case.

Two more scripts read a repository's history. `scripts/review-scope.mjs` reads `REVIEW.md` and
the CODEOWNERS file from the base commit of a repository that has both, and prints the change's
risk tier and the checklist items it fires; this copy has no `REVIEW.md`.
`scripts/review-metrics.mjs` counts, from git, the changes that were reverted or that a later
fix had to touch again.

Property tests are the project's own: the kit's rules catch one that tests less than it looks,
and its `saved-failures` check keeps a failing case a library saved in the commit. The package
README names both.

## What must be on PATH

`git`, `brew` and `mise`, with mise activated in your shell so that the runtimes it installs are
on PATH. Nothing else by hand: the three install lines above put every tool of this
repository's gate in a folder mise adds, in Homebrew's folder or in `node_modules/.bin`.
`pnpm exec check doctor --profile ci` prints one line per tool with its version, or the install
line when it is missing.

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
Windows leg), **poly** (Rust, Go and Python), **test-ts** (the app's tests on Node 22, 24 and 26),
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
