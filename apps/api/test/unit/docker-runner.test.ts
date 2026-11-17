import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../../scripts/run-docker-integration.mjs", import.meta.url),
);
type NativeRun = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => {
  status: number | null;
  error?: Error;
  signal?: string;
};
const { runApiDockerIntegration } = (await import(
  pathToFileURL(runnerPath).href
)) as {
  runApiDockerIntegration: (options?: {
    run?: NativeRun;
    vitest?: () => string;
  }) => number;
};

it("fails the mandatory Docker gate before resolving or running Vitest", () => {
  const run = vi.fn<NativeRun>(() => ({ status: 1 }));
  const vitest = vi.fn<() => string>(() => {
    throw new Error("Docker failure must stop dispatch");
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(runApiDockerIntegration({ run, vitest })).toBe(1);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]).toEqual([
      "docker",
      ["info"],
      expect.objectContaining({ shell: false, timeout: 30_000 }),
    ]);
    expect(vitest).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Docker is required for Testcontainers integration replay",
    );
  } finally {
    error.mockRestore();
  }
});

it("launches the actual installed Vitest entry with the same integration scope and propagates failure", () => {
  const run = vi
    .fn<NativeRun>()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ status: 7 });
  expect(runApiDockerIntegration({ run })).toBe(7);
  const call = run.mock.calls[1];
  expect(call).toBeDefined();
  if (!call) throw new Error("The integration runner must dispatch Vitest");
  const [node, args, options] = call;
  expect(node).toBe(process.execPath);
  expect(args).toEqual([
    expect.any(String),
    "run",
    "--config",
    "vitest.integration.config.ts",
    "--reporter",
    "verbose",
  ]);
  const entry = args[0];
  if (!entry) throw new Error("Vitest must have a native CLI entry");
  expect(existsSync(entry)).toBe(true);
  expect(options.cwd).toMatch(/apps[\\/]api[\\/]?$/);
  expect(options).toEqual(
    expect.objectContaining({
      stdio: "inherit",
      shell: false,
      timeout: 180_000,
    }),
  );
});

it("fails closed when the owned integration process terminates without a status", () => {
  const run = vi
    .fn<NativeRun>()
    .mockReturnValueOnce({ status: 0 })
    .mockReturnValueOnce({ status: null, signal: "SIGTERM" });
  expect(
    runApiDockerIntegration({ run, vitest: () => "fixture-vitest.mjs" }),
  ).toBe(1);
});
