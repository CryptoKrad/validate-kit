import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "../src/adapters/registry.js";
import { windowsInstallHint } from "../src/core/windows-install.js";

/** The registry as a machine of that platform loads it. */
async function registryOn(name: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: name });
  vi.resetModules();
  return import("../src/adapters/registry.js");
}

describe("an install hint as a Windows machine can run it", () => {
  it("gives every adapter a line with no Homebrew, apt or macOS path in it", () => {
    const left = TOOL_REGISTRY.map(
      (adapter) => `${adapter.id}: ${windowsInstallHint(adapter.installHint)}`,
    ).filter((line) =>
      /\bbrew\b|Homebrew|keg-only|\/opt\/|\bapt install\b|Xcode/.test(line),
    );
    expect(left).toEqual([]);
  });

  it.each([
    [
      "brew install shellcheck  (or: apt install shellcheck)",
      "scoop install shellcheck",
    ],
    [
      "brew install typos-cli  (or: cargo install typos-cli)",
      "scoop install typos  (or: cargo install typos-cli)",
    ],
    [
      "brew install semgrep  (or: pipx install semgrep)",
      "pipx install semgrep",
    ],
    ["uv tool install mypy  (or: brew install mypy)", "uv tool install mypy"],
    [
      "gem install rubocop  (or: brew install rubocop; a Gemfile's binstub: tools.rubocop.bin: bin/rubocop)",
      "gem install rubocop  (or: a Gemfile's binstub: tools.rubocop.bin: bin/rubocop)",
    ],
    [
      "brew install detekt ktlint  (ktlint checks that each file parses: detekt does not)",
      "scoop install detekt ktlint  (ktlint checks that each file parses: detekt does not)",
    ],
    [
      "brew install llvm  (keg-only: set tools.clang-tidy.bin to /opt/homebrew/opt/llvm/bin/clang-tidy)",
      "scoop install llvm",
    ],
    [
      "coursier install scalafmt  (coursier: brew install coursier)",
      "coursier install scalafmt  (coursier: scoop install coursier)",
    ],
    [
      "brew install selene  (or: cargo install selene)",
      "scoop bucket add extras; scoop install selene  (or: cargo install selene)",
    ],
    [
      "brew install periphery",
      "Periphery supports macOS and Linux only: run this check there, or under WSL",
    ],
    ["cargo install --locked agnix-cli", "cargo install --locked agnix-cli"],
  ])("%s", (hint, onWindows) => {
    expect(windowsInstallHint(hint)).toBe(onWindows);
  });

  it("is what every reader of the registry gets on Windows, and only there", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      const onWindows = await registryOn("win32");
      expect(onWindows.adapterById("shellcheck")?.installHint).toBe(
        "scoop install shellcheck",
      );
      expect(
        onWindows.TOOL_REGISTRY.filter((adapter) =>
          /\bbrew\b/.test(adapter.installHint),
        ).map((adapter) => adapter.id),
      ).toEqual([]);
      const onMac = await registryOn("darwin");
      expect(onMac.adapterById("shellcheck")?.installHint).toMatch(
        /^brew install shellcheck/,
      );
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      vi.resetModules();
    }
  });

  it("covers each Homebrew line the kit prints outside the adapters", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const bare = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !/^adapters[\\/]/.test(file))
      .flatMap((file) =>
        readFileSync(join(src, file), "utf8")
          .split("\n")
          .filter(
            (line) =>
              /brew install/.test(line) &&
              !/installLine\("brew install [\w-]+"\)/.test(line) &&
              !file.endsWith("windows-install.ts"),
          )
          .map((line) => `${file}: ${line.trim()}`),
      );
    expect(bare).toEqual([]);
    expect(windowsInstallHint("brew install lefthook")).toBe(
      "scoop install lefthook",
    );
  });

  it("leaves a formula it has no line for as it is, so the first test names it", () => {
    expect(windowsInstallHint("brew install not-a-real-formula")).toBe(
      "brew install not-a-real-formula",
    );
  });
});
