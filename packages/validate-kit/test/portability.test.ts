import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import "./isolated-git.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const created: string[] = [];
const launcher = "packages/validate-kit/bin/validate-kit.mjs";
const built = "packages/validate-kit/dist/cli.js";
const { packageExecutableProblem } = (await import(
  pathToFileURL(join(repo, "scripts/package-bin-proof.mjs")).href
)) as {
  packageExecutableProblem: (
    entry: string,
    options?: {
      root?: string;
      platform?: NodeJS.Platform;
      run?: typeof spawnSync;
      stat?: (file: string) => { mode: number };
    },
  ) => string | undefined;
};

function rejectPosixDispatch(): never {
  throw new Error("POSIX mode checks must not dispatch a command");
}

afterEach(() => {
  for (const root of created.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "vk-portability with spaces-"));
  created.push(root);
  for (const file of [launcher, built]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(
      join(root, file),
      "#!/usr/bin/env node\nconsole.log('1.2.3');\n",
    );
  }
  writeFileSync(
    join(root, "packages/validate-kit/package.json"),
    JSON.stringify({
      version: "1.2.3",
      bin: {
        check: "./bin/validate-kit.mjs",
        "validate-kit": "./bin/validate-kit.mjs",
      },
    }),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", launcher], {
    cwd: root,
  });
  execFileSync("git", ["update-index", "--chmod=+x", "--", launcher], {
    cwd: root,
  });
  return root;
}

it("retains POSIX execute-bit checks without invoking a Windows proof", () => {
  expect(
    packageExecutableProblem(launcher, {
      platform: "linux",
      stat: () => ({ mode: 0o100644 }),
      run: rejectPosixDispatch,
    }),
  ).toContain("must be executable");
  expect(
    packageExecutableProblem(launcher, {
      platform: "linux",
      stat: () => ({ mode: 0o100755 }),
      run: rejectPosixDispatch,
    }),
  ).toBeUndefined();
});

it("proves Windows package entries through tracked mode and their real Node output", () => {
  const root = fixture();
  expect(
    packageExecutableProblem(launcher, { root, platform: "win32" }),
  ).toBeUndefined();
  expect(
    packageExecutableProblem(built, { root, platform: "win32" }),
  ).toBeUndefined();
  writeFileSync(join(root, built), "console.log('9.9.9');\n");
  expect(
    packageExecutableProblem(built, { root, platform: "win32" }),
  ).toContain("must execute and report");
});

it("rejects a non-executable Git launcher even when Windows Node can run it", () => {
  const root = fixture();
  execFileSync("git", ["update-index", "--chmod=-x", "--", launcher], {
    cwd: root,
  });
  expect(
    packageExecutableProblem(launcher, { root, platform: "win32" }),
  ).toContain("Git mode 100755");
});

it("does not accept package-bin declarations that point to a different entry", () => {
  const root = fixture();
  writeFileSync(
    join(root, "packages/validate-kit/package.json"),
    JSON.stringify({
      version: "1.2.3",
      bin: { check: "./dist/cli.js", "validate-kit": "./dist/cli.js" },
    }),
  );
  expect(
    packageExecutableProblem(launcher, { root, platform: "win32" }),
  ).toContain("Package bin declarations");
});

it("runs workflow-specific rejection rules through the actual validator on every host", () => {
  const root = mkdtempSync(join(tmpdir(), "vk-workflow-portability-"));
  created.push(root);
  for (const path of [
    ".github/workflows",
    "package.json",
    "mise.toml",
    "pnpm-workspace.yaml",
    "apps/api/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
    "packages/validate-kit/package.json",
    "scripts/verify-clean.sh",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  const check = () =>
    spawnSync(
      process.execPath,
      [join(repo, "scripts/validate-workflows.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        shell: false,
      },
    );
  const valid = check();
  expect(valid.stderr, "the unchanged workflow policy must pass").toBe("");
  expect(valid.status).toBe(0);
  const workflow = join(root, ".github/workflows/validate.yml");
  const original = readFileSync(workflow, "utf8");
  expect(original).toContain("cancel-in-progress: true");
  writeFileSync(
    workflow,
    original.replace("cancel-in-progress: true", "cancel-in-progress: false"),
  );
  const rejected = check();
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain(
    "workflow must set concurrency.cancel-in-progress: true",
  );
  let mutantChanged = true;
  let windowsControl: { error?: Error; stderr: string } | undefined;
  if (process.platform === "win32") {
    // Re-run the real validator with its old platform-specific enumeration.
    // Other policies can still fail, but this workflow-specific guard vanishes.
    const originalValidator = join(repo, "scripts/validate-workflows.mjs");
    const yaml = pathToFileURL(
      createRequire(import.meta.url).resolve("yaml"),
    ).href;
    const mutant = readFileSync(originalValidator, "utf8")
      .replace('from "yaml"', `from ${JSON.stringify(yaml)}`)
      .replace("posix.join(workflowDir, file)", "join(workflowDir, file)");
    mutantChanged = mutant !== readFileSync(originalValidator, "utf8");
    const mutantPath = join(root, "missing-path-normalization.mjs");
    writeFileSync(mutantPath, mutant);
    const bypassed = spawnSync(process.execPath, [mutantPath], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      shell: false,
    });
    windowsControl = bypassed;
  }
  expect(mutantChanged).toBe(true);
  expect(windowsControl?.error).toBeUndefined();
  expect(windowsControl?.stderr ?? "").not.toContain(
    "workflow must set concurrency.cancel-in-progress: true",
  );
});
