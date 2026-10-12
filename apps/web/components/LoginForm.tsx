// BUILD: client component. Component-test + e2e target.
"use client";

import { useState } from "react";
import { login } from "../lib/api-client";

export interface LoginValues {
  email: string;
  password: string;
}

export interface LoginFormProps {
  /**
   * Optional submit handler. Defaults to calling the api-client `login()`.
   * The component test injects a spy here to assert on the typed values
   * without touching the network.
   */
  onSubmit?: (values: LoginValues) => void;
}

type LoginStatus = "idle" | "submitting" | "success" | "error";

export function LoginForm({ onSubmit }: LoginFormProps): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<LoginStatus>("idle");

  function clearStatus(): void {
    if (status !== "idle") setStatus("idle");
  }

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const values: LoginValues = { email, password };
    if (onSubmit) {
      onSubmit(values);
      return;
    }
    setStatus("submitting");
    void login(values.email, values.password)
      .then(() => {
        setStatus("success");
      })
      .catch((err: unknown) => {
        console.error("login failed", err);
        setStatus("error");
      });
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Login form">
      <div>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            clearStatus();
          }}
        />
      </div>
      <div>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            clearStatus();
          }}
        />
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        aria-busy={status === "submitting"}
      >
        Sign in
      </button>
      {status === "submitting" ? <p role="status">Signing in...</p> : null}
      {status === "success" ? <p role="status">Signed in</p> : null}
      {status === "error" ? <p role="alert">Sign in failed</p> : null}
    </form>
  );
}

export default LoginForm;
