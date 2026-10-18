import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cooldown } from "../src/adapters/cooldown.js";
import {
  durationMinutes,
  gained,
  LOOKUP,
  lockedPackages,
} from "../src/adapters/lockfile-age.js";
import type { PlanEnv } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

/** A git repository with a committed pnpm lockfile, and its own commit. */
function repo(lock: string): {
  root: string;
  git: (...args: string[]) => string;
} {
  const root = tmp("vk-lockage-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git };
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/** An added npm package in pnpm-lock.yaml, with a day's cooldown. */
function pkg(name: string, version: string) {
  return {
    registry: "npm",
    name,
    version,
    lockfile: "pnpm-lock.yaml",
    minutes: 1440,
  };
}

/** The lookup script against `registry`, for npm `names` at 1.0.0. */
function lookup(registry: string, names: string[]) {
  return promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      LOOKUP,
      JSON.stringify(
        names.map((name) => ({ registry: "npm", name, version: "1.0.0" })),
      ),
    ],
    { env: { ...process.env, VK_NPM_REGISTRY: registry } },
  );
}

function tmp(prefix: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), prefix)));
}

const PNPM = (extra = "") => `lockfileVersion: '9.0'

importers:
  .: {}

packages:

  is-odd@3.0.1:
    resolution: {integrity: sha512-x}
${extra}
snapshots:

  is-odd@3.0.1: {}
`;

