// BUILD: global test setup. Adds jest-dom matchers and runs the MSW server
// for the whole Vitest process. Imported via vitest.config.ts setupFiles.
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";
import { handlers } from "./test/msw/handlers";

export const server = setupServer(...handlers);

// Fail loud on any request that no handler matched, instead of leaking to the
// real network and producing a confusing async failure.
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
