// Layer 12 performance smoke against the api's GET /users.
// Run: `API_URL=http://localhost:3001 k6 run perf/k6/users-smoke.js`.
// Install k6 via `brew install k6` or mise.
import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 5,
  duration: "10s",
  thresholds: {
    http_req_duration: ["p(95)<200"],
    http_req_failed: ["rate<0.01"],
  },
};

const API = __ENV.API_URL || "http://localhost:3001";

export default function usersSmoke() {
  const res = http.get(`${API}/users`);
  check(res, {
    "status is 200": (r) => r.status === 200,
    "content type is json": (r) =>
      r.headers["Content-Type"]?.includes("application/json") === true,
    "body has users": (r) => {
      try {
        const body = r.json();
        return (
          Array.isArray(body) &&
          body.length > 0 &&
          body.every(
            (user) =>
              typeof user === "object" &&
              user !== null &&
              typeof user.id === "number" &&
              typeof user.email === "string",
          )
        );
      } catch {
        return false;
      }
    },
  });
}
