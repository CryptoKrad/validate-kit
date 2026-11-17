---
name: verify
description: Prove a change to the web app by running it - build it, boot it with the API, and drive the flow the change touches in a real browser. Use after any change under apps/web, before the commit.
---

# Verify a change to the web app

Run the app and look at it. A passing component test is not this: it can pass while the page is
broken.

1. Find the row of the feature map for what changed. A change with no row gets a row first.
2. Run its end-to-end test. Playwright builds nothing; it boots the web app on port 3000 and the
   API on port 3001 itself, and stops them:

   ```bash
   pnpm --filter web run build
   pnpm --filter web exec playwright test e2e/login.spec.ts e2e/layout.spec.ts
   ```

   About 7 seconds with the build. A failure names the step and leaves a screenshot and the page's state under
   `apps/web/test-results/` (and a trace in CI, where a failure is retried): read those before the code.

3. Look at the page yourself when the change is visible. Start both servers, open the path in
   the Claude Chrome extension, and compare with the "A pass shows" column:

   ```bash
   pnpm --filter api run start &   # http://localhost:3001
   pnpm --filter web run start     # http://localhost:3000
   ```

4. A new flow is seen failing once: break the change, run the row again, restore the change.

The visual baselines (`e2e/visual.spec.ts`) are rendered in CI's Linux container. Do not update
them from this machine; the `e2e` workflow on the public mirror is where they are judged.

## Feature map

What a user can do, where, and what a pass shows. It is the rubric for a change to this app.

| Feature           | Path          | Find it by                                                      | A pass shows                                                                                  | Test                                |
| ----------------- | ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| See the users     | `/`           | heading "Users"; list labelled "User list"                      | `alice@example.com` and `bob@example.com` from `GET /users`                                   | `test/msw/UserList.msw.test.tsx`    |
| Users are loading | `/`           | `role="status"`                                                 | "Loading users…" until the API answers                                                        | none yet: look at it in the browser |
| The API is down   | `/`           | `role="alert"`                                                  | "Failed to load users."                                                                       | none yet: stop the API and look     |
| Sign in           | `/login`      | heading "Sign in"; fields "Email", "Password"; button "Sign in" | `POST http://localhost:3001/login` answers 200 with a token; `role="status"` says "Signed in" | `e2e/login.spec.ts`                 |
| Sign in refused   | `/login`      | `role="alert"`                                                  | "Sign in failed" when the API answers 401                                                     | `test/component/LoginForm.test.tsx` |
| Phone and laptop  | `/`, `/login` | the page at 390 and 1280 pixels wide                            | nothing overflows sideways, nothing overlaps, every control can be tapped                     | `e2e/layout.spec.ts`                |
