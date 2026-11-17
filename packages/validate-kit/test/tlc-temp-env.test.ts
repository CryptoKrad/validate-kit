import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { tlc } from "../src/adapters/tlc.js";
import { resolveConfig } from "../src/config/resolve.js";
import { EXIT } from "../src/core/exit-codes.js";
import { execute } from "../src/core/runner.js";
import type { ToolAdapter } from "../src/core/types.js";

const owned: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of owned.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("the actual TLC runner keeps native JVM temporary files inside its removable scratch directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "vk-tlc owned-"));
  owned.push(root);
  const project = join(root, "project");
  const hostTemp = join(root, "host-temp");
  mkdirSync(project);
  mkdirSync(hostTemp);
  const receipt = join(root, "observed.json");
  const versionReceipt = join(root, "version.json");
  const launcher = join(root, "tlc.mjs");
  const success = [
    "@!@!@STARTMSG 2199:0 @!@!@",
    "2 states generated, 2 distinct states found, 0 states left on queue.",
    "@!@!@ENDMSG 2199 @!@!@",
    "",
  ].join("\n");
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";import path from "node:path";',
      'const perf=()=>{const directory=path.join(process.env.TEMP,"hsperfdata_fixture");fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,"owned"),"perf");};',
      `if(process.argv.includes("-h")){fs.writeFileSync(${JSON.stringify(versionReceipt)},JSON.stringify({javaOptions:process.env.JAVA_TOOL_OPTIONS}));if(!process.env.JAVA_TOOL_OPTIONS?.includes("-XX:-UsePerfData"))perf();console.log("TLC - Version 2.19");process.exit(0);}`,
      "perf();",
      `fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({temp:process.env.TEMP,tmp:process.env.TMP,tmpdir:process.env.TMPDIR,javaOptions:process.env.JAVA_TOOL_OPTIONS,args:process.argv.slice(2)}));`,
      `process.stdout.write(${JSON.stringify(success)});`,
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  const spec = join(project, "Model.tla");
  const model = join(project, "Model.cfg");
  writeFileSync(spec, "---- MODULE Model ----\nSafe == TRUE\n====\n");
  writeFileSync(model, "INVARIANT Safe\n");
  const { config } = await resolveConfig(project);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, hostTemp);
  vi.stubEnv("JAVA_TOOL_OPTIONS", "-Xmx64m");
  const instrumented: ToolAdapter = {
    ...tlc,
    bin: process.execPath,
    versionArgs: [launcher, "-h"],
    buildArgs: (ctx) => {
      const command = tlc.buildArgs(ctx);
      return {
        ...command,
        bin: process.execPath,
        args: [launcher, ...command.args],
      };
    },
  };
  const summary = await execute({
    projectRoot: project,
    config,
    tasks: [
      {
        adapter: instrumented,
        cwd: project,
        toolConfig: {},
        options: {
          model: { spec, config: model, expect: "holds" },
          workers: "1",
        },
      },
    ],
    fix: false,
    scope: { profile: "test", mode: "full", files: null },
  });
  expect(summary.exitCode, JSON.stringify(summary)).toBe(EXIT.CLEAN);
  const observed = JSON.parse(readFileSync(receipt, "utf8")) as {
    temp: string;
    tmp: string;
    tmpdir: string;
    javaOptions: string;
    args: string[];
  };
  const versionObserved = JSON.parse(readFileSync(versionReceipt, "utf8")) as {
    javaOptions: string;
  };
  expect(summary.ranTools).toEqual(["tlc"]);
  expect(observed.args).toContain("-metadir");
  expect(observed.temp).not.toBe(hostTemp);
  expect(observed.tmp).toBe(observed.temp);
  expect(observed.tmpdir).toBe(observed.temp);
  expect(observed.javaOptions).toContain("-Xmx64m");
  expect(observed.javaOptions).not.toContain("-XX:-UsePerfData");
  expect(versionObserved.javaOptions).toContain("-Xmx64m");
  expect(versionObserved.javaOptions).toContain("-XX:-UsePerfData");
  expect(
    observed.javaOptions.endsWith(`"-Djava.io.tmpdir=${observed.temp}"`),
  ).toBe(true);
  const inside = relative(realpathSync(hostTemp), observed.temp);
  expect(isAbsolute(inside)).toBe(false);
  expect(inside.startsWith("..")).toBe(false);
  expect(existsSync(observed.temp)).toBe(false);
  expect(readdirSync(hostTemp)).toEqual([]);
});
