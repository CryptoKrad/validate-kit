import type { ToolAdapter } from "../core/types.js";
import { astgrep } from "./astgrep.js";
import { biome, biomeFormat } from "./biome.js";
import { cargoDeny } from "./cargo-deny.js";
import { clippy } from "./clippy.js";
import { deadcode } from "./deadcode.js";
import { eslint } from "./eslint.js";
import { gitleaks } from "./gitleaks.js";
import { gofmt } from "./gofmt.js";
import { gofumpt } from "./gofumpt.js";
import { golangci } from "./golangci.js";
import { govulncheck } from "./govulncheck.js";
import { jscpd } from "./jscpd.js";
import { knip } from "./knip.js";
import { mypy } from "./mypy.js";
import { nilaway } from "./nilaway.js";
import { oasdiff } from "./oasdiff.js";
import { osvScanner } from "./osv.js";
import { oxlint } from "./oxlint.js";
import { policy } from "./policy.js";
import { prettier } from "./prettier.js";
import { ruff } from "./ruff.js";
import { ruffFormat } from "./ruff-format.js";
import { rustfmt } from "./rustfmt.js";
import { semgrep } from "./semgrep.js";
import { shellcheck } from "./shellcheck.js";
import { slither } from "./slither.js";
import { squawk } from "./squawk.js";
import { lean } from "./lean.js";
import { quint } from "./quint.js";
import { tlc } from "./tlc.js";
import { tsc } from "./tsc.js";

/**
 * Every tool integration the engine knows about. Drives detection→activation,
 * `check doctor`, and the install matrix. Order here is informational; the runner
 * orders execution by layer.
 */
export const TOOL_REGISTRY: ToolAdapter[] = [
  // format
  prettier,
  biomeFormat,
  ruffFormat,
  rustfmt,
  gofmt,
  gofumpt,
  // lint
  oxlint,
  eslint,
  biome,
  ruff,
  clippy,
  golangci,
  deadcode,
  nilaway,
  shellcheck,
  squawk,
  knip,
  jscpd,
  // type-check
  tsc,
  mypy,
  // custom-rules
  astgrep,
  // security
  semgrep,
  gitleaks,
  policy,
  cargoDeny,
  slither,
  // opt-in config-driven gates (vulnAudit / apiDiff)
  osvScanner,
  govulncheck,
  oasdiff,
  // formal
  tlc,
  lean,
  quint,
];

export function adapterById(id: string): ToolAdapter | undefined {
  return TOOL_REGISTRY.find((a) => a.id === id);
}
