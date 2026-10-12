#!/usr/bin/env bash
#
# Regenerate the Playwright visual baseline (apps/web/e2e/visual.spec.ts-snapshots/)
# INSIDE the same pinned Playwright container CI runs in (see .github/workflows/e2e.yml
# `container:`), so the committed PNG is Linux/noble-rendered and matches CI
# byte-for-byte. NEVER regenerate on a dev machine's host OS — a macOS/Windows
# render will not match the Linux CI render and the gate will flap.
#
# Usage:  bash scripts/update-visual-baseline.sh   (or: pnpm run baseline:update)
# Requires: Docker. Keep IMAGE in sync with apps/web @playwright/test version.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.61.0-noble@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a"
REPO="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'docker run --rm -v "$TMP":/t alpine:3@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b sh -c "rm -rf /t/* /t/.* 2>/dev/null || true"; rmdir "$TMP" 2>/dev/null || true' EXIT

echo "==> Staging source into $TMP (excluding node_modules/.git/build output)"
rsync -a \
  --exclude 'node_modules' --exclude '.git' --exclude '.next' \
  --exclude 'dist' --exclude 'target' --exclude 'test-results' \
  --exclude 'playwright-report' --exclude 'coverage' \
  "$REPO/" "$TMP/"

echo "==> Regenerating + verifying baseline in $IMAGE"
docker run --rm -v "$TMP":/work -w /work -e CI= "$IMAGE" bash -lc '
  set -e
  corepack enable && corepack prepare pnpm@10.23.0 --activate
  pnpm install --frozen-lockfile
  pnpm --filter web exec playwright install chromium
  pnpm --filter web run build
  rm -f apps/web/e2e/visual.spec.ts-snapshots/login.png
  pnpm --filter web exec playwright test e2e/visual.spec.ts --update-snapshots=all
  pnpm --filter web exec playwright test e2e/visual.spec.ts   # gate against the fresh baseline
'

echo "==> Copying regenerated baseline back into the repo"
cp "$TMP/apps/web/e2e/visual.spec.ts-snapshots/login.png" \
   "$REPO/apps/web/e2e/visual.spec.ts-snapshots/login.png"
echo "==> Done. Review the diff and commit apps/web/e2e/visual.spec.ts-snapshots/login.png"
