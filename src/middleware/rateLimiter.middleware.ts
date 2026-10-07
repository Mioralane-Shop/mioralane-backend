import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

/**
 * Rate limiting, in three tiers.
 *
 * `authLimiter`   strict, login/register/google only (unchanged since P0-2)
 * `globalLimiter` broad flood control on every route
 * `writeLimiter`  stricter, state-changing methods only
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 * All three use express-rate-limit's DEFAULT key generator and set no custom
 * `keyGenerator`. That is deliberate, not an oversight: in v8 the default
 * already normalises IPv6 via the library's `ipKeyGenerator` (masking to the
 * /56 subnet), so two addresses in one allocation cannot be used to double a
 * bucket. A custom key generator would *require* an explicit `ipKeyGenerator`
 * call to keep that property; not writing one keeps the guarantee.
 *
 * ── What actually made these buckets useless ────────────────────────────────
 * The key is derived from `req.ip`, and behind Cloudflare → Vercel `req.ip` was
 * a proxy address for every caller until `app.set('trust proxy', …)` was added
 * (see `config/trust-proxy.ts`). The limiter was never the bug; the missing hop
 * count was. v8 flags the situation itself with
 * `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`, which `tests/verify-security-headers.ts`
 * asserts disappears once the hop count is set.
 */

/** Tunables, overridable per deployment via env. */
export type RateLimitSettings = {
    windowMs: number;
    globalMax: number;
    writeMax: number;
};

/**
 * 15 minutes, 300 requests total, 60 of them state-changing.
 *
 * Sized for a real storefront session (a page view is rarely one request) while
 * still bounding a scripted flood. The write tier is the one that matters: it is
 * what stops credential-stuffing-adjacent automation, order spam and review
 * spam, all of which are POSTs.
 */
export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
    windowMs: 15 * 60 * 1000,
    globalMax: 300,
    writeMax: 60,
};

/** Auth tier, kept as its pre-P0-5 shape so no client behaviour changes. */
export const AUTH_LIMIT = {
    windowMs: 1 * 60 * 1000,
    limit: 15,
} as const;

/**
 * Body returned when a limit trips.
 *
 * Identical to what the terminal error handler produces so a 429 is
 * indistinguishable in shape from every other error a client sees.
 */
const LIMIT_BODY = {
    success: false,
    message: 'Too many requests',
};

/** Methods that change state. Everything else is a read. */
const STATE_CHANGING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export const isStateChangingMethod = (method: string): boolean =>
    STATE_CHANGING_METHODS.includes(method.toUpperCase());

const readPositiveInt = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const parsed = Number(raw.trim());

    if (!Number.isInteger(parsed) || parsed <= 0) {
        console.warn(`[rate-limit] ${label}="${raw}" is not a positive integer; using ${fallback}`);

        return fallback;
    }

    return parsed;
};

/**
 * Reads the tunables, falling back per value.
 *
 * Read at `createApp()` time rather than at module load so a deployment can
 * change a limit by changing an env var, and so the verification harness can
 * mount the real limiters at a small ceiling instead of testing a copy of them.
 */
export const readRateLimitSettings = (
    env: NodeJS.ProcessEnv = process.env
): RateLimitSettings => ({
    windowMs: readPositiveInt(
        env.RATE_LIMIT_WINDOW_MS,
        DEFAULT_RATE_LIMIT_SETTINGS.windowMs,
        'RATE_LIMIT_WINDOW_MS'
    ),
    globalMax: readPositiveInt(
        env.RATE_LIMIT_GLOBAL_MAX,
        DEFAULT_RATE_LIMIT_SETTINGS.globalMax,
        'RATE_LIMIT_GLOBAL_MAX'
    ),
    writeMax: readPositiveInt(
        env.RATE_LIMIT_WRITE_MAX,
        DEFAULT_RATE_LIMIT_SETTINGS.writeMax,
        'RATE_LIMIT_WRITE_MAX'
    ),
});

/**
 * Auth-specific rate limiter.
 * Allows 15 requests per 1-minute window per IP.
 */
export const authLimiter = rateLimit({
    windowMs: AUTH_LIMIT.windowMs,
    limit: AUTH_LIMIT.limit,
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
        success: false,
        message: 'Too many requests — please try again in a minute',
    },
});

/** Turnstile tier: 20 requests / minute / IP. */
export const TURNSTILE_LIMIT = {
    windowMs: 1 * 60 * 1000,
    limit: 20,
} as const;

/**
 * Dedicated limiter for `POST /api/verify-turnstile`.
 *
 * Separate from {@link authLimiter} on purpose. `authLimiter` is ONE bucket
 * shared by every `/api/auth/*` request, so mounting it here would let a burst
 * of verification calls lock out logins (and the reverse). This endpoint is
 * public and pre-session; it gets its own small ceiling. Like the other two it
 * sets no `keyGenerator`, so express-rate-limit v8 keeps IPv6 normalisation.
 */
export const turnstileLimiter = rateLimit({
    windowMs: TURNSTILE_LIMIT.windowMs,
    limit: TURNSTILE_LIMIT.limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests — please try again in a minute',
    },
});

/**
 * Broad flood control, mounted on every route.
 *
 * Sits before the DB-ensure middleware on purpose: a flood should be refused
 * before the app tries to open a database connection for it.
 */
export const createGlobalLimiter = (settings: RateLimitSettings): RequestHandler =>
    rateLimit({
        windowMs: settings.windowMs,
        limit: settings.globalMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: LIMIT_BODY,
    });

/**
 * Stricter tier for state-changing requests.
 *
 * Implemented as one mount with a `skip` predicate rather than four mounts, so
 * there is a single place that decides what counts as a write. `skip` still runs
 * the middleware on GETs — it just does not charge them to the bucket — which
 * keeps the check in one place instead of splitting the router.
 *
 * OPTIONS is intentionally excluded: preflight requests are not state-changing
 * and are cached by the `maxAge` set on CORS, so charging them would spend a
 * storefront's write budget on the browser's own handshake.
 */
export const createWriteLimiter = (settings: RateLimitSettings): RequestHandler =>
    rateLimit({
        windowMs: settings.windowMs,
        limit: settings.writeMax,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req: Request): boolean => !isStateChangingMethod(req.method),
        message: LIMIT_BODY,
    });
