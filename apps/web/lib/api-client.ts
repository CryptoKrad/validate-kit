// BUILD: production API client. Pure-ish fetch wrappers around the backend API.
// MSW intercepts fetch() to these URLs in tests (see test/msw/handlers.ts).
//
// Response shapes are validated with the SHARED contract schemas (packages/
// contracts), the exact same objects the provider validates its responses
// against — so consumer and provider cannot disagree within a commit.
import {
  LoginResultSchema,
  UsersSchema,
  type LoginResult,
  type User,
} from "contracts";

export type { User, LoginResult } from "contracts";

/**
 * Resolve the API base URL. Reads NEXT_PUBLIC_API_URL at call time (not module
 * load) so tests can mutate process.env before invoking. Trailing slashes are
 * trimmed so callers can always join with a leading-slash path.
 */
export function apiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return raw.replace(/\/+$/, "");
}

export async function getUsers(): Promise<User[]> {
  const res = await fetch(`${apiBase()}/users`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`getUsers failed: ${res.status}`);
  }
  return UsersSchema.parse(await res.json());
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const res = await fetch(`${apiBase()}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status}`);
  }
  return LoginResultSchema.parse(await res.json());
}
