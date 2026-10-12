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
brew "uv"            # Python toolchain manager
brew "go"
brew "rust"          # or rustup; provides cargo/clippy/rustfmt
brew "k6"
brew "mise"          # optional, for the mise.toml runtimes
