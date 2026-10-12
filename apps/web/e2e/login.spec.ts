// BUILD: end-to-end login flow. Playwright's webServer in playwright.config.ts
// starts the production web app; run `pnpm --filter web run e2e` from the repo
// root.
import { test, expect } from "@playwright/test";

test("submits credentials and renders login success", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByLabel("Password").fill("password");

  const submit = page.getByRole("button", { name: "Sign in" });
  const loginResponsePromise = page.waitForResponse((response) => {
    return (
      response.url() === "http://localhost:3001/login" &&
      response.request().method() === "POST"
    );
  });

  await expect(submit).toBeVisible();
  await submit.click();

  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  expect(loginResponse.request().postDataJSON()).toEqual({
    email: "alice@example.com",
    password: "password",
  });
  const body = (await loginResponse.json()) as { token?: unknown };
  expect(typeof body.token).toBe("string");
  expect((body.token as string).length).toBeGreaterThan(0);
  await expect(page.getByRole("status")).toHaveText("Signed in");
});
