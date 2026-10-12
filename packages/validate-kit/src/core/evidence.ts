import { createHash } from "node:crypto";
import { gitState } from "../detect/git.js";
import { kitVersion } from "./paths.js";
import type { ResolvedConfig, ToolAdapter, TrustedPolicy } from "./types.js";

/**
 * What a report was produced from, so it can be tied to the code it judged
 * and cannot be passed off as the result for another commit or another
 * policy.
 */
export interface RunEvidence {
  /** `git rev-parse HEAD`; null outside a repository or before a first commit. */
  revision: string | null;
  /**
   * Work tree differs from HEAD, untracked files included (they are linted
   * too); null outside a repository.
   */
  dirty: boolean | null;
  /**
   * sha256 of the resolved policy: the config with keys sorted, without
   * `concurrency` (how the run is executed, which differs per machine).
   */
  configDigest: string;
  kitVersion: string;
  /** The commit the config was read from (--trusted-ref); absent otherwise. */
  trustedRef?: string;
  /**
   * With --trusted-ref: whether the work tree's settings files were compared
   * with that commit. False when the trusted config turns the check off
   * (tools.policy.enabled: false): the tools then read the patch's settings.
   */
  settingsChecked?: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An adapter holds a value the digest cannot identify. */
export class IdentityError extends Error {}

/**
 * One text per value, every kind tagged so no value of one kind reads as one
 * of another (a function's hash as a string, a cycle as text). Plain data and
 * functions (by the hash of their source) only: anything else could judge
 * differently under the same text, so it is refused.
 */
function canonical(
  value: unknown,
  where: string,
  path: Set<object>,
  memo: WeakMap<object, string>,
): string {
  if (value === null) return "z";
  switch (typeof value) {
    case "undefined":
      return "u";
    case "boolean":
      return value ? "t" : "f";
    case "number":
      return `n${Object.is(value, -0) ? "-0" : String(value)}`;
    case "string":
      return `s${JSON.stringify(value)}`;
    case "function": {
      const source = Function.prototype.toString.call(value);
      // The engine writes a native or bound function (a getter too: "function
      // get size() { [native code] }") with that body; no source an author
      // wrote can end so, though it may mention "[native code]".
      if (/\{\s*\[native code\]\s*\}\s*$/.test(source))
        throw new IdentityError(
          `${where} is a native or bound function, whose source does not show what it does`,
        );
      return `F${sha256(source)}`;
    }
    case "object":
      break;
    default:
      throw new IdentityError(`${where} is a ${typeof value}`);
  }
  const object = value;
  const known = memo.get(object);
  if (known !== undefined) return known;
  if (path.has(object)) throw new IdentityError(`${where} contains itself`);
  const proto: unknown = Object.getPrototypeOf(object);
  const isArray = Array.isArray(object);
  if (!isArray && proto !== Object.prototype && proto !== null) {
    const kind =
      (proto as { constructor?: { name?: string } }).constructor?.name ??
      "non-plain";
    throw new IdentityError(
      `${where} is a ${kind} object; hold plain data or functions there`,
    );
  }
  path.add(object);
  const fields = object as Record<string, unknown>;
  // Every index up to the length, a hole as a value of its own: Array(1) is
  // not [] (map would skip the hole).
  const items = object as unknown[];
  const text = isArray
    ? `a[${Array.from({ length: items.length }, (_, n) => (n in items ? canonical(items[n], `${where}[${n}]`, path, memo) : "h")).join(",")}]`
    : `o{${Object.keys(fields)
        .toSorted()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical(fields[key], `${where}.${key}`, path, memo)}`,
        )
        .join(",")}}`;
  path.delete(object);
  memo.set(object, text);
  return text;
}

/**
 * What identifies an adapter in the digest: every field it has, its own and
 * its prototypes' (a class instance keeps its methods there), nested values
 * included. Any field may change the verdict (`optional` turns a missing tool
 * from exit 3 into a skip), so none is left out. What a function closes over
 * is invisible to this, which is why an adapter states it as `policy`.
 */
function adapterIdentity(adapter: ToolAdapter): string {
  const path = new Set<object>();
  const memo = new WeakMap<object, string>();
  const fields = adapter as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (
    let at: object | null = adapter;
    at !== null && at !== Object.prototype;
    at = Object.getPrototypeOf(at) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(at)) {
      if (key === "constructor" || seen.has(key)) continue;
      seen.add(key);
      parts.push(
        `${JSON.stringify(key)}:${canonical(fields[key], `adapter "${adapter.id}" field ${key}`, path, memo)}`,
      );
    }
  }
  return `o{${parts.toSorted().join(",")}}`;
}

// Taken when the config is resolved, before any adapter code runs: what an
// adapter writes onto itself during a run is not its policy.
const identities = new WeakMap<ToolAdapter, string>();

/**
 * Fix an adapter's identity now. Throws IdentityError for a value the digest
 * cannot identify (a cycle, a RegExp, a native function).
 */
export function fixAdapterIdentity(adapter: ToolAdapter): void {
  identities.set(adapter, adapterIdentity(adapter));
}

/** JSON with object keys sorted and undefined values left out. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  // undefined for undefined, a function or a symbol, whatever its type says.
  const json = JSON.stringify(value) as string | undefined;
  return json ?? "null";
}

export function configDigest(config: ResolvedConfig): string {
  const { concurrency: _execution, adapters, ...policy } = config;
  return sha256(
    stableJson({
      ...policy,
      adapters: adapters.map(
        (adapter) => identities.get(adapter) ?? adapterIdentity(adapter),
      ),
    }),
  );
}

export async function collectEvidence(
  projectRoot: string,
  config: ResolvedConfig,
  trusted?: TrustedPolicy,
  settingsChecked = false,
): Promise<RunEvidence> {
  return {
    ...(await gitState(projectRoot)),
    configDigest: configDigest(config),
    kitVersion: kitVersion(),
    ...(trusted ? { trustedRef: trusted.commit, settingsChecked } : {}),
  };
}
