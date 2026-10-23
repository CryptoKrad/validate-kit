import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lean } from "../src/adapters/lean.js";
import type { RawOutput, ToolContext } from "../src/core/types.js";
import { toPosix } from "../src/detect/languages.js";

// A Lake project's build as Lake prints it on Windows (Git for Windows,
// elan): the recorded lake-5.0.0 build-verbose-cached.out, with the paths in
// the host's separators (docs/research/formal-adapters/assets/lake-5.0.0/).
const WINDOWS_LOG = [
  "✔ [0/4] Ran job computation",
  "⚠ [2/4] Replayed Demo.Basic",
  "trace: .> LEAN_PATH=C:\\work\\demo\\.lake\\build\\lib\\lean C:\\Users\\me\\.elan\\toolchains\\leanprover--lean4---v4.34.1\\bin\\lean.exe C:\\work\\demo\\Demo\\Basic.lean -o C:\\work\\demo\\.lake\\build\\lib\\lean\\Demo\\Basic.olean -i C:\\work\\demo\\.lake\\build\\lib\\lean\\Demo\\Basic.ilean --json",
  "ℹ [3/4] Replayed Demo",
  "trace: .> LEAN_PATH=C:\\work\\demo\\.lake\\build\\lib\\lean C:\\Users\\me\\.elan\\toolchains\\leanprover--lean4---v4.34.1\\bin\\lean.exe C:\\work\\demo\\Demo.lean -o C:\\work\\demo\\.lake\\build\\lib\\lean\\Demo.olean -i C:\\work\\demo\\.lake\\build\\lib\\lean\\Demo.ilean --json",
  "✔ [4/4] Ran demo/Demo:default",
  "Build completed successfully (4 jobs).",
  "",
].join("\n");

describe("lean on Windows paths", () => {
  it("reads a backslash trace as built, and audits each module at its POSIX path", () => {
    const root = toPosix(mkdtempSync(join(tmpdir(), "vk-lean-win-")));
    // traced() vouches for a module only when its .olean is there.
    mkdirSync(join(root, ".lake/build/lib/lean/Demo"), { recursive: true });
    mkdirSync(join(root, "Demo"));
    writeFileSync(join(root, ".lake/build/lib/lean/Demo/Basic.olean"), "");
    writeFileSync(join(root, ".lake/build/lib/lean/Demo.olean"), "");
    writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
    writeFileSync(
      join(root, "Demo/Basic.lean"),
      "def hello := 1\ndef later := 2\n",
    );
    writeFileSync(join(root, "Demo.lean"), "import Demo.Basic\n");
    writeFileSync(join(root, "lakefile.toml"), 'name = "demo"\n');
    const raw: RawOutput = {
      stdout: WINDOWS_LOG,
      // The build status, then the audit: one declaration on sorryAx.
      stderr:
        '0\n{"decl":"Demo.later","module":"Demo.Basic","line":2,"axioms":["sorryAx"]}\n{"audited":2,"modules":2}\n',
      exitCode: 0,
    };
    const ctx = {
      cwd: root,
      fix: false,
      extraArgs: [],
      options: {
        kind: "lake",
        root,
        lakefile: `${root}/lakefile.toml`,
        files: [`${root}/Demo/Basic.lean`, `${root}/Demo.lean`],
        allowAxioms: [],
      },
    } as unknown as ToolContext;
    const { findings } = lean.parseOutput(raw, ctx);
    expect(findings.map((f) => [f.ruleId, f.file, f.line])).toEqual([
      ["lean/axioms", `${root}/Demo/Basic.lean`, 2],
    ]);
  });
});
