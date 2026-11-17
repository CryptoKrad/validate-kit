import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Windows has no POSIX execute bit. Prove the committed bin's Git mode and
// execute the real Node entry instead of interpreting Windows stat bits.
export function packageExecutableProblem(
  entry,
  {
    root = process.cwd(),
    platform = process.platform,
    run = spawnSync,
    stat = statSync,
  } = {},
) {
  if (platform !== "win32") {
    return (stat(resolve(root, entry)).mode & 0o111) === 0
      ? `${entry} must be executable for package bin use`
      : undefined;
  }
  const launcher = "packages/validate-kit/bin/validate-kit.mjs";
  const tracked = run("git", ["ls-files", "--stage", "-z", "--", launcher], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: false,
  });
  const mode =
    /^100755 [a-f0-9]{40,64} 0\tpackages\/validate-kit\/bin\/validate-kit\.mjs\0$/.test(
      tracked.stdout ?? "",
    );
  if (tracked.error || tracked.status !== 0 || !mode) {
    return `${launcher} must have tracked Git mode 100755 for package bin use`;
  }
  const manifest = JSON.parse(
    readFileSync(resolve(root, "packages/validate-kit/package.json"), "utf8"),
  );
  if (
    manifest.bin?.check !== "./bin/validate-kit.mjs" ||
    manifest.bin?.["validate-kit"] !== "./bin/validate-kit.mjs" ||
    typeof manifest.version !== "string"
  ) {
    return "Package bin declarations must name the committed validate-kit launcher";
  }
  const proof = run(process.execPath, [resolve(root, entry), "--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: false,
  });
  return proof.error ||
    proof.status !== 0 ||
    proof.stdout?.trim() !== manifest.version
    ? `${entry} must execute and report the package version for package bin use`
    : undefined;
}
