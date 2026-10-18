# The validation tools, one by one (mise.toml holds runtimes only).
# JS-ecosystem tools (pnpm, oxlint, eslint) come from Corepack/pnpm
# devDependencies. Keep pnpm out of Homebrew so packageManager stays pinned.
brew "node"          # >= 22.13 (24/26 fine)
brew "just"
brew "ast-grep"
brew "ruff"
brew "golangci-lint"
brew "gofumpt"
brew "semgrep"
brew "shellcheck"
brew "gitleaks"
brew "mypy"          # where a project configures it
brew "cargo-deny"    # where a crate has deny.toml
# go install go.uber.org/nilaway/cmd/nilaway@latest   (opt-in)
# go install golang.org/x/vuln/cmd/govulncheck@latest (with vulnAudit)
# uv tool install slither-analyzer                    (Solidity)
brew "cargo-mutants"  # where a crate has .cargo/mutants.toml (ci profile)
tap "go-gremlins/tap"
brew "go-gremlins/tap/gremlins"  # Go mutation, where a module has .gremlins.yaml (ci profile)
# Stryker and mutmut are the project's own dev dependencies (mutmut in .venv)
brew "zizmor"         # GitHub Actions security, where a zizmor.yml is (this repo: .github/zizmor.yml)
brew "typos-cli"      # misspellings, where a typos config is (this repo: _typos.toml)
# uv tool install deptry           (Python imports vs declared deps; or the project's dev dep)
# cargo install --locked cargo-machete  (unused Rust deps, where [package.metadata.cargo-machete] is)
# uv tool install import-linter==2.15   (Python import contracts, where [tool.importlinter] is)
# On demand, never in a hook (docs/research/agent-tooling-gaps/on-demand-tools.md):
brew "difftastic"   # difft: syntax-aware diffs of an agent's commit
# GOBIN=~/.local/bin go install golang.org/x/perf/cmd/benchstat@v0.0.0-20261009192801-be2c69fb417e
# uv tool install diff-cover==10.6.0    (changed lines no test runs, where tools.diff-cover.enabled is)
# uv tool install lizard==1.24.0        (function complexity ratchet, where tools.lizard.enabled is)
brew "uv"            # Python toolchain manager
brew "go"
brew "rust"          # or rustup; provides cargo/clippy/rustfmt
brew "k6"
brew "mise"          # optional, for the mise.toml runtimes
