import type { Finding } from "../core/types.js";
import { toPosix } from "../detect/languages.js";
import { fileFinding, gitFiles, ignoredBy, nativeCheck } from "./native.js";

/**
 * Names Windows keeps for devices, with any extension (`nul.txt` too), as
 * Git for Windows refuses them.
 */
const RESERVED =
  /^(?:con|prn|aux|nul|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3]|conin\$|conout\$)(?:\.[^/]*)?$/i;

/** Characters a Windows file name cannot hold, besides control characters. */
const INVALID = /[<>:"|?*\\]/;

/** One spelling of a name: where to report it, and how many paths use it. */
interface Spelling {
  file: string;
  folder: boolean;
  uses: number;
}

/** How macOS compares names: one case, one Unicode form; Windows: one case. */
const fold = (path: string) => path.normalize("NFC").toLowerCase();

function windowsProblem(part: string): string | undefined {
  if (RESERVED.test(part)) return `\`${part}\` is a device name on Windows`;
  if (/[. ]$/.test(part))
    return `\`${part}\` ends in a ${part.endsWith(".") ? "dot" : "space"}, which Windows drops`;
  if (Array.from(part, (char) => char.charCodeAt(0)).some((code) => code < 32))
    return `\`${JSON.stringify(part).slice(1, -1)}\` holds a control character, which Windows does not allow in a name`;
  const bad = INVALID.exec(part);
  if (bad)
    return `\`${part}\` holds \`${bad[0]}\`, which Windows does not allow in a name`;
  return undefined;
}

/**
 * paths — names that break a checkout on another system: two paths that
 * differ only in case, which macOS and Windows store as one file or folder,
 * or only in Unicode form (NFC against NFD), which macOS does, so one
 * overwrites the other; and names Windows cannot hold (a device name such as
 * `aux`, a trailing dot or space, `:` or `?`), which git refuses to check out
 * there. Read from git's file list, dotfiles included, less the config's
 * `ignore`; in a changed-file run, only problems that involve a changed path.
 */
export const paths = nativeCheck({
  id: "paths",
  layer: "lint",
  allPaths: true,
  // Every listed path, whatever changed: a collision can be with any of them.
  plan: (files, env) => {
    const ignored = ignoredBy(env);
    return (
      gitFiles(toPosix(env.projectRoot), env.changedMode === "staged") ?? files
    ).filter((path) => !ignored(path));
  },
  check(root, task) {
    const all = task.extra as string[];
    const changed = new Set(task.changed ? task.files : []);
    const findings: Finding[] = [];
    const at = (path: string, ruleId: string, message: string) =>
      findings.push(
        fileFinding("paths", "lint", root, path, {
          ruleId,
          severity: "error",
          message,
        }),
      );
    // Each file and folder by its folded name: every spelling, whether it is
    // a folder, how many paths use it, and the file to report it at (a
    // changed one in a changed-file run).
    const spellings = new Map<string, Map<string, Spelling>>();
    for (const path of all) {
      const parts = path.split("/");
      for (let depth = 1; depth <= parts.length; depth++) {
        const name = parts.slice(0, depth).join("/");
        const known = spellings.get(fold(name)) ?? new Map<string, Spelling>();
        spellings.set(fold(name), known);
        const seen = known.get(name);
        if (seen) {
          seen.uses++;
          if (!changed.has(seen.file) && changed.has(path)) seen.file = path;
        } else
          known.set(name, {
            file: path,
            folder: depth < parts.length,
            uses: 1,
          });
      }
      if (task.changed && !changed.has(path)) continue;
      for (const part of parts) {
        const problem = windowsProblem(part);
        if (problem) {
          at(
            path,
            "windows-name",
            `${problem}: git cannot check this path out on Windows`,
          );
          break;
        }
      }
    }
    // Shallowest first: a folder that collides is reported once, not once
    // per file in it.
    const collided: string[] = [];
    for (const [key, known] of [...spellings].toSorted(
      ([a], [b]) => a.split("/").length - b.split("/").length,
    )) {
      if (known.size < 2) continue;
      if (collided.some((folder) => key.startsWith(`${folder}/`))) continue;
      collided.push(key);
      const names = [...known.keys()].toSorted();
      const target = [...known.values()].find((seen) => changed.has(seen.file));
      if (task.changed && target === undefined) continue;
      // Else at the spelling fewer paths use, the likelier mistake.
      const fewest = [...known.values()].toSorted((a, b) => a.uses - b.uses)[0];
      const file = (target ?? fewest)?.file ?? key;
      const described = names
        .map(
          (name) =>
            `${known.get(name)?.folder ? "folder" : "file"} \`${name}\``,
        )
        .join(" and ");
      const caseOnly =
        new Set(names.map((name) => name.normalize("NFC"))).size ===
        names.length;
      at(
        file,
        "case-collision",
        caseOnly
          ? `${described} differ only in case: macOS and Windows keep them as one, so a checkout there loses one`
          : `${described} differ only in Unicode form (NFC and NFD): macOS keeps them as one, so a checkout there loses one`,
      );
    }
    return findings;
  },
});
