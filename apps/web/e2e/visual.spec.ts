// BUILD (minimal): visual regression snapshot of the /login page.
//
// The baseline is generated and gated INSIDE the pinned Playwright container
// (mcr.microsoft.com/playwright:v1.61.0-noble — see .github/workflows/e2e.yml
// `container:`), so the local generation environment matches CI byte-for-byte
// (same OS, same fonts, same Chromium). Never regenerate on a dev machine; run
// the `update-visual-baseline` workflow_dispatch, review the diff, and let it
// commit the regenerated PNG. Determinism knobs live in playwright.config.ts.
//
// Alternatives to repo-committed baselines: Chromatic or Percy host the
// baselines and run cross-browser visual diffing as a managed service — prefer
// those when baseline drift across machines becomes a maintenance burden.
import { test, expect } from "@playwright/test";

test("login page matches the visual baseline", async ({ page }) => {
  await page.goto("/login");
  // Wait for fonts + layout to settle so anti-aliasing is stable before the shot.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page).toHaveScreenshot("login.png", {
    maxDiffPixelRatio: 0.01,
  });
});
