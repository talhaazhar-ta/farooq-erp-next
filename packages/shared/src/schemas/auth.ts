import { z } from "zod";
import { ROLES } from "../permissions.js";

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.string().nullable(),
  name: z.string(),
  username: z.string(),
  role: z.enum(ROLES),
  active: z.boolean(),
  createdAt: z.coerce.date(),
});
export type User = z.infer<typeof userSchema>;

export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: z.enum(ROLES),
  csrfToken: z.string(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
