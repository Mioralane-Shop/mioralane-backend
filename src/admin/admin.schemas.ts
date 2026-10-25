import { z } from 'zod';

/**
 * Admin auth request schemas — shape only.
 *
 * `email` is not format-checked as an email address here (consistent with the
 * customer login schema): the admin client sends the identifier in an `email`
 * field and the controller normalizes it. Expiry, attempt counting and the
 * hash comparison stay with the controller, where they keep their own
 * messages.
 */

export const adminLoginSchema = z.object({
    email: z.string().min(1),
    password: z.string().min(1),
});

export const verifyAdminOtpSchema = z.object({
    email: z.string().min(1),
    otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type VerifyAdminOtpInput = z.infer<typeof verifyAdminOtpSchema>;
