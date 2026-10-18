// Layout checks a page can fail in any browser, without pixel baselines: what
// the layout engine reports (getBoundingClientRect, getComputedStyle,
// elementFromPoint), plus axe-core's WCAG 2.2 AA rules, whose target-size rule
// is the 24px minimum with the spacing exception WCAG 2.5.8 allows. Each check
// skips what the research found trips a naive version: hidden and 1px
// "visually hidden" elements, off-screen ones, scroll boxes
// (docs/research/lint-toolchain/sota-2026-10-18/web-solidity.md, section 3).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export interface LayoutProblem {
  rule: "x-overflow" | "clipped-text" | "occluded-control";
  /** The element, as `tag#id.class`. */
  target: string;
  detail: string;
}

/** The two widths a page must hold at: a phone and a laptop. */
export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
] as const;

/** WCAG 2.2 AA: the axe rules the page must pass. */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The layout problems on the page as it is now, at its current viewport. */
export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const CONTROLS =
      'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])';
    // page.evaluate sends only this function to the browser, so its helpers
    // live inside it.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
        typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).join(".")}`
          : ""
      }`;
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const shown = (el: Element) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 1 &&
        box.height > 1
      );
    };
    const problems: LayoutProblem[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth)
      problems.push({
        rule: "x-overflow",
        target: "html",
        detail: `the page is ${root.scrollWidth}px wide in a ${window.innerWidth}px viewport, so it scrolls sideways`,
      });
    for (const el of document.body.querySelectorAll("*")) {
      if (el.scrollWidth <= el.clientWidth || !shown(el)) continue;
      const style = getComputedStyle(el);
      // Truncated on purpose, or a box that scrolls or shows its overflow.
      if (style.textOverflow === "ellipsis") continue;
      if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
      const box = el.getBoundingClientRect();
      if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth)
        continue;
      problems.push({
        rule: "clipped-text",
        target: name(el),
        detail: `its content is ${el.scrollWidth}px wide in a ${el.clientWidth}px box that hides the rest`,
      });
    }
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (!shown(el)) continue;
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      // elementFromPoint sees only the viewport.
      if (
        x >= 0 &&
        y >= 0 &&
        x <= window.innerWidth &&
        y <= window.innerHeight
      ) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== el && !el.contains(hit))
          problems.push({
            rule: "occluded-control",
            target: name(el),
            detail: `${name(hit)} covers its centre, so a click lands on that instead`,
          });
      }
    }
    return problems;
  });
}

/** The page has no layout problem and passes axe's WCAG 2.2 AA rules. */
export async function expectCleanLayout(page: Page): Promise<void> {
  expect(await layoutProblems(page)).toEqual([]);
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG)
    .analyze();
  expect(
    violations.map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}
