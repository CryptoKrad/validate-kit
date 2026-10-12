// BUILD: MSW v2 request handlers shared by the global setup and per-test overrides.
// Wildcard host (`*/users`) matches regardless of NEXT_PUBLIC_API_URL base.
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("*/users", () => {
    return HttpResponse.json([{ id: 1, email: "a@b.co" }]);
  }),
  http.post("*/login", () => {
    return HttpResponse.json({ token: "test-token" });
  }),
];
