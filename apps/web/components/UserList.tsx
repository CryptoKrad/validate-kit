// BUILD: client component. Fetches /users on mount and renders emails.
// MSW-mocked render is proven in test/msw/UserList.msw.test.tsx.
"use client";

import { useEffect, useState } from "react";
import { getUsers, type User } from "../lib/api-client";

type Status = "loading" | "ready" | "error";

export function UserList(): React.JSX.Element {
  const [users, setUsers] = useState<User[]>([]);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let active = true;
    getUsers()
      .then((data) => {
        if (!active) return;
        setUsers(data);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  if (status === "loading") {
    return <p role="status">Loading users…</p>;
  }
  if (status === "error") {
    return <p role="alert">Failed to load users.</p>;
  }

  return (
    <ul aria-label="User list">
      {users.map((u) => (
        <li key={u.id}>{u.email}</li>
      ))}
    </ul>
  );
}

export default UserList;
