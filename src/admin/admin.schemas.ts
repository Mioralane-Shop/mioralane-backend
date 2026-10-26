import { z } from 'zod';

/**
 * Admin auth request schemas — shape only.
 *
 * `email` is not format-checked on login (consistent with the customer login
 * schema): the admin client sends the identifier in an `email` field and the
 * controller normalizes it. Expiry, attempt counting and the hash comparison stay
 * with the controller/services, where they own their own messages.
 *
 * Bootstrap is different — it *creates* an account, so it asks for a real address
 * and a genuinely strong password.
 */

const challengeIdSchema = z.string().trim().min(16, 'Invalid login challenge');

export const adminLoginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

export const verifyAdminOtpSchema = z.object({
  challengeId: challengeIdSchema,
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

export const resendAdminOtpSchema = z.object({
  challengeId: challengeIdSchema,
});

/**
 * Minimum 12 characters, and at least three of the four character classes.
 *
 * The one account that can create further admins must not be protected by a
 * password that survives a dictionary attack; a length floor alone allows
 * `aaaaaaaaaaaa`, and a class rule alone allows `Aa1!` (short and guessable), so
 * both are required.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

const passwordClasses = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

export const adminBootstrapSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z
    .string()
    .min(
      MIN_ADMIN_PASSWORD_LENGTH,
      `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`
    )
    .refine(
      (value) => passwordClasses.filter((pattern) => pattern.test(value)).length >= 3,
      'Password must combine at least three of: lowercase, uppercase, number, symbol'
    ),
  name: z.string().trim().min(1).max(120).optional(),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type VerifyAdminOtpInput = z.infer<typeof verifyAdminOtpSchema>;
export type ResendAdminOtpInput = z.infer<typeof resendAdminOtpSchema>;
export type AdminBootstrapInput = z.infer<typeof adminBootstrapSchema>;
