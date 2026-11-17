import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnNodeCommandSync } from "./node-command.mjs";

/** The real native tool, pinned by the existing API-contract CI gate. */
export function nativeOasdiff(settings = {}) {
  const module = "github.com/oasdiff/oasdiff";
  const workflow = readFileSync(
    new URL("../.github/workflows/validate.yml", import.meta.url),
    "utf8",
  );
  const version =
    /go install github\.com\/oasdiff\/oasdiff@(v\d+\.\d+\.\d+)/.exec(
      workflow,
    )?.[1];
  if (!version) throw new Error("The API-contract workflow must pin oasdiff");
  // Match the upstream release build: plain go install reports "main".
  const versionFlag = `-X ${module}/build.Version=${version.slice(1)}`;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const binDir = resolve(
    tmpdir(),
    "validate-kit-native-tests",
    process.platform,
    process.arch,
    version,
  );
  const binary = join(
    binDir,
    process.platform === "win32" ? "oasdiff.exe" : "oasdiff",
  );
  const env = { ...process.env };
  // As in verify-clean, Go chooses its own root after a toolchain upgrade.
  delete env.GOROOT;
  const run = (command, args, options = {}) =>
    (settings.spawnSync ?? spawnNodeCommandSync)(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      ...options,
    });
  const matches = () => {
    const info = run("go", ["version", "-m", binary]);
    const lines = (info.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
    return (
      !info.error &&
      info.status === 0 &&
      info.stdout.includes(versionFlag) &&
      lines.includes(`path\t${module}`) &&
      lines.some((line) => line.startsWith(`mod\t${module}\t${version}\t`))
    );
  };
  if (!matches()) {
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const installed = run(
      "go",
      ["install", "-ldflags", versionFlag, `${module}@${version}`],
      {
        env: { ...env, GOBIN: binDir, GOTOOLCHAIN: "local" },
        timeout: 600_000,
      },
    );
    // A competing installer may finish after our Go process lost a rename.
    // Accept only the final pinned module proof and the CLI proof below.
    if (!matches()) {
      throw new Error(
        `Pinned native oasdiff could not be installed: ${installed.error?.message ?? installed.stderr?.slice(-4000)}`,
      );
    }
  }
  const probe = run(binary, ["--version"]);
  if (
    probe.error ||
    probe.status !== 0 ||
    !probe.stdout?.includes(version.slice(1))
  ) {
    throw new Error(
      `Pinned native oasdiff did not report ${version}: ${probe.error?.message ?? probe.stderr}`,
    );
  }
  return binary;
}
