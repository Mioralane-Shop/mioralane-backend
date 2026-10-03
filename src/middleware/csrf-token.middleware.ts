import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { isStateChangingMethod } from './rateLimiter.middleware';

/**
 * HMAC-bound CSRF token (P1.1) — the second CSRF control, alongside the
 * Origin/Referer guard in `csrf.middleware.ts`.
 *
 * ## Why a token at all
 *
 * The auth cookie is issued with `SameSite=None` in production because the
 * storefront (`mioralane.com`), the admin app (`admin.mioralane.com`) and the
 * API (`mioralane-backend.vercel.app`) are three different sites. With
 * `SameSite=None` the browser attaches the cookie to cross-site requests, so
 * the Origin guard is the only thing standing between a forged request and an
 * authenticated write. That guard trusts the `Origin` header; this module means
 * a request also has to prove it knows a value that only a real client of *this
 * session* could have obtained.
 *
 * ## Why not a classic double-submit cookie
 *
 * The textbook design stores the token in a cookie the JS can read and compares
 * it with a header. That is impossible here:
 *
 *   - the cookie would be set by `mioralane-backend.vercel.app`, and JavaScript
 *     on `mioralane.com` cannot read a cookie belonging to another host;
 *   - `vercel.app` is on the Public Suffix List, so `Domain=.vercel.app` is not
 *     settable either — there is no configuration that makes it readable;
 *   - a `SameSite=Lax` CSRF cookie would not be sent cross-site at all, which
 *     would leave the token unverifiable in exactly the production topology.
 *
 * So the token is not compared against a cookie. It is *derived* from the
 * session: `HMAC-SHA256(JWT_SECRET, 'csrf.v1:' + <auth cookie value>)`. The
 * attacker cannot read the httpOnly auth cookie, so it cannot compute the token
 * even though it can freely send its own request. This is a signed
 * synchronizer token, not double-submit, and it is strictly stronger — there is
 * no attacker-injectable cookie and no server-side state.
 *
 * Properties that fall out of the construction:
 *   - **Rotates on login for free** — a new JWT yields a new token, with no
 *     rotation bookkeeping and nothing to invalidate.
 *   - **Looks after itself on logout** — the cookie is cleared, so the token is
 *     unverifiable.
 *   - **Stateless and horizontally scalable** — any instance can recompute it,
 *     so no Redis/session store is needed on Vercel's serverless runtime.
 *   - **Session-bound** — a token minted for session A fails against session B
 *     (asserted in `tests/verify-csrf-token.ts`).
 *
 * ## Policy
 *
 *   - GET/HEAD/OPTIONS and every other non-state-changing method: never checked.
 *   - `Authorization` header present: passed. A cross-site page cannot set that
 *     header — it is not a CORS-safelisted request header, so the browser sends
 *     a preflight first, and `mioralane.com`/`admin.mioralane.com` are the only
 *     origins allowlisted. The Bearer flow (native clients) is therefore
 *     unaffected and needs no token.
 *   - No auth cookie: passed. A cross-site forgery always carries the victim's
 *     cookie — that is what makes it a forgery — so this is not a bypass. It
 *     keeps curl/Postman/uptime checks and unauthenticated requests working,
 *     but a request with no session has nothing to forge *as*.
 *   - Auth-bootstrap paths are exempt ({@link CSRF_EXEMPT_PATHS}): a caller
 *     cannot hold a token before it has a session, and the Origin guard still
 *     covers them. This must stay true even when a *stale* cookie is present,
 *     otherwise a user whose token went stale could never log back in.
 *   - Everything else with a session: `X-CSRF-Token` must match, or 403.
 *
 * The check is purely additive — `csrfOriginGuard` still runs first and is
 * unchanged. Both answer 403 with distinct messages so a log line says which
 * control fired.
 */

/** Header the client echoes the token in. Must be in the CORS allowlist. */
export const CSRF_HEADER = 'X-CSRF-Token';

