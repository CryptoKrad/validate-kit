// BUILD: component test. Renders LoginForm through both injected-submit and
// default api-client paths, then asserts typed credentials are preserved.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { LoginForm, type LoginValues } from "../../components/LoginForm";
import { server } from "../../vitest.setup";

describe("<LoginForm/>", () => {
  it("calls onSubmit with the typed email and password", async () => {
    const onSubmit = vi.fn<(values: LoginValues) => void>();
    const user = userEvent.setup();

    render(<LoginForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "s3cret",
    });
  });

  it("posts the typed credentials through the default api-client submit path", async () => {
    const loginBodies: unknown[] = [];
    const user = userEvent.setup();

    server.use(
      http.post("*/login", async ({ request }) => {
        loginBodies.push(await request.json());
        return HttpResponse.json({ token: "test-token" });
      }),
    );

    render(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(loginBodies).toContainEqual({
        email: "user@example.com",
        password: "s3cret",
      });
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Signed in");
  });

  it("renders an error when the default api-client submit rejects", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();

    try {
      server.use(
        http.post("*/login", () => {
          return HttpResponse.json(
            { error: "invalid credentials" },
            { status: 401 },
          );
        }),
      );

      render(<LoginForm />);

      await user.type(screen.getByLabelText("Email"), "user@example.com");
      await user.type(screen.getByLabelText("Password"), "bad-password");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Sign in failed",
      );
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
