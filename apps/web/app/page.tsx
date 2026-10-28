// BUILD: App Router home (server component) rendering the UserList client component.
import { UserList } from "../components/UserList";

export default function HomePage(): React.JSX.Element {
  return (
    <main>
      <h1>Users</h1>
      <UserList />
    </main>
  );
}
