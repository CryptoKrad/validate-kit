/**
 * The documented exit-code contract. Distinct codes so callers (CI, lefthook)
 * can tell "found issues" from "a required tool was missing" — the latter must
 * never masquerade as a clean pass.
 */
export const EXIT = {
  /** All enabled layers ran, zero error-severity findings. */
  CLEAN: 0,
  /** At least one error-severity finding. */
  FINDINGS: 1,
  /** Usage / config error (bad flag, invalid validate.config). */
  CONFIG: 2,
  /** A required tool was missing/unavailable — loud, never a pass. */
  INCOMPLETE: 3,
  /** An adapter crashed unexpectedly. */
  INTERNAL: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
