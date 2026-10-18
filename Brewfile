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
# The state-of-the-art wave (2026-10-18; docs/research/lint-toolchain/sota-2026-10-18/).
# Each runs where its language or config is (library/README.md says which).
brew "hadolint"            # Dockerfiles
brew "taplo"               # TOML, where a taplo config is
brew "yamllint"            # YAML, where a .yamllint is
brew "markdownlint-cli2"   # Markdown, where its config is
brew "lychee"              # links in docs, offline, where lychee.toml is
brew "ls-lint"             # file and folder names, where .ls-lint.yml is
brew "reuse"               # SPDX headers, where REUSE.toml is
brew "buf"                 # protobuf lint, format, breaking changes
brew "sqruff"              # SQL lint, where .sqruff is
brew "sqlc"                # generated query code, where sqlc.yaml is
brew "graphql-inspector"   # GraphQL schema breaking changes
brew "opentofu"            # tofu fmt for Terraform
brew "trivy"               # IaC misconfiguration, where trivy.yaml is
brew "kubeconform"         # Kubernetes manifests (opt-in)
brew "kube-linter"         # Kubernetes, where .kube-linter.yaml is
brew "pluto"               # deprecated Kubernetes APIs (opt-in)
brew "basedpyright"        # Python types, where configured
brew "ty"                  # Python types (pre-1.0), where configured
brew "vulture"             # Python dead code, where [tool.vulture] is
brew "cargo-hack"          # Rust feature powerset (opt-in, ci)
brew "clang-format"        # C/C++, where .clang-format is
brew "llvm"                # clang-tidy (keg-only: /opt/homebrew/opt/llvm/bin)
brew "cppcheck"            # C/C++ (opt-in)
brew "zig"                 # zig fmt and ast-check
brew "google-java-format"  # Java (opt-in)
brew "pmd"                 # Java, where a ruleset is
brew "ktlint"              # Kotlin, where .editorconfig has ktlint_ keys
brew "detekt"              # Kotlin, where detekt.yml is
brew "coursier"            # installs scalafmt (coursier install scalafmt)
brew "dotnet"              # dotnet format and build analyzers
brew "composer"            # PHP packages (Pint)
brew "phpstan"             # PHP types, where phpstan.neon is
brew "php-cs-fixer"        # PHP format, where .php-cs-fixer.php is
brew "rubocop"             # Ruby, where .rubocop.yml is
brew "elixir"              # mix format and credo (erlang: /opt/homebrew/opt/erlang/bin)
brew "swiftlint"           # Swift, where .swiftlint.yml is
brew "swift-format"        # Swift, where .swift-format is
tap "dart-lang/dart"
brew "dart-lang/dart/dart" # dart format and analyze
brew "stylua"              # Lua format, where stylua.toml is
brew "selene"              # Lua lint, where selene.toml is
brew "hlint"               # Haskell lint
brew "ormolu"              # Haskell format
brew "opam"                # installs ocamlformat (opam install ocamlformat)
brew "nixfmt"              # Nix format
brew "statix"              # Nix lint
brew "buildifier"          # Bazel BUILD and .bzl files
brew "stylelint"           # CSS, where a stylelint config is
brew "solhint"             # Solidity, where .solhint.json is
brew "foundry"             # forge fmt for Solidity
# cargo install --locked cargo-semver-checks deadnix
# GOTOOLCHAIN=auto go install github.com/google/capslock/cmd/capslock@v0.3.4
# go install golang.org/x/exp/cmd/gorelease@latest github.com/fe3dback/go-arch-lint@v1.19.0
# uv tool install crosshair-tool==0.0.111 ; gem install --user-install brakeman
brew "uv"            # Python toolchain manager
brew "go"
brew "rust"          # or rustup; provides cargo/clippy/rustfmt
brew "k6"
brew "mise"          # optional, for the mise.toml runtimes
