// BUILD: App Router /login page rendering the LoginForm client component.
import { LoginForm } from "../../components/LoginForm";

export default function LoginPage(): React.JSX.Element {
  return (
    <main>
      <h1>Sign in</h1>
      <LoginForm />
    </main>
  );
}
