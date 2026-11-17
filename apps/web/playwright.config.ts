// BUILD: Playwright config. Boots the production web app and the DB-free API
// seed server, then drives Chromium against the real browser-to-API path.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The retry is there to leave a trace, not to make the run pass: a test
  // that passes only on a retry is flaky, and the run fails.
  failOnFlakyTests: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:3000",
    // What a failing run leaves to read (apps/web/test-results/): the page as
    // it was, and in CI, where a failure is retried, the steps that led there.
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    // Determinism for visual regression. The baseline is generated and gated
    // inside the same pinned Playwright container CI runs in (see e2e.yml
    // `container:`), so OS/font rendering matches byte-for-byte. The Desktop
    // Chrome device already fixes viewport (1280x720) + deviceScaleFactor (1);
    // toHaveScreenshot() already defaults animations:disabled + caret:hide.
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "light",
  },
  webServer: [
    {
      name: "web",
      command: "npm run start",
      url: "http://localhost:3000",
      cwd: ".",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      name: "api",
      command: "npm run start",
      url: "http://localhost:3001/users",
      cwd: "../api",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