/** Field name the token is delivered under in auth response bodies. */
export const CSRF_TOKEN_FIELD = 'csrfToken';

/**
 * Distinct from the Origin guard's message on purpose: an operator reading logs
 * or a client deciding whether to re-sync needs to know *which* control fired.
 * Carries no internal detail (no path, no token, no secret).
 */
export const CSRF_INVALID_MESSAGE = 'CSRF token invalid or missing';

const CSRF_INVALID_RESPONSE = {
    success: false,
    message: CSRF_INVALID_MESSAGE,
};

/**
 * Version tag, mixed into the HMAC input. Domain separation from any other use
 * of `JWT_SECRET`, and the seam for rotating every outstanding token later: a
 * bump to `csrf.v2:` invalidates them all without touching the cookie.
 */
const CSRF_SCOPE = 'csrf.v1';

/**
 * Auth-bootstrap endpoints. Session-less by definition, so no token can exist
 * yet. Exact matches (never prefixes) — a prefix rule could be steered with a
 * crafted path, and Express's own router is case-insensitive and tolerates a
 * trailing slash, which the lowering/stripping below mirrors.
 */
const CSRF_EXEMPT_PATHS: readonly string[] = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/google',
];

/**
 * Builds the token for a session, or `null` when it cannot be built (no secret
 * configured, or no session). `null` always means "do not authenticate this
 * request", never "skip the check".
 */
export const createCsrfToken = (sessionToken: string | undefined): string | null => {
    const secret = process.env.JWT_SECRET;

    if (!secret || !sessionToken) {
        return null;
    }

    return createHmac('sha256', secret)
        .update(`${CSRF_SCOPE}:${sessionToken}`)
        .digest('base64url');
};

/** Constant-time comparison; length is checked first because `timingSafeEqual` throws on a mismatch. */
const tokensMatch = (expected: string, provided: string): boolean => {
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);

    if (expectedBuffer.length !== providedBuffer.length) {
        return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
};

/** Path with the query removed, lower-cased and without a trailing slash. */
const normalizedPath = (req: Request): string => {
    const raw = req.originalUrl ?? req.url;
    const queryIndex = raw.indexOf('?');
    const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);

    return path.replace(/\/+$/, '').toLowerCase();
};

const isExemptPath = (req: Request): boolean => CSRF_EXEMPT_PATHS.includes(normalizedPath(req));

/**
 * The session cookie, as `protect` reads it. Exported so the guard and the
 * endpoints that issue a token (`/api/auth/*`, `/api/auth/me`) cannot disagree
 * about what "the session" is.
 */
export const readSessionToken = (req: Request): string | undefined => {
    const cookie: unknown = req.cookies?.token;

    return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
};

/** Non-empty `Authorization` header, whatever scheme it carries. */
const hasAuthorizationHeader = (req: Request): boolean => {
    const header = req.headers.authorization;

    return typeof header === 'string' && header.trim().length > 0;
};

const readCsrfHeader = (req: Request): string | undefined => {
    const header = req.headers[CSRF_HEADER.toLowerCase()];

    return typeof header === 'string' && header.length > 0 ? header : undefined;
};

/**
 * Rejects a state-changing request that carries a session but no matching
 * {@link CSRF_HEADER}. Mount after `csrfOriginGuard` and after `cookieParser`.
 */
export const csrfTokenGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!isStateChangingMethod(req.method)) {
        next();
        return;
    }

    if (hasAuthorizationHeader(req)) {
        next();
        return;
    }

    const sessionToken = readSessionToken(req);

    if (!sessionToken) {
        next();
        return;
    }

    if (isExemptPath(req)) {
        next();
        return;
    }

    const expected = createCsrfToken(sessionToken);
    const provided = readCsrfHeader(req);

    if (expected === null || provided === undefined || !tokensMatch(expected, provided)) {
        // No `console.warn` with the value: the token is a credential for this
        // session and must never reach a log line.
        res.status(403).json(CSRF_INVALID_RESPONSE);
        return;
    }

    next();
};
