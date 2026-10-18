#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYamlDocument } from "yaml";
import { join } from "node:path";

const workflowDir = ".github/workflows";
const workflowFiles = readdirSync(workflowDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => join(workflowDir, file))
  .toSorted();
const checkedFiles = [...workflowFiles, "package.json"];
let failed = false;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(
  packageJson.packageManager ?? "",
)?.[1];
const externalPackageSmokeStepName = "External package tarball smoke";
const externalPackageSmokeCommand = "pnpm run smoke:external-package";
const perfSmokeStepName = "k6 smoke";
const perfSmokeCommand = "pnpm run workflow:perf-local";

function fail(message) {
  console.error(`validate-workflows: ${message}`);
  failed = true;
}

function isWorkflowFile(file, name) {
  return (
    file === `${workflowDir}/${name}.yml` ||
    file === `${workflowDir}/${name}.yaml`
  );
}

function hasConcurrencyCancelInProgress(lines) {
  const concurrencyIndex = lines.findIndex((line) =>
    /^concurrency:\s*$/.test(line),
  );
  if (concurrencyIndex === -1) return false;

  for (const line of lines.slice(concurrencyIndex + 1)) {
    if (/^\S[^:]*:/.test(line)) return false;
    if (/^\s+cancel-in-progress:\s*true\s*$/.test(line)) return true;
  }

  return false;
}

function topLevelBlock(lines, name) {
  const start = lines.findIndex((line) =>
    new RegExp(`^${name}:\\s*(.*)$`).test(line),
  );
  if (start === -1) return undefined;

  const value = new RegExp(`^${name}:\\s*(.*)$`).exec(lines[start])?.[1] ?? "";
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S[^:]*:/.test(line)) break;
    body.push(line);
  }

  return { line: start + 1, value: value.trim(), body };
}

function workflowEventBlock(onBlock, eventName) {
  const start = onBlock.body.findIndex((line) =>
    new RegExp(`^\\s{2}${eventName}:\\s*(.*)$`).test(line),
  );
  if (start === -1) return undefined;

  const value =
    new RegExp(`^\\s{2}${eventName}:\\s*(.*)$`).exec(
      onBlock.body[start],
    )?.[1] ?? "";
  const body = [];
  for (const line of onBlock.body.slice(start + 1)) {
    if (/^\s{2}\S[^:]*:/.test(line)) break;
    body.push(line);
  }

  return { line: onBlock.line + start + 1, value: value.trim(), body };
}

function workflowJobBlocks(lines) {
  const jobsBlock = topLevelBlock(lines, "jobs");
  if (!jobsBlock || jobsBlock.value) return new Map();

  const jobs = new Map();
  for (let index = 0; index < jobsBlock.body.length; index += 1) {
    const match = /^\s{2}([A-Za-z0-9_-]+):\s*$/.exec(jobsBlock.body[index]);
    if (!match) continue;

    const jobName = match[1];
    const body = [];
    for (const line of jobsBlock.body.slice(index + 1)) {
      if (/^\s{2}\S[^:]*:/.test(line)) break;
      body.push(line);
    }
    jobs.set(jobName, {
      line: jobsBlock.line + index + 1,
      body,
    });
  }

  return jobs;
}

