import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAvailability } from "../src/adapters/base.js";
import { tflint } from "../src/adapters/tflint.js";
import { resolveConfig } from "../src/config/resolve.js";
import { buildPlan } from "../src/core/plan.js";
import type {
  PlanEnv,
  RawOutput,
  TaskSeed,
  ToolAdapter,
  ToolContext,
} from "../src/core/types.js";
import { detectFromFiles, toPosix } from "../src/detect/languages.js";

// Every output below was captured from a real run of tflint 0.64.0 on
// 2026-10-18 (the aws one with tflint-ruleset-aws 0.49.0 installed) on the
// fixtures in docs/research/lint-toolchain/assets/sota-2026-10-18/tflint/
// (docs/research/lint-toolchain/sota-2026-10-18/tflint.md).

const FINDING_AND_NOTICE =
  '{"issues":[{"rule":{"name":"terraform_documented_variables","severity":"info","link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_documented_variables.md"},"message":"`unused` variable has no description","range":{"filename":"main.tf","start":{"line":5,"column":1},"end":{"line":5,"column":18}},"callers":[],"fixable":false,"fixed":false},{"rule":{"name":"terraform_unused_declarations","severity":"warning","link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_unused_declarations.md"},"message":"variable \\"unused\\" is declared but not used","range":{"filename":"main.tf","start":{"line":5,"column":1},"end":{"line":5,"column":18}},"callers":[],"fixable":true,"fixed":false}],"errors":[]}';
const AWS_ERROR_THROUGH_MODULE =
  '{"issues":[{"rule":{"name":"aws_instance_invalid_type","severity":"error","link":""},"message":"\\"t9.nano\\" is an invalid value as instance_type","range":{"filename":"infra/main.tf","start":{"line":18,"column":12},"end":{"line":18,"column":21}},"callers":[{"filename":"infra/main.tf","start":{"line":18,"column":12},"end":{"line":18,"column":21}},{"filename":"infra/child/main.tf","start":{"line":17,"column":19},"end":{"line":17,"column":27}}],"fixable":false,"fixed":false}],"errors":[]}';
const CLEAN = '{"issues":[],"errors":[]}';
const MISSING_FILE =
  '{"issues":[{"rule":{"name":"terraform_standard_module_structure","severity":"warning","link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_standard_module_structure.md"},"message":"Module should include an empty outputs.tf file","range":{"filename":"outputs.tf","start":{"line":1,"column":1},"end":{"line":0,"column":0}},"callers":[],"fixable":false,"fixed":false}],"errors":[]}';
const PLUGIN_MISSING =
  '{"issues":[],"errors":[{"message":"Failed to initialize plugins; Plugin \\"aws\\" not found. Did you run \\"tflint --init\\"?","severity":"error"}]}';
const SYNTAX =
  '{"issues":[],"errors":[{"summary":"Unclosed configuration block","message":"There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.","severity":"error","range":{"filename":"main.tf","start":{"line":1,"column":11},"end":{"line":1,"column":12}}}]}';
const REMOTE_MODULE =
  '{"issues":[],"errors":[{"summary":"\\"remote\\" module is not found. Did you run \\"terraform init\\"?","message":"","severity":"error","range":{"filename":"main.tf","start":{"line":10,"column":1},"end":{"line":10,"column":16}}}]}';

function tmp(): string {
  return toPosix(mkdtempSync(join(tmpdir(), "vk-tflint-")));
}

function put(root: string, files: Record<string, string>): string[] {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return Object.keys(files)
    .map((path) => `${root}/${path}`)
    .toSorted();
}

const ctx = (cwd: string, options?: unknown): ToolContext => ({
  cwd,
  fix: false,
  extraArgs: [],
  ...(options ? { options } : {}),
});

const ran = (exitCode: number, stdout: string): RawOutput => ({
  stdout,
  stderr: "",
  exitCode,
});

function env(root: string, scopedFiles: string[], more: Partial<PlanEnv> = {}) {
  return {
    projectRoot: root,
    scopedFiles,
    toolConfig: {},
    config: { ignore: [], tools: {} },
    ...more,
  } as unknown as PlanEnv;
}

const expand = (seed: TaskSeed, e: PlanEnv) =>
  tflint.expand?.(seed, e) as TaskSeed[];

const PLUGIN_DIR = 'config {\n  plugin_dir = "./plugins"\n}\n';
const AWS =
  'plugin "aws" {\n  enabled = false # still looked for\n  version = "0.49.0"\n  source  = "github.com/terraform-linters/tflint-ruleset-aws"\n}\n';

