import { z } from 'zod';

/**
 * Body of `POST /api/verify-turnstile`.
 *
 * `z.object` — not `z.strictObject` — is deliberate. `validate()` REPLACES
 * `req.body` with the parsed result, and a plain object schema DROPS unknown
 * keys, so a client cannot smuggle extra fields past the handler. Rejecting
 * unknown keys instead would turn a harmless extra field into a 400 while adding
 * nothing, since no other field is ever read.
 *
 * `max(4096)` bounds the string that reaches the outbound Siteverify body. A real
 * Cloudflare token is far shorter; this is a generous ceiling that still stops an
 * unbounded value being forwarded to a third party.
 */
export const MAX_TURNSTILE_TOKEN_LENGTH = 4096;

export const verifyTurnstileSchema = z.object({
    token: z
        .string()
        .min(1, 'Token is required')
        .max(
            MAX_TURNSTILE_TOKEN_LENGTH,
            `Token must be ${MAX_TURNSTILE_TOKEN_LENGTH} characters or fewer`
        ),
});

export type VerifyTurnstileInput = z.infer<typeof verifyTurnstileSchema>;
