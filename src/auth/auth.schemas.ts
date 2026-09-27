import { z } from 'zod';

/**
 * Auth request schemas.
 *
 * Shape only — types and required-presence. Rules that already produce a 400 of
 * their own stay in the controller so their wording is unchanged: the password
 * length policy (`MIN_PASSWORD_LENGTH`) and the account-exists 409.
 *
 * `email` is deliberately never validated as an email address here. The admin
 * client sends its login identifier in an `email` field and that value may be a
 * username, so any format rule would break admin logins (see `LoginCredentials`
 * in `mioralane-admin/lib/types/auth.ts`). Email-format enforcement is tracked
 * as a separate backlog decision.
 */

export const registerUserSchema = z.object({
    username: z.string().min(3),
    email: z.string().min(1),
    // Length is enforced by the controller so the response keeps its specific
    // wording instead of the generic validation envelope.
    password: z.string().min(1),
});

/**
 * Username OR email identifies the account, so both are optional and the
 * refinement requires at least one — mirroring the controller's
 * `username ?? email` behaviour.
 */
export const loginUserSchema = z
    .object({
        username: z.string().min(1).optional(),
        email: z.string().min(1).optional(),
        password: z.string().min(1),
    })
    .refine((value) => value.username !== undefined || value.email !== undefined, {
        message: 'Username or email is required',
        path: ['username'],
    });

export const googleLoginSchema = z.object({
    credential: z.string().min(1),
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;
export type LoginUserInput = z.infer<typeof loginUserSchema>;
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;
