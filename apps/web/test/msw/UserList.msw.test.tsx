// BUILD: MSW integration test. Renders UserList, which fetches /users on mount;
// the global MSW server (vitest.setup.ts) serves the mocked payload. Finding the
// mocked email in the DOM proves component -> fetch -> MSW -> render end to end.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { UserList } from "../../components/UserList";
import { server } from "../../vitest.setup";

describe("<UserList/> with MSW", () => {
  it("renders the email returned by the mocked /users endpoint", async () => {
    render(<UserList />);

    // Loading state shows first.
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    // Then the MSW-mocked user email appears.
    expect(await screen.findByText("a@b.co")).toBeInTheDocument();
  });

  it("says so when the API answers with an error, and shows no list", async () => {
    server.use(
      http.get("*/users", () => new HttpResponse(null, { status: 503 })),
    );
    render(<UserList />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load users.",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
