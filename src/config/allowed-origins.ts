/**
 * Single source of truth for the origins allowed to call the API with
 * credentials.
 *
 * Consumed by:
 *   - the CORS configuration in `app.module.ts`
 *   - the CSRF origin guard in `middleware/csrf.middleware.ts`
 *
 * Keeping both consumers on one list means a newly trusted origin can never be
 * accepted by CORS while being rejected by the CSRF guard (or vice versa).
 *
 * NO wildcards. `credentials: true` plus a wildcard origin would let any
 * host — including arbitrary third-party preview deployments — read
 * authenticated responses. Preview/staging environments must be added as
 * explicit hostnames.
 */

const PRODUCTION_ORIGINS: readonly string[] = [
    'https://mioralane.com',
    'https://www.mioralane.com',
    'https://admin.mioralane.com',
];

/** Local development servers: storefront (3000) and admin app (3001/3100). */
const LOCAL_ORIGINS: readonly string[] = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3100',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3100',
];

/** Used whenever `CORS_ORIGINS` is unset — i.e. the pre-P0-5 behaviour. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
    ...PRODUCTION_ORIGINS,
    ...LOCAL_ORIGINS,
];

/**
 * Accepts only an absolute `http`/`https` origin: scheme, host, optional port.
 *
 * Parsed with `new URL()` instead of a regex because it rejects exactly the
 * shapes that matter — `*`, a bare hostname (`mioralane.com`), a value with a
 * path or query, and credentials — without hand-rolling a pattern that drifts
 * from the URL spec.
 *
 * A trailing slash is accepted and normalised away, because it is the obvious
 * thing for an operator to type.
 */
const parseOrigin = (value: string): string | null => {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }

    if (url.username !== '' || url.password !== '') {
        return null;
    }

    // `new URL('https://x.com')` reports pathname '/'; anything longer means the
    // value carried a path, and an origin must not.
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        return null;
    }

    return url.origin;
};

/**
 * Parses `CORS_ORIGINS`, or returns null to mean "no usable override".
 *
 * Invalid entries are dropped individually so one typo cannot discard a whole
 * working list. If nothing usable survives, this returns null and the caller
 * falls back to {@link DEFAULT_ALLOWED_ORIGINS} — a deliberate
 * fail-safe-on-availability choice: the alternative, treating an unparseable
 * variable as "trust nothing", turns a one-character mistake into an outage on
 * every authenticated route.
 */
const parseOriginList = (raw: string | undefined): string[] | null => {
    if (raw === undefined || raw.trim() === '') {
        return null;
    }

    const accepted: string[] = [];
    const rejected: string[] = [];

    for (const entry of raw.split(',')) {
        const candidate = entry.trim();

        if (candidate === '') {
            continue;
        }

        const origin = parseOrigin(candidate);

        if (origin === null) {
            rejected.push(candidate);
            continue;
        }

        if (!accepted.includes(origin)) {
            accepted.push(origin);
        }
    }

    if (rejected.length > 0) {
        console.warn(
            `[cors] ignoring ${rejected.length} CORS_ORIGINS entr(ies) that are not absolute http(s) origins: ${rejected.join(', ')}`
        );
    }

    if (accepted.length === 0) {
        console.warn('[cors] CORS_ORIGINS held no usable origin — using the built-in allowlist');

        return null;
    }

    return accepted;
};

/**
 * Cache keyed on the raw env value, not a one-time flag.
 *
 * `getAllowedOrigins()` is called on every request by both CORS and the CSRF
 * guard, so re-parsing each time would be waste — but caching on first call
 * would serve a stale allowlist if the env ever changed under us. Keying on the
 * raw string gets both: parsing happens only when the value actually differs.
 */
let cachedRaw: string | undefined = undefined;
let cachedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS;

export const getAllowedOrigins = (): string[] => {
    const raw = process.env.CORS_ORIGINS;

    if (raw !== cachedRaw) {
        cachedOrigins = parseOriginList(raw) ?? DEFAULT_ALLOWED_ORIGINS;
        cachedRaw = raw;
    }

    return [...cachedOrigins];
};

export const isAllowedOrigin = (origin: string): boolean =>
    getAllowedOrigins().includes(origin);
