# validate-kit task runner.
# The CLI is invoked directly via `node` so recipes always exercise the freshly
# built local dist artifact after `just build`.

cli := "node packages/validate-kit/dist/cli.js"

# Show available recipes
default:
    @just --list

# Build the validate-kit CLI (required before running `check`)
build:
    cd packages/validate-kit && ./node_modules/.bin/tsup

# Run the full validation pipeline across all detected languages
check:
    {{cli}} --profile ci

# Apply autofixes
fix:
    {{cli}} --profile dev --fix

# Only validate files changed in the working tree
check-changed:
    {{cli}} --profile dev

# Validate intentional failure fixtures (expected to report findings)
check-fixtures:
    {{cli}} --profile fixtures --only ast-grep

# Only validate staged files (used by the pre-commit hook)
check-staged:
    {{cli}} --profile dev --staged --fix

# CI gate: validate the configured production scope, machine output + SARIF
ci:
    {{cli}} --profile ci --sarif results.sarif

# Verify the toolchain (install/version matrix)
doctor:
    {{cli}} doctor

# Show detected languages + the tasks that would run
list:
    {{cli}} list

# Run the ast-grep custom-rule snapshot tests
rules-test:
    cd packages/validate-kit && ./node_modules/.bin/ast-grep test

# Run the validate-kit unit/behavioral tests
test:
    cd packages/validate-kit && ./node_modules/.bin/vitest run

# Provision runtimes (mise), the validation tools one by one (Brewfile) + JS deps (pnpm)
install-tools:
    mise install
    brew bundle --no-upgrade
    corepack prepare pnpm@10.34.7 --activate
    pnpm install --frozen-lockfile

# Install the Chromium browser binary required by local Playwright E2E/visual tests
install-web-browsers:
    pnpm --fail-if-no-match --filter web exec playwright install chromium

# Scaffold a starter config + install git hooks in the current repo
init:
    {{cli}} init

# k6 performance smoke test. Uses API_URL when provided; otherwise boots the API.
perf:
    pnpm run workflow:perf-local
