/**
 * A tool's install line as a Windows machine can run it. The adapters write
 * their hint for macOS first (`brew install …`). On Windows the nearest thing
 * is Scoop: one command for the user, with no admin rights.
 *
 * Each Scoop name was read from the bucket's manifest on 2026-11-19
 * (github.com/ScoopInstaller/Main and Extras). A formula that is in neither
 * list has no Scoop package: the hint's other way is shown.
 */
const SAME_NAME =
  "actionlint ast-grep buf coursier cppcheck detekt editorconfig-checker gitleaks golangci-lint hadolint ktlint kube-linter kubeconform lefthook llvm ls-lint lychee maven opentofu osv-scanner pluto ruff shellcheck shfmt sqlc sqruff stylua taplo trivy ty uv zig zizmor";
const SCOOP: Record<string, string> = {
  ...Object.fromEntries(SAME_NAME.split(" ").map((name) => [name, name])),
  "clang-format": "llvm",
  "dart-lang/dart/dart": "dart",
  dotnet: "dotnet-sdk",
  // Scoop's elixir does not bring Erlang with it.
  elixir: "erlang elixir",
  "terraform-linters/tap/tflint": "tflint",
  "typos-cli": "typos",
};
/** In Scoop's `extras` bucket, which a user adds once. */
const EXTRAS = new Set(["google-java-format", "selene"]);

/** No package manager on Windows holds these: the whole line, from the tool's own install page. */
const ONLY: Record<string, string> = {
  foundry:
    "in Git Bash (foundryup does not run in PowerShell): curl -L https://foundry.paradigm.xyz | bash, then foundryup",
  nixfmt: "Nix has no Windows build: run this check under WSL",
  periphery:
    "Periphery supports macOS and Linux only: run this check there, or under WSL",
  pmd: "the zip from https://github.com/pmd/pmd/releases, with its bin folder on PATH (it runs as pmd.bat)",
  "swift-format":
    "it comes with the Swift toolchain, from Swift 6 (https://www.swift.org/install/windows/)",
  swiftlint:
    "SwiftLint names no Windows install: run this check on macOS or Linux, or under WSL",
  zsh: "zsh has no Windows build: run this check under WSL",
};

const BREW = /brew install ([\w@.+/-]+(?: [\w@.+/-]+)*)/;
/** Words of a way that a Windows machine does not have. */
const NOT_WINDOWS =
  /\bapt install\b|\| ?(?:bash|sh)\b|Xcode|macOS|Homebrew|keg-only|\bnix profile\b/;

function scoop(formulas: string[]): string | undefined {
  if (!formulas.every((name) => SCOOP[name] ?? EXTRAS.has(name))) return;
  const names = formulas.map((name) => SCOOP[name] ?? name).join(" ");
  const bucket = formulas.some((name) => EXTRAS.has(name))
    ? "scoop bucket add extras; "
    : "";
  return `${bucket}scoop install ${names}`;
}

export function windowsInstallHint(hint: string): string {
  if (!/brew|Homebrew/.test(hint)) return hint;
  const [, main = "", note] = /^(.*?)(?: {2}\((.*)\))?$/.exec(hint) ?? [];
  const others = note?.startsWith("or: ") ? note.slice(4).split("; ") : [];
  const tail = note?.startsWith("or: ") ? undefined : note;
  const ways: string[] = [];
  for (const way of [main, ...others]) {
    const formulas = BREW.exec(way)?.[1]?.split(" ");
    if (formulas === undefined) {
      if (!NOT_WINDOWS.test(way)) ways.push(way);
      continue;
    }
    const only = formulas.map((name) => ONLY[name]).find(Boolean);
    if (only !== undefined) return only;
    const line = scoop(formulas);
    if (line !== undefined) ways.push(line);
  }
  const [first, ...rest] = ways;
  // No way left: the hint stays as it is, and the test of every adapter's
  // hint fails until the formula has a line above.
  if (first === undefined) return hint;
  const kept =
    tail === undefined || NOT_WINDOWS.test(tail)
      ? ""
      : `  (${tail.replace(BREW, (whole, names: string) => scoop(names.split(" ")) ?? whole)})`;
  return `${first}${rest.length > 0 ? `  (or: ${rest.join("; ")})` : ""}${kept}`;
}

/** An install line as this machine can run it. */
export function installLine(hint: string): string {
  return process.platform === "win32" ? windowsInstallHint(hint) : hint;
}