function hasContinueOnErrorTrue(job) {
  return job.body.some((line) =>
    /^\s{4}continue-on-error:\s*true\s*(?:#.*)?$/.test(line),
  );
}

function workflowStepBlocks(job) {
  const stepsIndex = job.body.findIndex((line) =>
    /^\s{4}steps:\s*$/.test(line),
  );
  if (stepsIndex === -1) return [];

  const steps = [];
  for (let index = stepsIndex + 1; index < job.body.length; index += 1) {
    const line = job.body[index];
    if (/^\s{4}\S[^:]*:/.test(line)) break;

    if (!/^\s{6}-\s*/.test(line)) continue;

    const body = [line];
    let end = index + 1;
    for (; end < job.body.length; end += 1) {
      const next = job.body[end];
      if (/^\s{4}\S[^:]*:/.test(next) || /^\s{6}-\s*/.test(next)) break;
      body.push(next);
    }

    steps.push({
      line: job.line + index + 1,
      body,
    });
    index = end - 1;
  }

  return steps;
}

function workflowStepProperty(step, property) {
  const dashPattern = new RegExp(
    `^\\s{6}-\\s+${property}:\\s*(.*?)\\s*(?:#.*)?$`,
  );
  const propertyPattern = new RegExp(
    `^\\s{8}${property}:\\s*(.*?)\\s*(?:#.*)?$`,
  );

  for (const line of step.body) {
    const value =
      dashPattern.exec(line)?.[1] ?? propertyPattern.exec(line)?.[1];
    if (value !== undefined) return yamlScalar(value);
  }

  return undefined;
}

function hasStepContinueOnErrorTrue(step) {
  return step.body.some(
    (line) =>
      /^\s{6}-\s+continue-on-error:\s*true\s*(?:#.*)?$/.test(line) ||
      /^\s{8}continue-on-error:\s*true\s*(?:#.*)?$/.test(line),
  );
}

function validateWorkflowSoftPassPolicy(lines, file) {
  const jobs = workflowJobBlocks(lines);
  for (const [jobName, job] of jobs.entries()) {
    if (!hasContinueOnErrorTrue(job)) continue;

    if (!isWorkflowFile(file, "perf") || jobName !== "k6-smoke") {
      fail(`${file}:${job.line}: workflow job ${jobName} must not soft-pass`);
    }
  }

  if (!isWorkflowFile(file, "perf")) {
    return;
  }

  const perfJob = jobs.get("k6-smoke");
  if (!perfJob) {
    fail(`${file}: perf workflow must define k6-smoke job`);
    return;
  }

  if (!hasContinueOnErrorTrue(perfJob)) {
    fail(`${file}:${perfJob.line}: perf k6-smoke job must stay informational`);
  }
}

function yamlScalar(value) {
  return value.trim().replace(/^["'](.+)["']$/, "$1");
}

// Shell-level soft-passes (`|| true`, `|| exit 0`, `|| :`, `set +e`) neuter a
// step invisibly — the job stays green no matter what the command found, which
// defeats every gate above (continue-on-error is policed, but a shell wrapper
// was not). Every occurrence must carry an explicit, auditable justification:
// `# soft-pass-ok: <reason>` on the same line.
const shellSoftPassPattern =
  /\|\|\s*(?:true\b|exit\s+0\b|:(?:\s|$))|(?:^|[\s;&])set\s+\+e\b/;

// container:/services: image tags are mutable and retargetable — the same
// supply-chain class the uses: SHA-pin gate closes. Require a digest.
function validateContainerImageDigests(lines, file) {
  lines.forEach((line, index) => {
    const m = /^\s*image:\s*["']?([^\s"'#]+)/.exec(line);
    if (m && !m[1].includes("@sha256:")) {
      fail(
        `${file}:${index + 1}: container image must be digest-pinned (append @sha256:<digest>): ${m[1]}`,
      );
    }
  });
}

// The line-scanners above assume prettier's fixed 2/4/6/8-space layout; on an
// unexpected format they iterate NOTHING and the dependent policy checks pass
// silently. Cross-assert against a real YAML parse so format drift fails loud
// instead of under-enforcing.
function validateStructuralParity(lines, file) {
  let doc;
  try {
    doc = parseYamlDocument(lines.join("\n"));
  } catch (err) {
    fail(`${file}: not parseable YAML: ${err.message}`);
    return;
  }
  const yamlJobs = Object.keys(doc?.jobs ?? {}).toSorted();
  const scannedJobs = [...workflowJobBlocks(lines).keys()].toSorted();
  if (yamlJobs.join(",") !== scannedJobs.join(",")) {
    fail(
      `${file}: structural drift — YAML has jobs [${yamlJobs.join(", ")}] but the policy scanner sees [${scannedJobs.join(", ")}]; the soft-pass/permissions checks would under-enforce. Keep the prettier layout or update the scanner.`,
    );
    return;
  }
  for (const [name, job] of workflowJobBlocks(lines)) {
    const yamlSteps = (doc?.jobs?.[name]?.steps ?? []).length;
    const scannedSteps = workflowStepBlocks(job).length;
    if (yamlSteps !== scannedSteps) {
      fail(
        `${file}: job ${name}: YAML has ${yamlSteps} steps but the policy scanner sees ${scannedSteps} — step-level checks would under-enforce`,
      );
    }
  }
  // Job-level permissions escalation: the top-level gate is bypassable by a
  // per-job permissions block. Same policy: contents stays read-only; any
  // write scope must be explicitly justified in a review of this validator.
  // Explicit escalation allowlist: npm Trusted Publishing requires an OIDC
  // token, and ONLY the release publish job may mint one. Anything else is
  // an escalation.
  const allowedJobWrites = new Set(["release.yml/publish/id-token"]);
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    const perms = job?.permissions;
    if (!perms || typeof perms !== "object") continue;
    for (const [scope, level] of Object.entries(perms)) {
      if (String(level).trim() === "write") {
        const key = `${file.split("/").pop()}/${name}/${scope}`;
        if (allowedJobWrites.has(key)) continue;
        fail(
          `${file}: job ${name}: job-level permissions escalation (${scope}: write) — the least-privilege gate covers job blocks too`,
        );
      }
    }
  }
}

function validateShellSoftPass(lines, file) {
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    if (!shellSoftPassPattern.test(line)) return;
    if (/#\s*soft-pass-ok:\s*\S/.test(line)) return;
    fail(
      `${file}:${index + 1}: shell soft-pass ("|| true" / "|| exit 0" / "set +e") silently neuters this step — remove it or annotate the line with "# soft-pass-ok: <reason>"`,
    );
  });
}

function validateExternalPackageSmokeStep(lines, file) {
  if (!isWorkflowFile(file, "validate")) return;

  const validateJob = workflowJobBlocks(lines).get("validate");
  if (!validateJob) {
    fail(`${file}: validate workflow must define validate job`);
    return;
  }

  const smokeSteps = workflowStepBlocks(validateJob).filter(
    (step) =>
      workflowStepProperty(step, "name") === externalPackageSmokeStepName,
  );
  if (smokeSteps.length === 0) {
    fail(
      `${file}: validate workflow must name the external package smoke step`,
    );
    return;
  }
  if (smokeSteps.length > 1) {
    fail(
      `${file}: validate workflow must not duplicate the external package smoke step`,
    );
  }

  const [smokeStep] = smokeSteps;
  const runCommand = workflowStepProperty(smokeStep, "run");
  if (runCommand !== externalPackageSmokeCommand) {
    fail(
      `${file}:${smokeStep.line}: external package smoke must run exactly "${externalPackageSmokeCommand}" without shell soft-pass wrappers`,
    );
  }
  if (hasStepContinueOnErrorTrue(smokeStep)) {
    fail(
      `${file}:${smokeStep.line}: external package smoke must not use continue-on-error`,
    );
  }
}

function validatePerfSmokeStep(lines, file) {
  if (!isWorkflowFile(file, "perf")) return;

  const perfJob = workflowJobBlocks(lines).get("k6-smoke");
  if (!perfJob) {
    fail(`${file}: perf workflow must define k6-smoke job`);
    return;
  }

  const steps = workflowStepBlocks(perfJob);
  if (
    !steps.some((step) =>
      step.body.some((line) => /uses:\s*grafana\/setup-k6-action@/.test(line)),
    )
  ) {
    fail(`${file}: perf workflow must install k6 with grafana/setup-k6-action`);
  }

  const smokeSteps = steps.filter(
    (step) => workflowStepProperty(step, "name") === perfSmokeStepName,
  );
  if (smokeSteps.length === 0) {
    fail(`${file}: perf workflow must name the k6 smoke step`);
    return;
  }
  if (smokeSteps.length > 1) {
    fail(`${file}: perf workflow must not duplicate the k6 smoke step`);
  }

  const [smokeStep] = smokeSteps;
  const runCommand = workflowStepProperty(smokeStep, "run");
  if (runCommand !== perfSmokeCommand) {
    fail(
      `${file}:${smokeStep.line}: perf smoke must run exactly "${perfSmokeCommand}"`,
    );
  }
  if (hasStepContinueOnErrorTrue(smokeStep)) {
    fail(
      `${file}:${smokeStep.line}: perf smoke step must not soft-pass itself`,
    );
  }
}

function inlineListIncludesMain(value) {
  const match = /^\[(.*)]$/.exec(value.trim());
  if (!match) return false;

  return match[1]
    .split(",")
    .map((item) => yamlScalar(item.trim()))
    .includes("main");
}

function hasMainBranch(pushEvent) {
  const branchesIndex = pushEvent.body.findIndex((line) =>
    /^\s+branches:\s*/.test(line),
  );
  if (branchesIndex === -1) return false;

  const branchesLine = pushEvent.body[branchesIndex];
  const inlineBranches = /^\s+branches:\s*(.+?)\s*$/.exec(branchesLine)?.[1];
  if (inlineBranches && inlineListIncludesMain(inlineBranches)) {
    return true;
  }
  if (inlineBranches && yamlScalar(inlineBranches) === "main") {
    return true;
  }

  for (const line of pushEvent.body.slice(branchesIndex + 1)) {
    if (/^\s{4}\S[^:]*:/.test(line)) break;
    const branch = /^\s+-\s*(.+?)\s*$/.exec(line)?.[1];
    if (branch && yamlScalar(branch) === "main") return true;
  }

  return false;
}

function validateWorkflowTriggers(lines, file) {
  const onBlock = topLevelBlock(lines, "on");
  if (!onBlock || onBlock.value) {
    fail(`${file}: workflow must declare on.pull_request as a block trigger`);
    return;
  }

  // The release workflow is the one publish path: it must fire ONLY on
  // version tags — a pull_request or plain-push trigger on a workflow with
  // id-token: write would be a supply-chain hole, not a gap.
  if (isWorkflowFile(file, "release")) {
    if (workflowEventBlock(onBlock, "pull_request")) {
      fail(`${file}: the release workflow must not run on pull_request`);
    }
    const pushEvent = workflowEventBlock(onBlock, "push");
    const body = pushEvent?.body.join("\n") ?? "";
    if (!pushEvent || !/tags:/.test(body) || !/"v\*"|'v\*'|- v\*/.test(body)) {
      fail(`${file}: the release workflow must trigger on push tags v*`);
    }
    if (/branches:/.test(body)) {
      fail(`${file}: the release workflow must not trigger on branch pushes`);
    }
    return;
  }

  if (!workflowEventBlock(onBlock, "pull_request")) {
    fail(`${file}: workflow must run on pull_request`);
  }

  if (isWorkflowFile(file, "perf")) {
    return;
  }

  const pushEvent = workflowEventBlock(onBlock, "push");
  if (!pushEvent) {
    fail(`${file}: workflow must run on push to main`);
    return;
  }

  if (!hasMainBranch(pushEvent)) {
    fail(`${file}: workflow push trigger must include branches: [main]`);
  }
}

function validateWorkflowPermissions(lines, file) {
  const permissions = topLevelBlock(lines, "permissions");
  if (!permissions) {
    fail(`${file}: workflow must set top-level permissions.contents: read`);
    return;
  }

  if (permissions.value) {
    fail(
      `${file}:${permissions.line}: permissions must be a block with contents: read`,
    );
    return;
  }

  const hasContentsRead = permissions.body.some((line) =>
    /^\s+contents:\s*read\s*$/.test(line),
  );
  if (!hasContentsRead) {
    fail(
      `${file}:${permissions.line}: permissions must include contents: read`,
    );
  }

  for (const [offset, line] of permissions.body.entries()) {
    if (/^\s+contents:\s*write\s*$/.test(line)) {
      fail(
        `${file}:${permissions.line + offset + 1}: contents permission must stay read-only`,
      );
    }
  }
}

function validateHostedValidateKitTestScope(lines, file) {
  const text = lines.join("\n");
  if (isWorkflowFile(file, "validate")) {
    if (
      !/pnpm\s+--fail-if-no-match\s+--filter\s+validate-kit\s+run\s+test:core\b/.test(
        text,
      )
    ) {
      fail(
        `${file}: validate workflow must run the validate-kit core package test script with --fail-if-no-match`,
      );
    }
    if (!/\bpnpm\s+run\s+smoke:external-package\b/.test(text)) {
      fail(
        `${file}: validate workflow must run the external package tarball smoke`,
      );
    }
    validateExternalPackageSmokeStep(lines, file);
  }

  if (isWorkflowFile(file, "poly")) {
    if (
      !/pnpm\s+--fail-if-no-match\s+--filter\s+validate-kit\s+run\s+test:polyglot\b/.test(
        text,
      )
    ) {
      fail(
        `${file}: poly workflow must run the validate-kit polyglot package test script with --fail-if-no-match`,
      );
    }
    for (const snippet of [
      "dtolnay/rust-toolchain@",
      "components: clippy, rustfmt",
      "toolchain: stable",
      'go-version: "1.25"',
      "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2",
      "mvdan.cc/gofumpt@v0.10.0",
      "astral-sh/setup-uv@",
      'version: "0.9.30"',
      "uv tool install ruff==0.15.6",
      "npm install -g @ast-grep/cli@0.45.3",
      "cd packages/validate-kit && ./node_modules/.bin/tsup",
    ]) {
      if (!text.includes(snippet)) {
        fail(
          `${file}: poly workflow must include native-toolchain proof: ${snippet}`,
        );
      }
    }
  }

  if (
    /vitest\s+run\s+test\/engine\.test\.ts\s+test\/scope\.test\.ts/.test(text)
  ) {
    fail(
      `${file}: validate workflow must not narrow validate-kit tests to engine/scope files`,
    );
  }
  if (/vitest\s+run\s+test\/polyglot\.test\.ts/.test(text)) {
    fail(
      `${file}: workflow must call the validate-kit polyglot package script`,
    );
  }
}

function validateHostedBrowserProvisioning(lines, file) {
  if (!isWorkflowFile(file, "e2e")) return;

  const text = lines.join("\n");
  const requiredSnippets = [
    [
      "pnpm --fail-if-no-match --filter web exec playwright install --with-deps chromium",
      "install Playwright Chromium with Linux system dependencies",
    ],
    [
      "pnpm --fail-if-no-match --filter web run e2e",
      "run the web E2E package script",
    ],
    ["actions/upload-artifact@", "upload the Playwright report artifact"],
    ["name: playwright-report", "name the Playwright report artifact"],
    ["path: apps/web/playwright-report/", "upload apps/web/playwright-report/"],
    [
      "if-no-files-found: error",
      "hard-fail when the Playwright report is missing",
    ],
  ];

  for (const [snippet, message] of requiredSnippets) {
    if (!text.includes(snippet)) {
      fail(`${file}: e2e workflow must ${message}`);
    }
  }
}

function validateHostedDockerIntegration(lines, file) {
  if (!isWorkflowFile(file, "test-ts")) return;

  const text = lines.join("\n");
  if (
    !/pnpm\s+--fail-if-no-match\s+--filter\s+api\s+run\s+test:integration:docker\b/.test(
      text,
    )
  ) {
    fail(
      `${file}: test-ts integration job must run the Docker hard-fail integration package script`,
    );
  }
}

function validateTestTsWorkflow(lines, file) {
  if (!isWorkflowFile(file, "test-ts")) return;

  const jobs = workflowJobBlocks(lines);
  const unitJob = jobs.get("unit-component-api");
  if (!unitJob) {
    fail(`${file}: test-ts workflow must define unit-component-api job`);
    return;
  }

  const unitJobText = unitJob.body.join("\n");
  if (!/node:\s*\[\s*22,\s*24\s*\]/.test(unitJobText)) {
    fail(`${file}:${unitJob.line}: test-ts unit job must run node: [22, 24]`);
  }
  if (!/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/.test(unitJobText)) {
    fail(
      `${file}:${unitJob.line}: test-ts unit job must use matrix.node in setup-node`,
    );
  }
  if (
    !/pnpm\s+--fail-if-no-match\s+--filter\s+api\s+run\s+test\b/.test(
      unitJobText,
    )
  ) {
    fail(`${file}:${unitJob.line}: test-ts unit job must run api tests`);
  }
  if (
    !/pnpm\s+--fail-if-no-match\s+--filter\s+web\s+run\s+test\b/.test(
      unitJobText,
    )
  ) {
    fail(`${file}:${unitJob.line}: test-ts unit job must run web tests`);
  }

  const integrationJob = jobs.get("integration");
  if (!integrationJob) {
    fail(`${file}: test-ts workflow must define integration job`);
    return;
  }

  const integrationJobText = integrationJob.body.join("\n");
  if (!/node-version:\s*22\b/.test(integrationJobText)) {
    fail(
      `${file}:${integrationJob.line}: test-ts integration job must run on Node 22`,
    );
  }
}

function validateSecurityWorkflow(lines, file) {
  if (!isWorkflowFile(file, "security")) return;

  const text = lines.join("\n");
  for (const snippet of [
    'SEMGREP_VERSION: "1.163.0"',
    "actions/setup-python@",
    'python-version: "3.12"',
    'python -m pip install "semgrep==${SEMGREP_VERSION}"',
    "semgrep --config packages/validate-kit/semgrep/custom.yml --error --disable-version-check .",
    "pnpm/action-setup@",
    "version: 10.34.7",
    "actions/setup-node@",
    "node-version: 22",
    "pnpm install --frozen-lockfile",
    "pnpm audit --audit-level=high",
  ]) {
    if (!text.includes(snippet)) {
      fail(`${file}: security workflow must include proof: ${snippet}`);
    }
  }
}

// Supply-chain: every third-party/first-party GitHub Action must be pinned to a
// full 40-char commit SHA (mutable tags/branches are retargetable — the
// tj-actions/changed-files CVE-2025-30066 class). Local (./) and docker://
// references are exempt. A trailing `# vX.Y.Z` comment is allowed and ignored.
function validateActionShaPinning(lines, file) {
  for (const [index, line] of lines.entries()) {
    const ref = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line)?.[1];
    if (!ref || ref.startsWith("./") || ref.startsWith("docker://")) continue;
    const at = ref.lastIndexOf("@");
    const pin = at === -1 ? "" : ref.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(pin)) {
      fail(
        `${file}:${index + 1}: action must pin to a full 40-char commit SHA, not a mutable tag/branch: ${ref}`,
      );
    }
  }
}

// e2e.yml renders the visual suite inside a pinned Playwright container; the
// image tag must match the @playwright/test version apps/web installs, or the
// committed Linux baseline (rendered in that image) won't match CI's render.
function validatePlaywrightContainerVersion(lines, file) {
  if (!isWorkflowFile(file, "e2e")) return;
  const imageTag = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/.exec(
    lines.join("\n"),
  )?.[1];
  if (!imageTag) {
    fail(
      `${file}: e2e workflow must render in a pinned mcr.microsoft.com/playwright:vX.Y.Z-* container`,
    );
    return;
  }
  const webPlaywright =
    JSON.parse(readFileSync("apps/web/package.json", "utf8")).devDependencies?.[
      "@playwright/test"
    ] ?? "";
  if (webPlaywright !== imageTag) {
    fail(
      `${file}: Playwright container image v${imageTag} must match apps/web @playwright/test exact pin "${webPlaywright}"`,
    );
  }
}

if (!pnpmVersion) {
  fail("package.json: packageManager must pin pnpm to x.y.z");
}

for (const file of checkedFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let semgrepVersionLine = -1;
  let semgrepVersionPinned = false;

  if (file.startsWith(`${workflowDir}/`)) {
    validateWorkflowTriggers(lines, file);
    validateWorkflowSoftPassPolicy(lines, file);
    validateShellSoftPass(lines, file);
    validateContainerImageDigests(lines, file);
    validateStructuralParity(lines, file);
  }

  if (
    file.startsWith(`${workflowDir}/`) &&
    !hasConcurrencyCancelInProgress(lines)
  ) {
    fail(`${file}: workflow must set concurrency.cancel-in-progress: true`);
  }

  if (file.startsWith(`${workflowDir}/`)) {
    validateWorkflowPermissions(lines, file);
    validateActionShaPinning(lines, file);
    validatePlaywrightContainerVersion(lines, file);
  }

  validateHostedValidateKitTestScope(lines, file);
  validateHostedBrowserProvisioning(lines, file);
  validateHostedDockerIntegration(lines, file);
  validateTestTsWorkflow(lines, file);
  validatePerfSmokeStep(lines, file);
  validateSecurityWorkflow(lines, file);

  lines.forEach((line, index) => {
    if (/@latest\b/.test(line)) {
      fail(`${file}:${index + 1}: avoid @latest in validation tooling`);
    }
    if (/pip install\s+["']?semgrep\b/.test(line) && !/semgrep==/.test(line)) {
      fail(`${file}:${index + 1}: pin semgrep installs to an explicit version`);
    }
    if (/SEMGREP_VERSION\s*:/.test(line)) {
      semgrepVersionLine = index + 1;
      semgrepVersionPinned =
        /SEMGREP_VERSION\s*:\s*["']?\d+\.\d+\.\d+["']?\s*$/.test(line);
    }
    if (
      /uv tool install\s+ruff\b/.test(line) &&
      !/ruff==\d+\.\d+\.\d+/.test(line)
    ) {
      fail(`${file}:${index + 1}: pin ruff installs to an explicit version`);
    }
    if (
      file.startsWith(`${workflowDir}/`) &&
      /\bpnpm\s+/.test(line) &&
      /--filter\b/.test(line) &&
      !/--fail-if-no-match\b/.test(line)
    ) {
      fail(
        `${file}:${index + 1}: mandatory pnpm --filter workflow commands must include --fail-if-no-match`,
      );
    }
  });

  const pnpmSetupIndexes = lines
    .map((line, index) =>
      /uses:\s*pnpm\/action-setup@/.test(line) ? index : -1,
    )
    .filter((index) => index !== -1);
  for (const setupIndex of pnpmSetupIndexes) {
    const setupBlock = lines.slice(setupIndex, setupIndex + 6).join("\n");
    const version = /^\s*version:\s*["']?([^"'\s#]+)["']?/m.exec(
      setupBlock,
    )?.[1];
    if (version !== pnpmVersion) {
      fail(
        `${file}:${setupIndex + 1}: pin pnpm/action-setup version to packageManager pnpm@${pnpmVersion}`,
      );
    }
  }

  const semgrepInstallWithEnv = lines.some((line) =>
    /semgrep==\$\{SEMGREP_VERSION\}/.test(line),
  );
  if (semgrepInstallWithEnv && !semgrepVersionPinned) {
    fail(
      `${file}:${semgrepVersionLine === -1 ? 1 : semgrepVersionLine}: SEMGREP_VERSION must pin x.y.z when used for pip install`,
    );
  }

  if (isWorkflowFile(file, "poly")) {
    const setupUvIndex = lines.findIndex((line) =>
      /uses:\s*astral-sh\/setup-uv@/.test(line),
    );
    if (setupUvIndex !== -1) {
      const setupUvBlock = lines
        .slice(setupUvIndex, setupUvIndex + 6)
        .join("\n");
      if (!/version:\s*["']?\d+\.\d+\.\d+["']?/.test(setupUvBlock)) {
        fail(
          `${file}:${setupUvIndex + 1}: pin setup-uv to an explicit version`,
        );
      }
    }
  }
}

// Version-drift gate. mise.toml pins the runtimes (node, pnpm, go, python,
// uv), and each must match its CI/package home. The validation tools are
// installed one by one (Homebrew on a machine, pinned in CI and package.json),
// so each tool's pins must agree wherever it is pinned, and it must be pinned
// at least once: bumping one place without the others fails loud. Floating
// channels (rust=stable) are not cross-checked; go is compared at
// major.minor and k6 normalizes the release `v` prefix.
function validateToolVersionDrift() {
  const mise = readFileSync("mise.toml", "utf8");
  const miseVersion = (key) =>
    new RegExp(
      `^\\s*"?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=\\s*"([^"]+)"`,
      "m",
    ).exec(mise)?.[1];
  const workflows = workflowFiles
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const vkPkg = readFileSync("packages/validate-kit/package.json", "utf8");
  const rootPkg = readFileSync("package.json", "utf8");

  const runtimes = [
    ["pnpm", rootPkg, (v) => `"pnpm@${v}"`],
    ["python", workflows, (v) => `python-version: "${v}"`],
  ];
  for (const [key, haystack, expected] of runtimes) {
    const version = miseVersion(key);
    if (!version) {
      fail(`mise.toml must pin the ${key} runtime`);
      continue;
    }
    if (!haystack.includes(expected(version))) {
      fail(
        `tool-version drift: mise.toml ${key}=${version} but its CI/package pin disagrees (expected "${expected(version)}")`,
      );
    }
  }

  const tools = [
    [
      "semgrep",
      [
        [workflows, /SEMGREP_VERSION: "([^"]+)"/g],
        [workflows, /semgrep==([0-9][^"\s]*)/g],
      ],
    ],
    ["ruff", [[workflows, /ruff==([0-9][^"\s]*)/g]]],
    ["golangci-lint", [[workflows, /golangci-lint@v([0-9][^"\s]*)/g]]],
    ["gofumpt", [[workflows, /gofumpt@v([0-9][^"\s]*)/g]]],
    [
      "ast-grep",
      [
        [workflows, /@ast-grep\/cli@([0-9][^"\s]*)/g],
        [vkPkg, /"@ast-grep\/cli": "([^"]+)"/g],
      ],
    ],
    ["oxlint", [[vkPkg, /"oxlint": "([^"]+)"/g]]],
    ["lefthook", [[rootPkg, /"lefthook": "\^?([^"]+)"/g]]],
  ];
  for (const [tool, sources] of tools) {
    const versions = new Set(
      sources.flatMap(([text, pattern]) =>
        [...text.matchAll(pattern)].map((match) => match[1]),
      ),
    );
    if (versions.size === 0)
      fail(`${tool} must be pinned in CI or package.json`);
    else if (versions.size > 1)
      fail(
        `tool-version drift: ${tool} is pinned at ${[...versions].join(", ")}; pin one version everywhere`,
      );
  }

  // uv version must be pinned INSIDE a setup-uv block (a generic `version:`
  // match anywhere could collide with another action's version).
  const uv = miseVersion("uv");
  if (uv) {
    const setupUvScoped = new RegExp(
      String.raw`astral-sh/setup-uv@[^\n]*\n(?:[^\n]*\n){0,5}?[^\n]*version:\s*"${uv.replace(/\./g, "\\.")}"`,
    );
    if (!setupUvScoped.test(workflows)) {
      fail(
        `tool-version drift: mise.toml uv=${uv} not pinned as version: "${uv}" within a setup-uv block`,
      );
    }
  }
  const k6 = miseVersion("k6");
  if (k6 && !workflows.includes(`k6-version: v${k6}`)) {
    fail(
      `tool-version drift: mise.toml k6=${k6} not pinned as "k6-version: v${k6}"`,
    );
  }
  // node accepts both scalar (`node-version: 22`) and matrix (`[22, 24]`) forms.
  const node = miseVersion("node");
  if (node) {
    const scalarOrMatrix = new RegExp(
      `node-version:\\s*(?:"?${node}"?\\s*$|\\[[^\\]]*\\b${node}\\b[^\\]]*\\])`,
      "m",
    );
    if (!scalarOrMatrix.test(workflows)) {
      fail(
        `tool-version drift: mise.toml node=${node} but no workflow pins "node-version: ${node}"`,
      );
    }
  }
  const go = miseVersion("go");
  if (go) {
    const minor = go.split(".").slice(0, 2).join(".");
    if (
      !new RegExp(`go-version:\\s*"${minor.replace(".", "\\.")}"`).test(
        workflows,
      )
    ) {
      fail(
        `tool-version drift: mise.toml go=${go} (major.minor ${minor}) not pinned in setup-go go-version`,
      );
    }
  }
}

validateToolVersionDrift();

// `pnpm -r run <script>` silently SKIPS workspace packages that don't define
// the script — a new package without test/typecheck would leave `quality`
// green while never being tested. Every workspace package must define both.
function validateWorkspaceScriptCoverage() {
  const wsYaml = readFileSync("pnpm-workspace.yaml", "utf8");
  const patterns = [...wsYaml.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue;
    const base = pattern.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(base, entry.name, "package.json");
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue;
      }
      for (const script of ["test", "typecheck"]) {
        if (typeof pkg.scripts?.[script] !== "string") {
          fail(
            `${pkgPath}: workspace package must define a "${script}" script — pnpm -r run ${script} silently skips packages without it, so quality would stay green with this package unchecked`,
          );
        }
      }
    }
  }
}
validateWorkspaceScriptCoverage();

// The preflight before a push (scripts/verify-clean.sh --ci) concludes here
// what CI's push jobs would conclude, so each command a push job runs must be
// a line the preflight runs too, with the env the step sees in front and its
// working directory. A job no local run can stand in for (another OS, a
// container, other matrix legs) is named with `left`, and the preflight
// prints it. Setup is the machine's own (doctor checks it): action steps,
// steps named Install, and inside a step only exact plumbing forms.
function validatePreflightMirror() {
  const preflightPath = "scripts/verify-clean.sh";
  const preflight = readFileSync(preflightPath, "utf8");
  const commands = new Set(
    [...preflight.matchAll(/^\s*run "(.*)"$/gm)].map((m) => m[1]),
  );
  const leftToCi = new Set(
    [...preflight.matchAll(/^\s*left "([^"]+)"/gm)].map((m) => m[1]),
  );
  const plumbing =
    /^(?:(?:export )?\w+=(?:"[^"`]*"|[^\s;&|`]*)|go install \S+|git fetch [^;&|`]*?(?: \|\| true)?)$/;
  const pushJobs = new Set();
  for (const file of workflowFiles) {
    const doc = parseYamlDocument(readFileSync(file, "utf8"));
    const push = doc?.on?.push;
    // A push to main starts it: a bare `push:`, or branches naming main.
    if (
      push === undefined ||
      (push !== null && !(push.branches ?? []).includes("main"))
    )
      continue;
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      const key = `${file.split("/").pop()}#${id}`;
      pushJobs.add(key);
      const elsewhere =
        !String(job?.["runs-on"] ?? "").startsWith("ubuntu") ||
        job?.container !== undefined;
      if ((elsewhere || job?.strategy?.matrix) && !leftToCi.has(key))
        fail(
          `${key}: the preflight cannot stand in for it (another OS, a container or other matrix legs): name it with \`left\` in ${preflightPath}`,
        );
      if (elsewhere) continue;
      for (const step of job?.steps ?? []) {
        if (typeof step?.run !== "string") continue;
        if (/^Install\b/.test(step.name ?? "")) continue;
        // An env value CI computes (`${{ }}`) is the caller's here.
        const env = Object.entries({
          ...doc.env,
          ...job.env,
          ...step.env,
        }).map(([name, value]) =>
          String(value).includes("${{")
            ? `${name}=\${${name}:-}`
            : `${name}=${value}`,
        );
        const dir =
          step["working-directory"] ??
          job.defaults?.run?.["working-directory"] ??
          doc.defaults?.run?.["working-directory"];
        for (const line of step.run.split("\n")) {
          const command = line.replace(/(?:^|\s)#.*$/, "").trim();
          if (command === "" || plumbing.test(command)) continue;
          const run = [...env, command].join(" ");
          const expected = dir === undefined ? run : `cd ${dir} && ${run}`;
          if (!commands.has(expected))
            fail(
              `${key}: the preflight does not run \`${expected}\`: add \`run "${expected}"\` to ${preflightPath}, or name the job with \`left\``,
            );
        }
      }
    }
  }
  for (const key of leftToCi)
    if (!pushJobs.has(key))
      fail(`${preflightPath}: left "${key}" names no job a push to main runs`);
}
validatePreflightMirror();

const workflowCheck = packageJson.scripts?.["workflow:check"];
if (
  typeof workflowCheck !== "string" ||
  !/github\.com\/rhysd\/actionlint\/cmd\/actionlint@v\d+\.\d+\.\d+\b/.test(
    workflowCheck,
  )
) {
  fail("package.json: workflow:check must pin actionlint to an explicit tag");
}

if (failed) {
  process.exit(1);
}

console.log(
  `validate-workflows: ${checkedFiles.length} files ok (workflow policy)`,
);
