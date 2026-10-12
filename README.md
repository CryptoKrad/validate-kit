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
pnpm add -D --allow-build=@ast-grep/cli ~/validate-kit-<version>.tgz
pnpm exec validate-kit init     # config, git hooks through lefthook, MCP entry
pnpm exec validate-kit doctor   # which tools this machine can run
pnpm exec validate-kit check
```

Never install it by name from npm: the unscoped name there belongs to an unrelated package.

`init` wires two git hooks: `check --staged` before a commit and `check --profile ci` before a
push, both with `--quiet`. A passing hook prints an empty line; a failing one prints one line per
finding and the exit code.

## Work on this repository

```bash
mise install && brew bundle      # runtimes, then the native tools (Brewfile)
pnpm install --frozen-lockfile
pnpm run build                   # packages/validate-kit/dist/cli.js
pnpm run check                   # the gate CI runs
pnpm --filter validate-kit run test
pnpm run smoke:external-package  # packs the kit and runs it in temporary repositories
scripts/verify-clean.sh --ci     # what CI's push jobs run, on a clean worktree of HEAD
```

## CI

`.github/workflows/`: **validate** (build, kit tests, the smoke, the gate, workflow checks, and a
Windows leg), **poly** (Rust, Go and Python), **test-ts** (the app's tests on Node 22 and 24),
**e2e** (Playwright), **perf** (k6, informational) and **security** (Semgrep and `pnpm audit`).
