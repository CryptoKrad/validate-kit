// BUILD: the single source of truth for the Web<->API contract. Imported by
// BOTH apps/api (validates outgoing responses + incoming login body) and
// apps/web (validates incoming responses), so the two sides CANNOT disagree
// within a commit. Cross-commit breaking changes are caught by the oasdiff gate.
import { z } from "zod";

export const UserSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
});

export const UsersSchema = z.array(UserSchema);

// .strict(): the published contract (openapi.json) has additionalProperties:
// false, so an unknown field is a 400, not silently dropped.
export const LoginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const LoginResultSchema = z.object({
  token: z.string().min(1),
});

export type User = z.infer<typeof UserSchema>;
export type Users = z.infer<typeof UsersSchema>;
export type LoginBody = z.infer<typeof LoginBodySchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
