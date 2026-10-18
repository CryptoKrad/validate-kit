// Each page holds its layout at a phone and a laptop width, and passes axe's
// WCAG 2.2 AA rules; the planted page proves the checks can fail.
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectCleanLayout, layoutProblems, VIEWPORTS } from "./layout";

/** On one page, in turn: a phone, then a laptop. */
async function holdsLayout(page: Page, path: string): Promise<void> {
  const at = async (viewport: (typeof VIEWPORTS)[number]) => {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expectCleanLayout(page);
  };
  await at(VIEWPORTS[0]);
  await at(VIEWPORTS[1]);
}

test("/ holds its layout on a phone and a laptop", async ({ page }) => {
  await holdsLayout(page, "/");
});

test("/login holds its layout on a phone and a laptop", async ({ page }) => {
  await holdsLayout(page, "/login");
});

test("the layout checks catch each planted problem", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS[0]);
  await page.setContent(`
    <header style="position:fixed;top:0;left:0;right:0;height:60px;z-index:10;background:#fff">h</header>
    <main>
      <button id="covered" style="position:absolute;top:20px;left:10px;width:80px;height:44px">Pay</button>
      <button id="clip" style="position:absolute;top:120px;width:80px;height:44px;overflow:hidden;white-space:nowrap">Continue to checkout now</button>
      <button id="a" style="position:absolute;top:200px;left:10px;width:16px;height:16px">a</button>
      <button id="b" style="position:absolute;top:200px;left:28px;width:16px;height:16px">b</button>
      <div style="width:600px;height:10px"></div>
      <a class="skip" href="#main" style="position:absolute;width:1px;height:1px;overflow:hidden">Skip to content</a>
      <p style="margin-top:300px">Read the <a href="/terms">terms</a> first.</p>
    </main>`);
  expect(
    (await layoutProblems(page)).map(
      (problem) => `${problem.rule} ${problem.target}`,
    ),
  ).toEqual([
    "x-overflow html",
    "clipped-text button#clip",
    "occluded-control button#covered",
  ]);
  // Two 16px buttons 2px apart: under 24px, with no room around them.
  const { violations } = await new AxeBuilder({ page })
    .withRules(["target-size"])
    .analyze();
  expect(
    violations.flatMap((v) => v.nodes.map((node) => node.target.join(" "))),
  ).toEqual(["#a", "#b"]);
});
