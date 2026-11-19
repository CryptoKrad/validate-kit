# The Windows twin of `just install-tools`: what a Windows machine needs to run
# this repository's gate (`pnpm run check`) and the kit's tests.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
#
# First, once per machine: Git for Windows and mise (`winget install Git.Git
# jdx.mise`), then `mise install` here, in a terminal where mise is activated.
# That puts node, pnpm, go and uv on PATH (mise.toml). README, "The machine, on
# Windows".
#
# The tools are the versions CI installs (.github/workflows/validate.yml);
# `pnpm run workflow:check` fails when one differs. CI's `windows` job runs
# this file, then the gate.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run($exe) {
  & $exe @args
  if ($LASTEXITCODE -ne 0) { throw "$exe $args ended with exit code $LASTEXITCODE" }
}

$missing = @("git", "node", "pnpm", "go", "uv") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) {
  throw "Not on PATH: $($missing -join ', '). Install Git for Windows and mise, run 'mise install' in this folder, and start this script from a terminal where mise is activated."
}

# One folder for every tool: where uv puts the tools it installs.
$bin = (& uv tool dir --bin).Trim()
New-Item -ItemType Directory -Force $bin | Out-Null
$env:Path = "$bin;$env:Path"

Run uv tool install --force "semgrep==1.184.0"
Run uv tool install --force "zizmor==1.32.0"
Run uv tool install --force "typos==1.52.0"
Run uv tool install --force "check-jsonschema==0.39.0"

$env:GOBIN = $bin
Run go install mvdan.cc/sh/v3/cmd/shfmt@v3.14.1

# A release's zip, checked against its SHA-256 before anything is unpacked.
function Fetch($url, $sha256, $exe) {
  $zip = Join-Path ([IO.Path]::GetTempPath()) "$exe.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha256) { throw "$url has SHA-256 $got, not $sha256" }
  Expand-Archive -Force $zip "$zip.d"
  Copy-Item -Force (Join-Path "$zip.d" $exe) $bin
}
Fetch "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.zip" "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e" "shellcheck.exe"
Fetch "https://github.com/agent-sh/agnix/releases/download/v0.61.0/agnix-x86_64-pc-windows-msvc.zip" "5beca7601728969d807c488a6be759eb6b0ee2dd4aa90147719aefab01a5ebf3" "agnix.exe"

Run pnpm install --frozen-lockfile
Run pnpm run build

# For terminals opened after this one. It ends non-zero when the folder is
# already on PATH, so its exit code is not read.
& uv tool update-shell

# The verdict: one line per tool of the gate, and exit 3 when one is missing.
Run node packages/validate-kit/dist/cli.js doctor --profile ci
Write-Host "Ready. In a new terminal: pnpm run check"
