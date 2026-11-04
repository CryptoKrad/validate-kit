import "./isolated-git.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { scaffoldHook, type Writer } from "../src/commands/init-hook.js";
import { EXIT } from "../src/core/exit-codes.js";
import { run } from "../src/core/exec.js";

const writer: Writer = {
  dryRun: false,
  write: (path, text) => {
    writeFileSync(path, text);
  },
};
const scriptName = "validate-kit-preflight.sh";
const oldScriptName = "validate-kit-existing.sh";
const scriptDir = ".lefthook/pre-push";

function fixture(): string {
  return mkdtempSync(resolve(tmpdir(), "validate-kit-init-scripts-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

describe("init pre-push scripts", () => {
  it("writes a script job with explicit command arguments and migrates its run-based config", async () => {
    const root = fixture();
    expect(await scaffoldHook(root, "validate-kit", writer)).toBeUndefined();
    const configPath = resolve(root, "lefthook.yml");
    const config = readFileSync(configPath, "utf8");
    const parsed = parseYaml(config) as {
      "pre-push": { jobs: unknown[] };
    };
    expect(parsed["pre-push"].jobs).toEqual([
      {
        name: "preflight",
        script: scriptName,
        runner: "sh",
        args: "validate-kit check --profile ci --quiet",
      },
    ]);
    expect(readFileSync(resolve(root, scriptDir, scriptName), "utf8")).toBe(
      '#!/bin/sh\n# Written by validate-kit init.\nexec "$@"\n',
    );

    const previous = config.replace(
      `      script: ${scriptName}\n      runner: sh\n      args:`,
      "      run:",
    );
    expect(previous).not.toBe(config);
    const migrated = fixture();
    writeFileSync(resolve(migrated, "lefthook.yml"), previous);
    expect(
      await scaffoldHook(migrated, "validate-kit", writer),
    ).toBeUndefined();
    expect(readFileSync(resolve(migrated, "lefthook.yml"), "utf8")).toBe(
      config,
    );
    expect(existsSync(resolve(migrated, scriptDir, scriptName))).toBe(true);
  });

  it("keeps custom configs unchanged and asks explicitly to adopt script jobs", async () => {
    const root = fixture();
    git(root, "init", "-q");
    const configPath = resolve(root, "lefthook.yml");
    const config =
      "pre-commit:\n  jobs:\n    - run: validate-kit check --staged\npre-push:\n  jobs:\n    - run: validate-kit check --profile ci\n";
    writeFileSync(configPath, config);
    const hook = resolve(root, ".git/hooks/pre-push");
    const custom = "#!/bin/sh\nexit 0\n";
    writeFileSync(hook, custom, { mode: 0o755 });

    expect(await scaffoldHook(root, "validate-kit", writer)).toBe(EXIT.CONFIG);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(hook, "utf8")).toBe(custom);
    expect(existsSync(`${hook}.old`)).toBe(false);
    expect(existsSync(resolve(root, ".lefthook"))).toBe(false);
  });

  it("refuses script collisions before writing the config or moving an old hook", async () => {
    await Promise.all(
      [`${scriptDir}/${oldScriptName}`, ".lefthook/validate-kit-rc.sh"].map(
        async (name) => {
          const root = fixture();
          git(root, "init", "-q");
          const hook = resolve(root, ".git/hooks/pre-push");
          const custom = "#!/bin/sh\nexit 0\n";
          writeFileSync(hook, custom, { mode: 0o755 });
          mkdirSync(resolve(root, scriptDir), { recursive: true });
          const colliding = resolve(root, name);
          writeFileSync(colliding, "user-owned\n");

          expect(await scaffoldHook(root, "validate-kit", writer)).toBe(
            EXIT.CONFIG,
          );
          expect(readFileSync(colliding, "utf8")).toBe("user-owned\n");
          expect(readFileSync(hook, "utf8")).toBe(custom);
          expect(existsSync(`${hook}.old`)).toBe(false);
          expect(existsSync(resolve(root, "lefthook.yml"))).toBe(false);
          expect(existsSync(resolve(root, scriptDir, scriptName))).toBe(false);
        },
      ),
    );
  });

  it("refuses linked script directories without writing outside the project", async () => {
    await Promise.all(
      [".lefthook", scriptDir].map(async (linked) => {
        const root = fixture();
        const outside = fixture();
        git(root, "init", "-q");
        const hook = resolve(root, ".git/hooks/pre-push");
        const custom = "#!/bin/sh\nexit 0\n";
        writeFileSync(hook, custom, { mode: 0o755 });
        if (linked === scriptDir) mkdirSync(resolve(root, ".lefthook"));
        symlinkSync(
          outside,
          resolve(root, linked),
          process.platform === "win32" ? "junction" : "dir",
        );

        expect(await scaffoldHook(root, "validate-kit", writer)).toBe(
          EXIT.CONFIG,
        );
        expect(readFileSync(hook, "utf8")).toBe(custom);
        expect(existsSync(`${hook}.old`)).toBe(false);
        expect(existsSync(resolve(root, "lefthook.yml"))).toBe(false);
        expect(existsSync(resolve(outside, scriptName))).toBe(false);
        expect(existsSync(resolve(outside, "pre-push"))).toBe(false);
      }),
    );
  });

  it("runs the old hook first with args and stdin and blocks an empty-inferred-file push", async () => {
    const root = fixture();
    git(root, "init", "--bare", "first.git");
    const remote = resolve(
      root,
      process.platform === "win32"
        ? "second remote's.git"
        : 'second remote\'s "quoted".git',
    );
    git(root, "init", "--bare", remote);
    const project = resolve(root, "project with space");
    mkdirSync(project);
    git(project, "init", "-q", "-b", "main");
    writeFileSync(resolve(project, "index.ts"), "export {};\n");
    git(project, "add", ".");
    git(project, "commit", "-qm", "fixture");
    git(project, "remote", "add", "origin", resolve(root, "first.git"));
    git(project, "push", "-qu", "origin", "main");
    git(project, "remote", "set-url", "origin", remote);

    const hook = resolve(project, ".git/hooks/pre-push");
    const oldBody =
      '#!/bin/sh\nprintf "old\\n" >> .git/order\nprintf "%s\\n" "$1" "$2" > .git/old-args\ncat > .git/old-stdin\nexit 0\n';
    writeFileSync(hook, oldBody, { mode: 0o755 });
    writeFileSync(
      resolve(project, "validate-kit"),
      '#!/bin/sh\nprintf "kit\\n" >> .git/order\nprintf "%s\\n" "$@" > .git/kit-args\nexit 19\n',
      { mode: 0o755 },
    );
    expect(
      await scaffoldHook(project, "./validate-kit", writer),
    ).toBeUndefined();
    expect(readFileSync(`${hook}.old`, "utf8")).toBe(oldBody);
    const configPath = resolve(project, "lefthook.yml");
    const current = readFileSync(configPath, "utf8");
    const installed = readFileSync(hook, "utf8");
    expect(
      await scaffoldHook(project, "./validate-kit", writer),
    ).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(current);
    expect(readFileSync(hook, "utf8")).toBe(installed);

    // Upgrade the earlier owned run-based config, preserving an installed
    // wrapper until its owner explicitly refreshes rc capture wiring.
    const previous = current
      .replace("rc: .lefthook/validate-kit-rc.sh\n", "")
      .replace(
        `      script: ${scriptName}\n      runner: sh\n      args:`,
        "      run:",
      )
      .replace(
        `      script: ${oldScriptName}\n      runner: sh\n      args: --`,
        `      run: '"$(git rev-parse --path-format=absolute --git-path hooks)/pre-push.old" "{1}" "{2}"'`,
      )
      .replace(
        "      use_stdin: true\n",
        `      use_stdin: true\n      only:\n        - run: 'test -x "$(git rev-parse --path-format=absolute --git-path hooks)/pre-push.old"'\n`,
      );
    const previousHook = installed
      .split("\n")
      .filter((line) => !line.includes("validate-kit-rc.sh"))
      .join("\n");
    writeFileSync(configPath, previous);
    writeFileSync(hook, previousHook);
    expect(await scaffoldHook(project, "./validate-kit", writer)).toBe(
      EXIT.CONFIG,
    );
    expect(readFileSync(hook, "utf8")).toBe(previousHook);
    expect(readFileSync(configPath, "utf8")).toBe(current);
    expect(
      (await run("lefthook", ["install", "pre-push"], { cwd: project }))
        .exitCode,
    ).toBe(0);
    expect(
      await scaffoldHook(project, "./validate-kit", writer),
    ).toBeUndefined();

    // Custom configs retain the same prerequisite and remain untouched.
    const customConfig = `${current}# Project-owned customization.\n`;
    writeFileSync(configPath, customConfig);
    writeFileSync(hook, previousHook);
    expect(await scaffoldHook(project, "./validate-kit", writer)).toBe(
      EXIT.CONFIG,
    );
    expect(readFileSync(configPath, "utf8")).toBe(customConfig);
    expect(readFileSync(hook, "utf8")).toBe(previousHook);
    expect(readFileSync(`${hook}.old`, "utf8")).toBe(oldBody);
    writeFileSync(hook, installed);
    expect(
      await scaffoldHook(project, "./validate-kit", writer),
    ).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(customConfig);
    expect(readFileSync(hook, "utf8")).toBe(installed);

    // A custom hooksPath must enforce capture too, without changing that
    // external folder or its project's customized configuration.
    const externalHooks = resolve(root, "custom hooks");
    mkdirSync(externalHooks);
    const externalPush = resolve(externalHooks, "pre-push");
    writeFileSync(
      resolve(externalHooks, "pre-commit"),
      readFileSync(resolve(project, ".git/hooks/pre-commit")),
      { mode: 0o755 },
    );
    writeFileSync(externalPush, previousHook, { mode: 0o755 });
    writeFileSync(`${externalPush}.old`, oldBody, { mode: 0o755 });
    git(project, "config", "--local", "core.hooksPath", externalHooks);
    expect(await scaffoldHook(project, "./validate-kit", writer)).toBe(
      EXIT.CONFIG,
    );
    expect(readFileSync(configPath, "utf8")).toBe(customConfig);
    expect(readFileSync(externalPush, "utf8")).toBe(previousHook);
    expect(readFileSync(`${externalPush}.old`, "utf8")).toBe(oldBody);
    writeFileSync(externalPush, installed);
    expect(
      await scaffoldHook(project, "./validate-kit", writer),
    ).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(customConfig);
    expect(readFileSync(externalPush, "utf8")).toBe(installed);
    git(project, "config", "--local", "--unset", "core.hooksPath");

    const pushed = await run("git", ["push", "origin", "main"], {
      cwd: project,
      timeoutMs: 15_000,
    });
    expect(pushed.spawnError).toBe(false);
    expect(pushed.exitCode).not.toBe(0);
    expect(readFileSync(resolve(project, ".git/order"), "utf8")).toBe(
      "old\nkit\n",
    );
    expect(readFileSync(resolve(project, ".git/old-args"), "utf8")).toBe(
      `origin\n${remote}\n`,
    );
    const sha = git(project, "rev-parse", "HEAD");
    expect(readFileSync(resolve(project, ".git/old-stdin"), "utf8")).toBe(
      `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    );
    expect(readFileSync(resolve(project, ".git/kit-args"), "utf8")).toBe(
      "check\n--profile\nci\n--quiet\n",
    );
    expect(git(project, "ls-remote", "origin", "refs/heads/main")).toBe("");

    writeFileSync(`${hook}.old`, oldBody.replace("exit 0", "exit 23"));
    const kitPath = resolve(project, "validate-kit");
    writeFileSync(
      kitPath,
      readFileSync(kitPath, "utf8").replace("exit 19", "exit 0"),
    );
    const blockedByOld = await run("git", ["push", "origin", "main"], {
      cwd: project,
      timeoutMs: 15_000,
    });
    expect(blockedByOld.exitCode).not.toBe(0);
    expect(readFileSync(resolve(project, ".git/order"), "utf8")).toBe(
      "old\nkit\nold\nkit\n",
    );
    expect(git(project, "ls-remote", "origin", "refs/heads/main")).toBe("");
  });
});
