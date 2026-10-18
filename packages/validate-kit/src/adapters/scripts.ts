import { statSync } from "node:fs";
import { extname, posix } from "node:path";
import type { Finding } from "../core/types.js";
import { firstLine } from "../detect/languages.js";
import { fileFinding, gitSync, indexEntries, nativeCheck } from "./native.js";

/**
 * Line endings as git stores each tracked file (`i/crlf`, `i/lf`, `i/-text`):
 * with core.autocrlf the disk holds CRLF where the commit holds LF.
 */
function storedEol(root: string): Map<string, string> {
  const eol = new Map<string, string>();
  for (const entry of (gitSync(root, ["ls-files", "--eol", "-z"]) ?? "").split(
    "\0",
  )) {
    const match = /^i\/(\S*)\s+w\/\S*\s+attr\/[^\t]*\t(.*)$/s.exec(entry);
    if (match?.[2] !== undefined) eol.set(match[2], match[1] ?? "");
  }
  return eol;
}

/**
 * scripts — scripts that cannot start: a `#!` line ending in a carriage
 * return as git stores it (the kernel looks for an interpreter named
 * `bash\r`: "bad interpreter"), and an extensionless file with a `#!` line
 * that git stores without the executable bit (mode 100644), so a fresh clone
 * cannot run it. A script with an extension may be meant to be sourced, so
 * only an extensionless one must be executable. Reads git's whole file list,
 * hooks in dotfolders included. Extensionless shell scripts are also
 * shellcheck's: the scope reads their `#!` line.
 */
export const scripts = nativeCheck({
  id: "scripts",
  layer: "lint",
  allPaths: true,
  check(root, task) {
    const findings: Finding[] = [];
    const at = (path: string, ruleId: string, message: string) =>
      findings.push(
        fileFinding("scripts", "lint", root, path, {
          ruleId,
          severity: "error",
          message,
        }),
      );
    const shebangs = task.files.filter((path) =>
      firstLine(posix.join(root, path)).startsWith("#!"),
    );
    if (shebangs.length === 0) return findings;
    const index = indexEntries(root);
    const eol = storedEol(root);
    for (const path of shebangs) {
      const stored = eol.get(path);
      const crlf =
        stored === undefined
          ? firstLine(posix.join(root, path)).endsWith("\r")
          : stored === "crlf" || stored === "mixed";
      if (crlf)
        at(
          path,
          "crlf-shebang",
          "the `#!` line ends in a carriage return (CRLF), so the system looks for an interpreter whose name ends in `\\r` and the script does not start: store it with LF line endings",
        );
      if (extname(path) !== "") continue;
      // The mode the commit stores; a file git does not track yet, its mode
      // on disk (Windows has none to read).
      const mode = index.get(path)?.mode;
      let executable: boolean;
      if (mode !== undefined) executable = mode !== "100644";
      else if (process.platform === "win32") continue;
      else
        try {
          executable = (statSync(posix.join(root, path)).mode & 0o111) !== 0;
        } catch {
          continue;
        }
      if (!executable)
        at(
          path,
          "not-executable",
          `has a \`#!\` line but git stores it without the executable bit, so it cannot be run after a clone: \`git update-index --chmod=+x ${path}\` (and \`chmod +x\`)`,
        );
    }
    return findings;
  },
});
