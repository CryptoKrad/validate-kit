// BUILD: MSW integration test. Renders UserList, which fetches /users on mount;
// the global MSW server (vitest.setup.ts) serves the mocked payload. Finding the
// mocked email in the DOM proves component -> fetch -> MSW -> render end to end.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserList } from "../../components/UserList";

describe("<UserList/> with MSW", () => {
  it("renders the email returned by the mocked /users endpoint", async () => {
    render(<UserList />);

    // Loading state shows first.
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    // Then the MSW-mocked user email appears.
    expect(await screen.findByText("a@b.co")).toBeInTheDocument();
  });
});
