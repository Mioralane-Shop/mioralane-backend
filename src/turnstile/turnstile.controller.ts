import { Request, Response } from 'express';
import { verifyTurnstile } from './turnstile.service';
import type { VerifyTurnstileInput } from './turnstile.schemas';

/**
 * `POST /api/verify-turnstile` — public.
 *
 * The route's `validate({ body: verifyTurnstileSchema })` guarantees `token` is a
 * non-empty string before this runs, so the schema stays the owner of that
 * contract. The `typeof` guard below is a SECOND layer, not a duplicate: with the
 * schema removed the request must fail loudly instead of reaching Siteverify with
 * `undefined` (which would silently forward a malformed body to a third party).
 *
 * The service never throws, so a Cloudflare outage cannot turn into a 500 here.
 * Only the response body carries `success`; verification internals (`reason`) are
 * included for operational debugging and are never sensitive.
 */
export const verifyTurnstileHandler = async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body as VerifyTurnstileInput;

    if (typeof token !== 'string') {
        throw new Error('A Turnstile token is required');
    }

    const result = await verifyTurnstile(token);

    res.json({ success: result.success, reason: result.reason });
};
