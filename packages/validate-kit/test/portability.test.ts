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

const AUDIT_ID = "GHSA-aaaa-bbbb-cccc";
const IGNORES_THE_RECORD = `auditConfig:\n  ignoreGhsas:\n    - ${AUDIT_ID}`;

/** A date some days from today, as the audit's exception records write it. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A copy of what the workflow policy reads. Its one audit exception has dates
 * around today, so no test here fails on the day the real record ends.
 */
function policyCopy() {
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
    "scripts/setup-windows.ps1",
    "scripts/audit-exceptions.json",
    "pnpm-lock.yaml",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  const recordPath = join(root, "scripts/audit-exceptions.json");
  const record = {
    id: AUDIT_ID,
    package: "picomatch",
    through: "99.0.0",
    accepted: day(-1),
    expires: day(1),
    reason: `No fixed release exists, and no pattern comes from outside the project: ${"x".repeat(20)}.`,
  };
  const workspacePath = join(root, "pnpm-workspace.yaml");
  const workspace = readFileSync(workspacePath, "utf8").replace(
    /\nauditConfig:[\s\S]*$/,
    "\n",
  );
  /** Writes the record with some fields changed, and the workspace's audit settings. */
  const accept = (changed: object, settings = IGNORES_THE_RECORD) => {
    writeFileSync(recordPath, JSON.stringify([{ ...record, ...changed }]));
    writeFileSync(workspacePath, `${workspace}${settings}\n`);
  };
  accept({});
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
  return { root, record, recordPath, accept, check };
}

it("runs workflow-specific rejection rules through the actual validator on every host", () => {
  const { root, check } = policyCopy();
  const valid = check();
  expect(valid.stderr, "the unchanged workflow policy must pass").toBe("");
  expect(valid.status).toBe(0);
  // A cache of the Go tools under a key that does not change with their pins
  // would serve a new pin the old binary. An install step that does not ask
  // the cache compiles the tools each run.
  const poly = join(root, ".github/workflows/poly.yml");
  const pinned = readFileSync(poly, "utf8");
  for (const [held, named] of [
    ["${{ hashFiles('.github/workflows/poly.yml') }}", "key: go-tools-"],
    ["        if: steps.go-tools.outputs.cache-hit != 'true'\n", "if: steps"],
  ] as const) {
    expect(pinned).toContain(held);
    writeFileSync(poly, pinned.replace(held, ""));
    const broken = check();
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain(
      `poly workflow must include native-toolchain proof: ${named}`,
    );
  }
  writeFileSync(poly, pinned);
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

it("holds the Windows setup to the versions CI pins, and CI to running it", () => {
  const { root, check } = policyCopy();
  const script = join(root, "scripts/setup-windows.ps1");
  const ci = join(root, ".github/workflows/validate.yml");
  /** The check's stderr with one file changed; the file is then put back. */
  const said = (path: string, from: RegExp, to: string) => {
    const text = readFileSync(path, "utf8");
    expect(text, `${path} has ${String(from)}`).toMatch(from);
    writeFileSync(path, text.replace(from, to));
    const result = check();
    writeFileSync(path, text);
    expect(result.status, result.stderr).toBe(1);
    return result.stderr;
  };
  for (const [from, to, missing] of [
    [/"typos==[\d.]+"/, '"typos==0.0.1"', '"typos==0.0.1"'],
    [/"semgrep==[\d.]+"/, '"semgrep==0.0.1"', 'SEMGREP_VERSION: "0.0.1"'],
    [
      /shfmt@v[\d.]+/,
      "shfmt@v0.0.1",
      "go install mvdan.cc/sh/v3/cmd/shfmt@v0.0.1",
    ],
    [
      /agnix\/releases\/download\/v[\d.]+\//,
      "agnix/releases/download/v0.0.1/",
      "github.com/agent-sh/agnix/releases/download/v0.0.1/",
    ],
  ] as const)
    expect(said(script, from, to)).toContain(
      `validate.yml has no \`${missing}\``,
    );
  // A tool with no version, and a script whose lines this check no longer
  // reads, are not a script that agrees.
  expect(
    said(script, /"check-jsonschema==[\d.]+"/, '"check-jsonschema"'),
  ).toContain(
    '`Run uv tool install --force "check-jsonschema"` installs no pinned version',
  );
  expect(said(script, /^Run go install .*\n/m, "")).toContain(
    "6 install lines found where seven are due",
  );
  // The script's step in another job is not the windows job running it.
  const step = /^ +\.\/scripts\/setup-windows\.ps1$/m;
  expect(said(ci, step, "          pnpm install")).toContain(
    "the windows job must run ./scripts/setup-windows.ps1",
  );
  const workflow = readFileSync(ci, "utf8");
  writeFileSync(
    ci,
    `${workflow.replace(step, "          pnpm install")}  other:\n    runs-on: windows-latest\n    steps:\n      - run: |\n          ./scripts/setup-windows.ps1\n`,
  );
  expect(check().stderr).toContain(
    "the windows job must run ./scripts/setup-windows.ps1",
  );
  writeFileSync(ci, workflow);
  expect(check().status, "the files as they are pass").toBe(0);
});

it("lets the audit leave out one advisory by id, with a record that ends", () => {
  const { record, recordPath, accept, check } = policyCopy();
  const refuses = (said: string) => {
    const refused = check();
    expect(refused.status, said).toBe(1);
    expect(refused.stderr).toContain(said);
  };
  const passes = (what: string) => {
    expect(check().stderr, what).toBe("");
  };
  passes("one id, one record, dates around today");

  for (const [changed, said] of [
    [{ expires: day(-1), accepted: day(-9) }, `ended on ${day(-1)}`],
    [{ expires: day(40) }, "at most 30 days after it is accepted"],
    [{ accepted: day(3), expires: day(9) }, "a day to come"],
    [{ expires: "2026-02-31" }, "the dates `accepted` and `expires`"],
    [{ accepted: "2026-02-31" }, "the dates `accepted` and `expires`"],
    [{ package: 1 }, "must have a package"],
    [{ through: "4.0" }, "a last affected version `through` (1.2.3)"],
    [{ through: "0.0.1" }, "no picomatch at or below 0.0.1 is installed"],
    [{ reason: "no fix" }, "a reason of a sentence or more"],
    [{ id: "GHSA-xxxx-yyyy-zzzz" }, "must hold one record of it"],
  ] as const) {
    accept(changed);
    refuses(said);
  }
  accept({ accepted: day(1), expires: day(9) });
  passes("the local day east of UTC is one ahead");
  accept({}, "");
  refuses("is not in auditConfig.ignoreGhsas");
  accept({});
  writeFileSync(recordPath, JSON.stringify([record, record]));
  refuses("must hold one record of it");
  writeFileSync(recordPath, "{}");
  refuses("must be a list of records");
  // The list is by id: a second key beside it would leave out more.
  accept({}, `${IGNORES_THE_RECORD}\n  ignoreCves: []`);
  refuses("auditConfig.ignoreCves: the audit leaves out an advisory by its id");
  // An id that reaches the list through a YAML merge key, as pnpm reads it.
  accept(
    {},
    `a: &a\n  ignoreGhsas: [GHSA-xxxx-yyyy-zzzz]\nauditConfig:\n  <<: *a`,
  );
  refuses("the audit ignores GHSA-xxxx-yyyy-zzzz");
});
