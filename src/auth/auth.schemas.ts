import { z } from 'zod';

/**
 * Auth request schemas.
 *
 * Shape, required-presence and the password minimum are declared here. The
 * controller keeps its `MIN_PASSWORD_LENGTH` guard as defence in depth, and the
 * account-exists 409 stays there because it needs a database lookup.
 *
 * `email` is deliberately never validated as an email address in the login
 * schema. The admin client sends its login identifier in an `email` field and
 * that value may be a username, so any format rule would break admin logins.
 * The register field keeps its presence-only rule for the same compatibility
 * reason; the storefront validates the format client-side.
 */

export const registerUserSchema = z.object({
    username: z.string().min(3),
    email: z.string().min(1),
    // The only password rule: eight characters. No character-class regex.
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * Username OR email identifies the account, so both are optional and the
 * refinement requires at least one — mirroring the controller's
 * `username ?? email` behaviour.
 *
 * Login keeps its presence-only password rule: existing accounts may predate
 * the eight-character minimum and must still be able to sign in.
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

/**
 * Forgot-password asks for a real email address and normalizes it before the
 * lookup. Unlike login, the value cannot be a username, so a format check is
 * safe here.
 */
export const forgotPasswordSchema = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
});

/** Reset-password: the new password has a documented eight-character minimum. */
export const resetPasswordSchema = z.object({
    token: z.string().min(1),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;
export type LoginUserInput = z.infer<typeof loginUserSchema>;
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