describe("lockfile ages", () => {
  it("names the registry packages each lockfile pins", () => {
    expect(
      lockedPackages(
        "pnpm-lock.yaml",
        PNPM(
          "\n  '@types/node@22.20.5':\n    resolution: {integrity: sha512-y}\n\n  local@file:../x:\n    resolution: {directory: ../x}\n",
        ),
      ),
    ).toEqual([
      { registry: "npm", name: "is-odd", version: "3.0.1" },
      { registry: "npm", name: "@types/node", version: "22.20.5" },
    ]);
    expect(
      lockedPackages(
        "package-lock.json",
        JSON.stringify({
          packages: {
            "": { name: "app" },
            "node_modules/@scope/a": {
              version: "1.2.3",
              resolved: "https://registry.npmjs.org/@scope/a/-/a-1.2.3.tgz",
            },
            "node_modules/b/node_modules/c": {
              version: "0.1.0",
              resolved: "https://registry.npmjs.org/c/-/c-0.1.0.tgz",
            },
            "node_modules/linked": { version: "1.0.0", resolved: "../linked" },
          },
        }),
      ),
    ).toEqual([
      { registry: "npm", name: "@scope/a", version: "1.2.3" },
      { registry: "npm", name: "c", version: "0.1.0" },
    ]);
    expect(
      lockedPackages(
        "uv.lock",
        'version = 1\n\n[[package]]\nname = "idna"\nversion = "3.10"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n',
      ),
    ).toEqual([{ registry: "pypi", name: "idna", version: "3.10" }]);
    expect(lockedPackages("pnpm-lock.yaml", ": not yaml : [")).toEqual([]);
  });

  it("reads a cooldown's duration as minutes", () => {
    expect(durationMinutes("7 days")).toBe(10_080);
    expect(durationMinutes("24 hours")).toBe(1440);
    expect(durationMinutes("P7D")).toBe(10_080);
    expect(durationMinutes("PT36H")).toBe(2160);
    expect(durationMinutes("2026-10-01T00:00:00Z")).toBeUndefined();
  });

  it("finds what a lockfile gained since HEAD, or the index in a staged run", () => {
    const root = tmp("vk-lockage-");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(root, "pnpm-lock.yaml"), PNPM());
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    expect(gained(root, "pnpm-lock.yaml", false)).toEqual([]);
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      PNPM("\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-z}\n"),
    );
    const leftPad = { registry: "npm", name: "left-pad", version: "1.3.0" };
    expect(gained(root, "pnpm-lock.yaml", false)).toEqual([leftPad]);
    // Not staged yet: the commit would add nothing.
    expect(gained(root, "pnpm-lock.yaml", true)).toEqual([]);
    git("add", "pnpm-lock.yaml");
    expect(gained(root, "pnpm-lock.yaml", true)).toEqual([leftPad]);
  });

  it("reports a package published inside its cooldown, and says when a date could not be had", () => {
    const root = tmp("vk-lockage-");
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      PNPM("\n  typescript@7.1.0-dev.20261014.1:\n    resolution: {}\n"),
    );
    const fresh = [
      pkg("typescript", "7.1.0-dev.20261014.1"),
      pkg("is-odd", "3.0.1"),
      pkg("gone", "1.0.0"),
    ];
    // What the lookup prints (its shape, recorded against the registry).
    const stdout = JSON.stringify([
      { ...fresh[0], published: hoursAgo(1) },
      { ...fresh[1], published: hoursAgo(24 * 365) },
      { ...fresh[2], error: "HTTP 404" },
    ]);
    const result = cooldown.parseOutput(
      { stdout, stderr: "", exitCode: 0 },
      {
        cwd: root,
        fix: false,
        extraArgs: [],
        options: { lockfiles: [], fresh },
      },
    );
    expect(
      result.findings.map((f) => [
        f.file.slice(root.length + 1),
        f.line,
        f.ruleId,
        f.severity,
      ]),
    ).toEqual([
      ["pnpm-lock.yaml", 11, "young-package", "warning"],
      ["pnpm-lock.yaml", 1, "publish-date-unknown", "info"],
    ]);
    expect(result.findings[0]?.message).toMatch(
      /^typescript@7.1.0-dev.20261014.1 was published 1 h ago, inside the 24 h cooldown/,
    );
    expect(
      cooldown
        .buildArgs({
          cwd: root,
          fix: false,
          extraArgs: [],
          options: { lockfiles: [], fresh },
        })
        .args.slice(0, 2),
    ).toEqual(["--input-type=module", "-e"]);
  });

  it("reads a real name from an npm alias, and skips a pnpm tarball", () => {
    expect(
      lockedPackages(
        "package-lock.json",
        JSON.stringify({
          packages: {
            "node_modules/string-width-cjs": {
              name: "string-width",
              version: "4.2.3",
              resolved:
                "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",
            },
          },
        }),
      ),
    ).toEqual([{ registry: "npm", name: "string-width", version: "4.2.3" }]);
    expect(
      lockedPackages(
        "pnpm-lock.yaml",
        PNPM("\n  tar@1.0.0:\n    resolution: {tarball: https://x/tar.tgz}\n"),
      ).map((p) => p.name),
    ).toEqual(["is-odd"]);
  });

  it("judges commits not yet on the remote's branch when nothing is tracked", () => {
    const { root, git } = repo(PNPM());
    // A pre-push worktree: detached, tracking nothing, the remote's branch known.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      PNPM("\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-z}\n"),
    );
    git("commit", "-qam", "add left-pad");
    git("checkout", "-q", "--detach");
    expect(gained(root, "pnpm-lock.yaml", false)).toEqual([
      { registry: "npm", name: "left-pad", version: "1.3.0" },
    ]);
  });

  it("asks the registry with one deadline, by its clock, and stops once it is unreachable", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          time: { "1.0.0": "2026-10-14T00:00:00.000Z" },
          url: req.url,
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const ok = JSON.parse(
      (await lookup(`http://127.0.0.1:${port}`, ["@corp/a"])).stdout,
    ) as {
      published?: string;
      now?: string;
    }[];
    expect(ok[0]?.published).toBe("2026-10-14T00:00:00.000Z");
    expect(ok[0]?.now).toMatch(/GMT$/);
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
    const started = Date.now();
    const down = JSON.parse(
      (
        await lookup(`http://127.0.0.1:${port}`, [
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
        ])
      ).stdout,
    ) as { error?: string }[];
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(down.at(-1)?.error).toMatch(/^not looked up: /);
  });

  it("leaves out what the project exempted or another registry serves, caps the lookup and places each pin", async () => {
    const { root, git } = repo(PNPM());
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "minimumReleaseAge: 120\nminimumReleaseAgeExclude:\n  - '@typescript/*'\n",
    );
    writeFileSync(
      join(root, ".npmrc"),
      "@corp:registry=https://npm.corp.example/\n",
    );
    const extra = [
      "\n  '@typescript/native@7.0.0':\n    resolution: {integrity: sha512-a}\n",
      "\n  '@corp/billing@1.0.0':\n    resolution: {integrity: sha512-b}\n",
      "\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-c}\n",
      ...Array.from(
        { length: 101 },
        (_, i) =>
          `\n  p${String(i).padStart(3, "0")}@1.0.0:\n    resolution: {}\n`,
      ),
    ].join("");
    writeFileSync(join(root, "pnpm-lock.yaml"), PNPM(extra));
    const env = {
      projectRoot: root,
      scopedFiles: [],
      config: { ignore: [] },
    } as unknown as PlanEnv;
    const [task] = (await cooldown.expand?.({ cwd: root }, env)) ?? [];
    const options = task?.options as {
      fresh: { name: string; minutes: number }[];
      dropped: Record<string, number>;
    };
    expect(options.fresh.map((p) => p.name).slice(0, 2)).toEqual([
      "left-pad",
      "p000",
    ]);
    expect(options.fresh).toHaveLength(100);
    expect(options.fresh[0]?.minutes).toBe(120);
    expect(options.dropped).toEqual({ "pnpm-lock.yaml": 2 });
    const stdout = JSON.stringify(
      options.fresh.slice(0, 1).map((p) =>
        Object.assign({}, p, {
          published: new Date().toUTCString(),
          now: new Date().toUTCString(),
        }),
      ),
    );
    const result = cooldown.parseOutput(
      { stdout, stderr: "", exitCode: 0 },
      {
        cwd: root,
        fix: false,
        extraArgs: [],
        options: { ...options, fresh: options.fresh.slice(0, 1) },
      },
    );
    expect(
      result.findings
        .filter((f) => f.ruleId !== "pnpm-trust-policy")
        .map((f) => [f.ruleId, f.line, f.message.slice(0, 40)]),
    ).toEqual([
      ["young-package", 17, "left-pad@1.3.0 was published 0 h ago, in"],
      ["publish-date-unknown", 1, "2 more new package(s) were not looked up"],
    ]);
  });
});
