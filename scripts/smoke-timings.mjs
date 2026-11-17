// Where the time of the package smoke goes, for SMOKE_TIMINGS=1: seconds per
// program and the twelve slowest commands, so that a change to the smoke is
// aimed at what it waits for (measure the stages apart: Vincent Koc, "Making
// OpenClaw CI faster and 95% cheaper", 2026-11-17).

const seconds = (ms) => (ms / 1000).toFixed(1).padStart(6);

/** The kit's own CLI is one program, whichever node starts it. */
const program = (command, args) =>
  args.some((arg) => arg.endsWith("cli.js"))
    ? "validate-kit"
    : command.split(/[\\/]/).pop();

/** [milliseconds, command, args] for each command the smoke started. */
const timings = [];

/** The same launcher, with each call's time kept. */
export const timed = (spawn) => (command, args, options) => {
  const started = performance.now();
  try {
    return spawn(command, args, options);
  } finally {
    timings.push([performance.now() - started, command, args]);
  }
};

export function timingReport(entries = timings) {
  const total = new Map();
  for (const [ms, command, args] of entries) {
    const key = program(command, args);
    const [sum, count] = total.get(key) ?? [0, 0];
    total.set(key, [sum + ms, count + 1]);
  }
  return [
    `smoke timings: ${entries.length} commands, ${seconds(entries.reduce((sum, [ms]) => sum + ms, 0)).trim()}s in them`,
    ...[...total]
      .toSorted((a, b) => b[1][0] - a[1][0])
      .slice(0, 12)
      .map(([key, [ms, count]]) => `${seconds(ms)}s  ${key} x${count}`),
    "slowest:",
    ...entries
      .toSorted((a, b) => b[0] - a[0])
      .slice(0, 12)
      .map(
        ([ms, command, args]) =>
          `${seconds(ms)}s  ${program(command, args)} ${args
            .filter((arg) => !arg.endsWith("cli.js"))
            .join(" ")
            .slice(0, 100)}`,
      ),
  ].join("\n");
}
