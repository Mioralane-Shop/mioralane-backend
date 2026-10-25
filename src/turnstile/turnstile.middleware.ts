import type { Request, RequestHandler } from 'express';
import { verifyTurnstile } from './turnstile.service';

/**
 * Turnstile enforcement for state-changing routes.
 *
 * `POST /api/verify-turnstile` only *offers* a verdict; nothing changes until a
 * route actually depends on one. This middleware is that dependency: it turns the
 * client's solved challenge into a precondition for registration, sign-in, Google
 * sign-in, checkout, review submission and address creation.
 *
 * ## Ordering, and why this runs last
 *
 * On every protected route this is mounted AFTER `protect` and `validate`, i.e.
 * immediately before the controller. Two consequences, both deliberate:
 *
 *   1. **No verification is spent on a request that is already refused.** An
 *      unauthenticated or malformed request is answered by the cheaper guard
 *      first, so an attacker cannot make the API spend a Cloudflare round trip
 *      (and our Siteverify quota) on junk.
 *   2. **Every existing 400 keeps its exact precedence and wording.** `validate`
 *      still answers a bad body before anything here runs, so this adds a
 *      refusal path without perturbing the existing contract.
 *
 * ## Failure policy
 *
 * - **No secret configured** → warn once and pass through. That is the same
 *   dev/preview escape hatch `verifyTurnstile` uses, and it is what lets the CI
 *   harnesses (which never load `.env`) run unchanged.
 * - **Token missing** → `400 TURNSTILE_MISSING`.
 * - **Token rejected, expired, already redeemed, or Siteverify unreachable** →
 *   `400 TURNSTILE_FAILED`. This is deliberately fail-CLOSED for a transport
 *   failure: while Cloudflare is unreachable, writes are refused rather than
 *   silently unprotected. The trade-off is explicit — a Siteverify outage blocks
 *   sign-in and checkout — and is recorded in the report.
 *
 * The token is never logged, and the Siteverify `reason` is never echoed: the
 * client gets a stable code it can branch on and nothing about our internals.
 */

/** Header the clients send. Must be in the API's CORS allowlist. */
export const TURNSTILE_TOKEN_HEADER = 'X-Turnstile-Token';

/** `code` values the clients branch on (see `lib/turnstile.ts` in both clients). */
export const TURNSTILE_MISSING_CODE = 'TURNSTILE_MISSING';
export const TURNSTILE_FAILED_CODE = 'TURNSTILE_FAILED';

/** Exact wording returned with each code. */
export const TURNSTILE_MISSING_MESSAGE = 'Security check required';
export const TURNSTILE_FAILED_MESSAGE = 'Security check failed';

/** The header value, or `null` when it is absent or blank. */
const readToken = (req: Request): string | null => {
    const raw = req.get(TURNSTILE_TOKEN_HEADER);

    if (typeof raw !== 'string') {
        return null;
    }

    const trimmed = raw.trim();

    return trimmed.length > 0 ? trimmed : null;
};

export const requireTurnstile: RequestHandler = async (req, res, next) => {
    const secret = process.env.TURNSTILE_SECRET_KEY;

    if (secret === undefined || secret.trim() === '') {
        console.warn(
            `[turnstile] TURNSTILE_SECRET_KEY is not set — skipping the security check on ${req.method} ${req.originalUrl}`
        );

        next();
        return;
    }

    const token = readToken(req);

    if (token === null) {
        res.status(400).json({
            success: false,
            message: TURNSTILE_MISSING_MESSAGE,
            code: TURNSTILE_MISSING_CODE,
        });
        return;
    }

    const result = await verifyTurnstile(token);

    if (!result.success) {
        res.status(400).json({
            success: false,
            message: TURNSTILE_FAILED_MESSAGE,
            code: TURNSTILE_FAILED_CODE,
        });
        return;
    }

    next();
};