// No config, plugin folder or HOME of this machine reaches a test.
let fakeHome = "";
beforeEach(() => {
  fakeHome = tmp();
  // Node reads HOME on POSIX and USERPROFILE on Windows: stub both, so
  // homedir() never reaches the real user's .tflint.hcl.
  vi.stubEnv("HOME", fakeHome);
  vi.stubEnv("USERPROFILE", fakeHome);
  vi.stubEnv("TFLINT_CONFIG_FILE", "");
  vi.stubEnv("TFLINT_PLUGIN_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tflint", () => {
  it("parses one finding per issue, 1-based, as error, warning or info, at the path from where it started", () => {
    const root = tmp();
    expect(
      tflint.parseOutput(ran(2, FINDING_AND_NOTICE), ctx(root)).findings,
    ).toEqual([
      expect.objectContaining({
        file: `${root}/main.tf`,
        line: 5,
        col: 1,
        endLine: 5,
        endCol: 18,
        ruleId: "terraform_documented_variables",
        severity: "info",
        language: "terraform",
      }),
      expect.objectContaining({
        ruleId: "terraform_unused_declarations",
        severity: "warning",
        message: 'variable "unused" is declared but not used',
        url: "https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_unused_declarations.md",
        fixable: false,
      }),
    ]);
    // Through a module call, at the root's call site; the aws rule has no link.
    const [error] = tflint.parseOutput(
      ran(2, AWS_ERROR_THROUGH_MODULE),
      ctx(root),
    ).findings;
    expect(error).toMatchObject({
      file: `${root}/infra/main.tf`,
      line: 18,
      col: 12,
      severity: "error",
      ruleId: "aws_instance_invalid_type",
    });
    expect(error).not.toHaveProperty("url");
    expect(tflint.parseOutput(ran(0, CLEAN), ctx(root)).findings).toEqual([]);
  });

  it("maps a path printed through the module's real folder to the kit's spelling", () => {
    const real = tmp();
    mkdirSync(join(real, "mod"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    // tflint: relative to where it started, to the folder's real path.
    const printed = posix.relative(
      link,
      `${toPosix(realpathSync(real))}/mod/main.tf`,
    );
    const stdout = FINDING_AND_NOTICE.replaceAll(
      '"filename":"main.tf"',
      `"filename":${JSON.stringify(printed)}`,
    );
    const files = tflint
      .parseOutput(ran(2, stdout), ctx(link))
      .findings.map((f) => f.file);
    expect(files).toEqual([`${link}/mod/main.tf`, `${link}/mod/main.tf`]);
  });

  it("is a crash naming the error when it could not lint, and when its output is not what was recorded", () => {
    const root = tmp();
    const read = (exit: number, stdout: string) => () =>
      tflint.parseOutput(ran(exit, stdout), ctx(root));
    expect(read(1, PLUGIN_MISSING)).toThrow(
      /could not lint: Failed to initialize plugins; Plugin "aws" not found/,
    );
    expect(read(1, SYNTAX)).toThrow(
      /main\.tf:1:11: Unclosed configuration block: There is no closing brace/,
    );
    expect(read(1, REMOTE_MODULE)).toThrow(
      /main\.tf:10:1: "remote" module is not found/,
    );
    expect(read(2, CLEAN)).toThrow(/exited 2 and reported nothing/);
    expect(read(1, "")).toThrow(/no JSON output on exit code 1/);
    expect(read(2, '{"issues":null,"errors":[]}')).toThrow(
      /format may have changed/,
    );
    expect(
      read(
        2,
        FINDING_AND_NOTICE.replace('"severity":"info"', '"severity":"notice"'),
      ),
    ).toThrow(/known severity \("notice"\)/);
  });

  it("omits the end tflint gives a file it says is missing (0:0)", () => {
    const root = tmp();
    const [missing] = tflint.parseOutput(
      ran(2, MISSING_FILE),
      ctx(root),
    ).findings;
    expect(missing).toMatchObject({ file: `${root}/outputs.tf`, line: 1 });
    expect(missing).not.toHaveProperty("endLine");
  });

  it("plans one task per module folder a change reaches: its files, a config above it, a local module it calls", () => {
    const root = tmp();
    const scoped = put(root, {
      ".tflint.hcl": "",
      "infra/a/main.tf": "",
      "infra/b/main.tf": "",
      "infra/b/terraform.tfvars": "",
      "infra/b/use.tf.json": "{}",
      "infra/c/main.tofu": "",
      "json/main.tf.json": '{"module":{"live":{"source":"../live"}}}',
      "live/main.tf": 'module "a" {\n  source = "../infra/a/"\n}\n',
    }).filter((f) => !f.endsWith(".hcl"));
    const seed = { cwd: root };
    // The root config is not passed: tflint reads only the module's own.
    expect(expand(seed, env(root, scoped))[1]).toEqual({
      cwd: root,
      files: [
        `${root}/infra/b/main.tf`,
        `${root}/infra/b/terraform.tfvars`,
        `${root}/infra/b/use.tf.json`,
      ],
      options: { module: "infra/b" },
    });
    const modules = (changedPaths: string[]) =>
      expand(seed, env(root, scoped, { changedPaths })).map(
        (t) => (t.options as { module: string }).module,
      );
    expect(modules([])).toEqual([]);
    expect(modules(["infra/b/use.tf.json"])).toEqual(["infra/b"]);
    // A deleted file: its folder, and the modules that call it, transitively.
    expect(modules(["infra/a/gone.tf"])).toEqual(["infra/a", "json", "live"]);
    expect(modules(["infra/c/main.tofu"])).toEqual([]);
    expect(modules([".tflint.hcl"])).toEqual([
      "infra/a",
      "infra/b",
      "json",
      "live",
    ]);
  });

  it("a changed config plans tflint in a changed-file run", async () => {
    const root = tmp();
    const files = put(root, { ".tflint.hcl": "", "main.tf": "" }).filter((f) =>
      f.endsWith(".tf"),
    );
    const { config } = await resolveConfig(root);
    const plan = (changedPaths: string[]) =>
      buildPlan(detectFromFiles(root, files), config, root, [tflint], {
        scopedFiles: files,
        changedFiles: [],
        changedPaths,
      });
    expect(await plan(["README.md"])).toEqual([]);
    expect((await plan([".tflint.hcl"])).map((t) => t.options)).toEqual([
      { module: ".", config: `${root}/.tflint.hcl` },
    ]);
  });

  it("reads the config tflint itself would: the module's own, a parent one a step passes, else its fallback", () => {
    const root = tmp();
    const scoped = put(root, {
      ".tflint.hcl": "",
      "own/.tflint.json": "{}",
      "own/main.tf": "",
      "sub/main.tf": "",
    }).filter((f) => f.endsWith(".tf"));
    const tasks = () => expand({ cwd: root }, env(root, scoped));
    expect(tasks().map((t) => t.options)).toEqual([
      { module: "own", config: `${root}/own/.tflint.json` },
      { module: "sub" },
    ]);
    // With none passed, tflint reads ~/.tflint.hcl: its plugins count too.
    const home = toPosix(fakeHome);
    put(home, { ".tflint.hcl": AWS });
    expect(tasks()[1]?.cannotRun).toMatch(
      new RegExp(
        `^${home}/\\.tflint\\.hcl: plugin "aws" .* run \`tflint --init\``,
      ),
    );
    put(root, {
      Makefile: 'lint:\n\ttflint --recursive --config "$(pwd)/.tflint.hcl"\n',
    });
    expect(tasks().map((t) => t.options)).toEqual([
      { module: "own", config: `${root}/own/.tflint.json` },
      { module: "sub", config: `${root}/.tflint.hcl` },
    ]);
  });

  it("runs only where the project chose it: a config, tools.tflint.enabled or .configPath, or a step", () => {
    const root = tmp();
    const scoped = put(root, { "main.tf": "" });
    const seed = { cwd: root };
    expect(expand(seed, env(root, scoped))).toEqual([]);
    const enabled = env(root, scoped, { toolConfig: { enabled: true } });
    expect(expand(seed, enabled)).toEqual([
      { cwd: root, files: scoped, options: { module: "." } },
    ]);
    const named = env(root, scoped, {
      toolConfig: { configPath: `${root}/lint/tflint.hcl` },
    });
    expect(expand(seed, named)[0]?.options).toEqual({
      module: ".",
      config: `${root}/lint/tflint.hcl`,
    });
    put(root, { Makefile: "lint:\n\ttflint --recursive\n" });
    expect(expand(seed, env(root, scoped))).toHaveLength(1);
  });

  it("cannot run a module whose config names a plugin that is not installed, and says to run tflint --init", () => {
    const root = tmp();
    const scoped = put(root, { "main.tf": "" });
    const seed = { cwd: root };
    const cannotRun = (config: string, name = ".tflint.hcl") => {
      put(root, { [name]: config });
      return expand(seed, env(root, scoped))[0]?.cannotRun;
    };
    expect(cannotRun(`${PLUGIN_DIR}// the bundled one\n${AWS}`)).toMatch(
      /^\.tflint\.hcl: plugin "aws" \(github\.com\/terraform-linters\/tflint-ruleset-aws 0\.49\.0\) is not installed in .*\/plugins: run `tflint --init`/,
    );
    put(root, {
      "plugins/github.com/terraform-linters/tflint-ruleset-aws/0.49.0/tflint-ruleset-aws":
        "",
    });
    // Labels as identifiers or with no space: tflint takes both.
    const terraformOff = 'plugin "terraform" {\n  enabled = false\n}\n';
    const aws = (version: string, head = "plugin aws {") =>
      `${PLUGIN_DIR}${terraformOff}${head}\n  enabled = true\n  version = "${version}"\n  source  = "github.com/terraform-linters/tflint-ruleset-aws"\n}\n`;
    expect(cannotRun(aws("0.49.0"))).toBeUndefined();
    expect(cannotRun(aws("0.49.0", 'plugin"aws"{'))).toBeUndefined();
    expect(cannotRun(aws("0.48.0"))).toMatch(/plugin "aws" .*0\.48\.0/);
    // A block it cannot read whole is left to tflint, whose error is the crash.
    expect(cannotRun(aws("0.48.0", 'plugin "aws" "x" {'))).toBeUndefined();
    expect(
      cannotRun(
        aws("0.48.0").replace(
          "enabled = true",
          'enabled = true\n  x = [\n    "a",\n  ]',
        ),
      ),
    ).toBeUndefined();
    // A one-line block without source or version: installed by hand.
    expect(
      cannotRun(
        `${PLUGIN_DIR}/* hand-built */ plugin "foo" { enabled = true }\n`,
      ),
    ).toMatch(
      /plugin "foo" is not installed: tflint looks for .*\/plugins\/tflint-ruleset-foo$/,
    );
    // The module's own .tflint.d/plugins, when nothing names another.
    put(root, { ".tflint.d/plugins/tflint-ruleset-foo": "" });
    expect(cannotRun('plugin "foo" { enabled = true }\n')).toBeUndefined();
    // deep_check calls the cloud's API.
    expect(
      cannotRun(
        aws("0.49.0").replace(
          "enabled = true",
          "enabled = true\n  deep_check = true",
        ),
      ),
    ).toMatch(/plugin "aws" sets deep_check = true/);
  });

  it("reads a .tflint.json's plugins in each shape tflint takes, and leaves the rest to tflint", () => {
    const root = tmp();
    const scoped = put(root, { "main.tf": "" });
    const cannotRun = (config: object) => {
      put(root, { ".tflint.json": JSON.stringify(config) });
      return expand({ cwd: root }, env(root, scoped))[0]?.cannotRun;
    };
    const google = {
      enabled: true,
      version: "0.40.0",
      source: "github.com/terraform-linters/tflint-ruleset-google",
    };
    const config = { plugin_dir: "./plugins" };
    expect(cannotRun({ config, plugin: { google } })).toMatch(
      /^\.tflint\.json: plugin "google" .* run `tflint --init`/,
    );
    expect(
      cannotRun({ config: [config], plugin: [{ google: [google] }] }),
    ).toMatch(/plugin "google"/);
    // tflint refuses a "//" among the plugins: its error, not a skip.
    expect(
      cannotRun({ config, plugin: { "//": "x", google } }),
    ).toBeUndefined();
    put(root, {
      "plugins/github.com/terraform-linters/tflint-ruleset-google/0.40.0/tflint-ruleset-google":
        "",
    });
    expect(
      cannotRun({ config: [config], plugin: { google: [google] } }),
    ).toBeUndefined();
  });

  it("passes the module, JSON and the config, and refuses flags that change what it reads or writes", () => {
    const built = tflint.buildArgs(
      ctx("/p", { module: "infra", config: "/p/.tflint.hcl" }),
    );
    expect(built.args).toEqual([
      "--chdir=infra",
      "--format",
      "json",
      "--config=/p/.tflint.hcl",
    ]);
    expect(built.okExitCodes).toEqual([0, 1, 2]);
    for (const arg of [
      "--format=compact",
      "-fcompact",
      "--fix",
      "--init",
      "--recursive",
      "--filter=main.tf",
    ])
      expect(tflint.refuseArgs?.([arg])).toBeDefined();
    expect(tflint.refuseArgs?.(["--call-module-type=all"])).toBeUndefined();
  });
});

describe("checkAvailability", () => {
  it("runs the version command with the adapter's versionEnv", async () => {
    const adapter = {
      ...tflint,
      bin: process.execPath,
      versionArgs: ["-e", "console.log(process.env.VK_PROBE ?? 'none')"],
      versionEnv: { VK_PROBE: "9.8.7" },
      parseVersion: undefined,
    } as unknown as ToolAdapter;
    expect((await checkAvailability(adapter, tmp())).version).toBe("9.8.7");
  });
});
