/**
 * P1.1 — HMAC-bound CSRF token.
 *
 * Run with: npm run verify:csrf
 *
 * Every request-level check runs against the REAL app.
 * `createApp({ skipDatabaseCheck: true })` mounts the actual middleware chain —
 * the same CORS callback, the same `csrfOriginGuard`, the same `csrfTokenGuard`,
 * in the same order — with only the guard-then-connect middleware omitted. No
 * check re-implements the wiring it is checking.
 *
 * Two classes of assertion appear below, and both are load-bearing:
 *
 *   1. **Request-level** — behaviour, observed over HTTP.
 *   2. **Structural** — a handful of facts that are not observable from a
 *      request (which file mounts what, in which order, and that no secret or
 *      token reaches a log line). These read the comment-stripped source so a
 *      doc comment cannot satisfy them.
 *
 * Negative controls are built in, one per property under test: a probe app with
 * the guard and the identical probe app without it, an unbound HMAC that must be
 * refused, a secret flip that must invalidate an otherwise-valid token. A check
 * that passes either way measures nothing.
 *
 * Rate limits: the global and write tiers are raised for the harness app,
 * because this file makes many state-changing requests and the limiter
 * behaviour is already covered by `verify-security-headers.ts`. The **auth
 * tier is not tunable** (`AUTH_LIMIT`, 15/min/process) and this file spends 11
 * of those 15 on `/api/auth/*` — measured, not estimated. Adding `/api/auth`
 * requests here risks a 429 that would look like a CSRF failure, so bump this
 * note and the request count together.
 *
 * Exits non-zero if any check fails.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { DEFAULT_ALLOWED_ORIGINS } from '../src/config/allowed-origins';
import { csrfOriginGuard } from '../src/middleware/csrf.middleware';
import {
    CSRF_HEADER,
    CSRF_INVALID_MESSAGE,
    createCsrfToken,
    csrfTokenGuard,
} from '../src/middleware/csrf-token.middleware';
import { errorHandler, notFoundHandler, requestId } from '../src/middleware/error.middleware';

const SRC_DIR = join(__dirname, '..', 'src');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');
const ORIGIN_GUARD_FILE = join(SRC_DIR, 'middleware', 'csrf.middleware.ts');
const TOKEN_GUARD_FILE = join(SRC_DIR, 'middleware', 'csrf-token.middleware.ts');
const AUTH_CONTROLLER_FILE = join(SRC_DIR, 'auth', 'auth.controller.ts');
const AUTH_ROUTES_FILE = join(SRC_DIR, 'auth', 'auth.routes.ts');
const SECURITY_HEADERS_HARNESS_FILE = join(__dirname, 'verify-security-headers.ts');

/** A JWT-shaped session value. Only its bytes matter — the guard never parses it. */
const SESSION_A =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InByb2JlLWEiLCJpYXQiOjF9.probe-signature-a';
const SESSION_B =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InByb2JlLWIiLCJpYXQiOjF9.probe-signature-b';
/** Deliberately NOT a JWT: proves the guard needs no token format. */
const OPAQUE_SESSION = 'opaque-session-value-not-a-jwt';

const COOKIE_NAME = 'token';
const cookieFor = (session: string): string => `${COOKIE_NAME}=${session}`;

/** The first entry of the shared allowlist, so this cannot drift from the config. */
const ALLOWED_ORIGIN = DEFAULT_ALLOWED_ORIGINS[0];
const DENIED_ORIGIN = 'https://evil.example';

/** Inert placeholder, never a real credential. See `ensureProbeEnv`. */
const PROBE_SECRET_PLACEHOLDER = 'probe-csrf-secret-not-a-credential';

const LIMITS_OFF = {
    RATE_LIMIT_GLOBAL_MAX: '100000',
    RATE_LIMIT_WRITE_MAX: '100000',
};

const failures: string[] = [];

let createApp: typeof import('../src/app.module')['default'];

/**
 * Placeholders so the module graph can be imported without a developer env:
 * `media.routes.ts` builds an `ImageKitService` at load and throws on empty
 * variables, and `createCsrfToken` needs a key to HMAC with. `??=` — a real
 * value from the environment wins, and nothing here reads or prints one.
 */
const ensureProbeEnv = (): void => {
    process.env.IMAGEKIT_URL_ENDPOINT ??= 'https://ik.imagekit.io/probe-endpoint';
    process.env.IMAGEKIT_PUBLIC_KEY ??= 'probe-public-key';
    process.env.IMAGEKIT_PRIVATE_KEY ??= 'probe-private-key';
    process.env.JWT_SECRET ??= PROBE_SECRET_PLACEHOLDER;
};

/** The HMAC key, narrowed once so no assertion needs a non-null assertion. */
const probeSecret = (): string => {
    const secret = process.env.JWT_SECRET;

    if (!secret) {
        throw new Error('probe env: JWT_SECRET must be set before the harness runs');
    }

    return secret;
};

const check = (label: string, condition: boolean, detail?: string): void => {
    if (condition) {
        console.log(`  OK   ${label}`);
        return;
    }

    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  FAIL ${label}${suffix}`);
    failures.push(`${label}${suffix}`);
};

const section = (title: string): void => {
    console.log(`\n=== ${title} ===`);
};

/** Strips comment-ONLY lines so structural assertions read code, not prose. */
const stripCommentLines = (source: string): string =>
    source
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();

            return !(
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('*/')
            );
        })
        .join('\n');

const readSource = (file: string): string => stripCommentLines(readFileSync(file, 'utf8'));

/* ──────────────────────────── http helpers ──────────────────────────── */

type ProbeResponse = {
    status: number;
    body: unknown;
    text: string;
    headers: Headers;
};

/** Body sent by `csrfTokenGuard` and by `csrfOriginGuard`; both are 403s. */
type GuardRejection = { success?: unknown; message?: unknown };

const listen = async (app: express.Application): Promise<Server> =>
    new Promise<Server>((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });

const portOf = (server: Server): number => {
    const address = server.address();

    return address !== null && typeof address === 'object' ? address.port : 0;
};

const call = async (port: number, path: string, init?: RequestInit): Promise<ProbeResponse> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(6000),
        ...init,
    });
    const text = await response.text();

    let body: unknown = null;

    try {
        body = JSON.parse(text);
    } catch {
        body = null;
    }

    return { status: response.status, body, text, headers: response.headers };
};

const envelopeOf = (body: unknown): GuardRejection =>
    typeof body === 'object' && body !== null ? (body as GuardRejection) : {};

type GuardProbe = {
    path: string;
    method?: string;
    session?: string;
    csrf?: string;
    /** `null` omits the header entirely; a string sets it; omitted -> the allowlisted origin. */
    origin?: string | null;
    authorization?: string;
};

const guardCall = (port: number, probe: GuardProbe): Promise<ProbeResponse> => {
    const headers: Record<string, string> = {};
    const origin = probe.origin === undefined ? ALLOWED_ORIGIN : probe.origin;

    if (probe.session !== undefined) {
        headers.Cookie = cookieFor(probe.session);
    }

    if (probe.csrf !== undefined) {
        headers[CSRF_HEADER] = probe.csrf;
    }

    if (origin !== null) {
        headers.Origin = origin;
    }

    if (probe.authorization !== undefined) {
        headers.Authorization = probe.authorization;
    }

    return call(port, probe.path, { method: probe.method ?? 'POST', headers });
};

/** True when the response is the CSRF guard's rejection, by status AND by message. */
const isCsrfRejection = (response: ProbeResponse): boolean =>
    response.status === 403 && envelopeOf(response.body).message === CSRF_INVALID_MESSAGE;

/** True when the response is any origin-based rejection (CORS callback or origin guard). */
const isOriginRejection = (response: ProbeResponse): boolean =>
    response.status === 403 &&
    typeof envelopeOf(response.body).message === 'string' &&
    /origin/i.test(String(envelopeOf(response.body).message));

/** Sets env vars, builds a fresh app, runs the probe, restores the env in a `finally`. */
const withApp = async (
    env: Record<string, string | undefined>,
    run: (port: number) => Promise<void>
): Promise<void> => {
    const saved = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
        saved.set(key, process.env[key]);

        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    const server = await listen(createApp({ skipDatabaseCheck: true }));

    try {
        await run(portOf(server));
    } finally {
        server.close();

        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
};

/**
 * Minimal app carrying the same two guards in the same order as `app.module.ts`,
 * ending in a route that always answers. This is what makes the negative
 * controls possible: the identical request against the twin app without
 * `csrfTokenGuard` must reach the route, which proves the guard is the thing
 * that blocks it in the real app.
 */
const buildGuardProbeApp = (options: { withTokenGuard: boolean }): express.Application => {
    const app = express();

    app.use(requestId);
    app.use(express.json());
    app.use(cookieParser());
    app.use(csrfOriginGuard);

    if (options.withTokenGuard) {
        app.use(csrfTokenGuard);
    }

    app.post('/probe', (_req, res) => {
        res.json({ success: true, message: 'reached the route' });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

/* ───────────────────────────── checks ───────────────────────────── */

const main = async (): Promise<void> => {
    ensureProbeEnv();

    // Imported dynamically, AFTER the placeholders exist: the module graph
    // reaches `media.routes.ts`, which builds its ImageKitService on load.
    createApp = (await import('../src/app.module')).default;

    const tokenA = createCsrfToken(SESSION_A);
    const tokenB = createCsrfToken(SESSION_B);

    /* ── A. token derivation ───────────────────────────────────────────── */
    section('A. Token derivation (stateless, session-bound)');

    check(
        'a token is derived for a session',
        typeof tokenA === 'string' && tokenA.length === 43,
        `token length ${tokenA === null ? 'null' : tokenA.length}`
    );
    check(
        'the derivation is deterministic, so any instance can verify it (no shared state)',
        tokenA !== null && createCsrfToken(SESSION_A) === tokenA,
        'the same session produced two different tokens'
    );
    check(
        'two sessions produce two different tokens (the binding is not decorative)',
        tokenA !== null && tokenB !== null && tokenA !== tokenB,
        'both sessions produced the same token'
    );
    check(
        'the token is URL-safe (header-safe) base64',
        tokenA !== null && /^[A-Za-z0-9_-]{43}$/.test(tokenA),
        tokenA ?? 'null'
    );
    check(
        'the session value never appears inside the token',
        tokenA !== null && tokenA !== SESSION_A && !tokenA.includes(SESSION_A),
        'the token leaks the session value'
    );
    check('no session, no token', createCsrfToken(undefined) === null, 'undefined produced a token');
    check('empty session, no token', createCsrfToken('') === null, 'empty string produced a token');
    check(
        'the version scope is mixed in, so the secret is not reused raw elsewhere',
        tokenA !== null &&
            tokenA !== createHmac('sha256', probeSecret()).update(SESSION_A).digest('base64url'),
        'the token equals a bare HMAC of the session (no domain separation)'
    );
    check(
        'an opaque (non-JWT) session works identically — the guard parses no token format',
        createCsrfToken(OPAQUE_SESSION) !== null && createCsrfToken(OPAQUE_SESSION) !== tokenA,
        'the opaque session produced nothing'
    );

    /* ── B. accepted requests ──────────────────────────────────────────── */
    section('B. Requests the guard must let through');

    await withApp(LIMITS_OFF, async (port) => {
        const valid = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: tokenA ?? '',
        });

        check(
            'session + valid token passes the guard (reaches the terminal 404)',
            valid.status === 404,
            `status ${valid.status} body ${valid.text.slice(0, 80)}`
        );
        check(
            'a token computed outside the app is accepted (no per-instance state)',
            !isCsrfRejection(valid),
            'the app rejected a token derived from the shared secret'
        );

        const get = await guardCall(port, { path: '/api/health', method: 'GET', session: SESSION_A });

        check(
            'a GET carrying a session and no token is never checked',
            get.status === 200,
            `status ${get.status}`
        );

        const options = await guardCall(port, {
            path: '/api/auth/logout',
            method: 'OPTIONS',
            session: SESSION_A,
        });

        check(
            'an OPTIONS preflight is never checked (the browser cannot send the header yet)',
            options.status !== 403,
            `status ${options.status}`
        );

        const bearer = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            authorization: 'Bearer probe-token',
        });

        check(
            'a Bearer request passes: cross-site JS cannot set that header without a preflight',
            bearer.status === 404,
            `status ${bearer.status}`
        );
    });

    /* ── C. rejected requests ──────────────────────────────────────────── */
    section('C. Requests the guard must reject');

    await withApp(LIMITS_OFF, async (port) => {
        const missing = await guardCall(port, { path: '/nonexistent', session: SESSION_A });

        check(
            'session without the header is rejected',
            isCsrfRejection(missing),
            `status ${missing.status} body ${missing.text.slice(0, 80)}`
        );
        check(
            'the rejection keeps the { success, message } envelope',
            envelopeOf(missing.body).success === false,
            JSON.stringify(missing.body)
        );
        check(
            'the rejection body carries no session value and no token',
            !missing.text.includes(SESSION_A) &&
                (tokenA === null || !missing.text.includes(tokenA)) &&
                !missing.text.includes(probeSecret()),
            'the 403 body leaks a credential'
        );

        const tampered =
            tokenA === null
                ? ''
                : `${tokenA.slice(0, -1)}${tokenA.endsWith('A') ? 'B' : 'A'}`;
        const tamperedResponse = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: tampered,
        });

        check(
            'a tampered token is rejected',
            isCsrfRejection(tamperedResponse),
            `status ${tamperedResponse.status}`
        );

        const short = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: (tokenA ?? '').slice(0, 10),
        });

        check(
            'a truncated token is rejected with 403, not 500 (length checked before timingSafeEqual)',
            isCsrfRejection(short),
            `status ${short.status} body ${short.text.slice(0, 80)}`
        );

        const long = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: `${tokenA ?? ''}${tokenA ?? ''}`,
        });

        check(
            'an over-long token is rejected with 403, not 500',
            isCsrfRejection(long),
            `status ${long.status}`
        );

        const crossSession = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_B,
            csrf: tokenA ?? '',
        });

        check(
            "a valid token for another session is rejected (the token is bound to the session)",
            isCsrfRejection(crossSession),
            `status ${crossSession.status}`
        );

        const guessed = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        });

        check(
            'a correctly sized but wrong token is rejected',
            isCsrfRejection(guessed),
            `status ${guessed.status}`
        );

        // The documented rule-3 gap in `csrfOriginGuard`: a client that sends no
        // Origin and no Referer is allowed by the origin guard alone. This is the
        // request the new control exists for, so it is asserted explicitly.
        const noOriginNoToken = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            origin: null,
        });

        check(
            'the origin guard rule-3 gap is closed: no Origin, session, no token -> 403',
            isCsrfRejection(noOriginNoToken),
            `status ${noOriginNoToken.status} body ${noOriginNoToken.text.slice(0, 80)}`
        );

        const noOriginGuessed = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            origin: null,
            csrf: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        });

        check(
            'even with the origin guard bypassed, a forged request without the token fails',
            isCsrfRejection(noOriginGuessed),
            `status ${noOriginGuessed.status}`
        );

        const noOriginValid = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            origin: null,
            csrf: tokenA ?? '',
        });

        check(
            'a non-browser client that holds the token still works with no Origin at all',
            noOriginValid.status === 404,
            `status ${noOriginValid.status}`
        );

        // The origin guard runs first and is unchanged: a request it rejects must
        // never come back looking like a CSRF token failure.
        const deniedOrigin = await guardCall(port, {
            path: '/nonexistent',
            session: SESSION_A,
            csrf: tokenA ?? '',
            origin: DENIED_ORIGIN,
        });

        check(
            'an untrusted Origin is still rejected by the origin control, even with a valid token',
            deniedOrigin.status === 403 && !isCsrfRejection(deniedOrigin),
            `status ${deniedOrigin.status} body ${deniedOrigin.text.slice(0, 80)}`
        );

        check(
            'the two 403s are distinguishable, so a log says which control fired',
            isOriginRejection(deniedOrigin) &&
                isCsrfRejection(missing) &&
                envelopeOf(deniedOrigin.body).message !== CSRF_INVALID_MESSAGE,
            `origin="${String(envelopeOf(deniedOrigin.body).message)}" csrf="${String(
                envelopeOf(missing.body).message
            )}"`
        );
    });

    /* ── D. exemptions and logout ──────────────────────────────────────── */
    section('D. Auth bootstrap exemptions, and logout');

    await withApp(LIMITS_OFF, async (port) => {
        // The user's own case: a stale tab sends a stale token, or none at all,
        // and must still be able to sign in again.
        const loginStaleToken = await guardCall(port, {
            path: '/api/auth/login',
            session: SESSION_A,
            csrf: 'stale-token-from-a-previous-session',
        });

        check(
            'POST /api/auth/login passes with an invalid token (a stale tab can still sign in)',
            !isCsrfRejection(loginStaleToken) && loginStaleToken.status !== 500,
            `status ${loginStaleToken.status}`
        );
        check(
            'that request reached the route (the body is the route validation error, not a 403)',
            envelopeOf(loginStaleToken.body).message !== CSRF_INVALID_MESSAGE &&
                loginStaleToken.status < 500,
            `status ${loginStaleToken.status} body ${loginStaleToken.text.slice(0, 80)}`
        );

        const loginNoToken = await guardCall(port, { path: '/api/auth/login', session: SESSION_A });

        check(
            'POST /api/auth/login passes with no token at all',
            !isCsrfRejection(loginNoToken) && loginNoToken.status === 400,
            `status ${loginNoToken.status}`
        );

        const register = await guardCall(port, {
            path: '/api/auth/register',
            session: SESSION_A,
            csrf: 'stale-token-from-a-previous-session',
        });

        check(
            'POST /api/auth/register is exempt too',
            !isCsrfRejection(register) && register.status === 400,
            `status ${register.status}`
        );

        const google = await guardCall(port, {
            path: '/api/auth/google',
            session: SESSION_A,
            csrf: 'stale-token-from-a-previous-session',
        });

        check(
            'POST /api/auth/google is exempt too',
            !isCsrfRejection(google) && google.status === 400,
            `status ${google.status}`
        );

        // The exemption mirrors Express's own routing, which is case-insensitive
        // and tolerant of a trailing slash. If it did not, a legitimate login on
        // such a path would be blocked.
        const caseVariant = await guardCall(port, {
            path: '/API/AUTH/LOGIN',
            session: SESSION_A,
            csrf: 'stale-token-from-a-previous-session',
        });

        check(
            'the exemption matches the case-insensitive path Express routes to /login',
            !isCsrfRejection(caseVariant) && caseVariant.status === 400,
            `status ${caseVariant.status}`
        );

        const trailingSlash = await guardCall(port, {
            path: '/api/auth/login/',
            session: SESSION_A,
            csrf: 'stale-token-from-a-previous-session',
        });

        check(
            'the exemption tolerates a trailing slash, as the router does',
            !isCsrfRejection(trailingSlash) && trailingSlash.status === 400,
            `status ${trailingSlash.status}`
        );

        // Exact match only: a nested path is NOT the login route, so it must not
        // inherit the exemption.
        const nested = await guardCall(port, { path: '/api/auth/login/extra', session: SESSION_A });

        check(
            'the exemption is an exact match, never a prefix (a nested path is still checked)',
            isCsrfRejection(nested),
            `status ${nested.status}`
        );

        const logoutNoToken = await guardCall(port, { path: '/api/auth/logout', session: SESSION_A });

        check(
            'POST /api/auth/logout IS checked: a session and no token -> 403',
            isCsrfRejection(logoutNoToken),
            `status ${logoutNoToken.status}`
        );

        const logoutValid = await guardCall(port, {
            path: '/api/auth/logout',
            session: SESSION_A,
            csrf: tokenA ?? '',
        });

        check(
            'POST /api/auth/logout with a valid token succeeds',
            logoutValid.status === 200 && envelopeOf(logoutValid.body).success === true,
            `status ${logoutValid.status} body ${logoutValid.text.slice(0, 80)}`
        );
    });

    /* ── E. CORS preflight ─────────────────────────────────────────────── */
    section('E. The browser contract (CORS preflight)');

    await withApp(LIMITS_OFF, async (port) => {
        const preflight = await call(port, '/api/auth/login', {
            method: 'OPTIONS',
            headers: {
                Origin: ALLOWED_ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': `${CSRF_HEADER.toLowerCase()},content-type`,
            },
        });
        const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();

        check(
            'the preflight advertises the CSRF header, or every write would fail before being sent',
            allowHeaders.includes(CSRF_HEADER.toLowerCase()),
            `allow-headers="${allowHeaders}" status ${preflight.status}`
        );
    });

    /* ── F. non-browser clients are unaffected ─────────────────────────── */
    section('F. Non-browser clients (curl, Postman, mobile)');

    await withApp(LIMITS_OFF, async (port) => {
        const noCookieHealth = await guardCall(port, {
            path: '/api/health',
            origin: ALLOWED_ORIGIN,
        });

        check(
            'POST with no cookie and no token reaches the route handler chain (404, never 403)',
            noCookieHealth.status === 404 && !isCsrfRejection(noCookieHealth),
            `status ${noCookieHealth.status} body ${noCookieHealth.text.slice(0, 80)}`
        );

        // Exactly the request the write-limiter tier in verify-security-headers.ts
        // issues: no cookie, no Origin, no token. It must keep getting the
        // terminal 404.
        const noCookiePlain = await call(port, '/nonexistent', { method: 'POST' });

        check(
            'the cookie-less POST used by the write-limiter checks still gets its 404',
            noCookiePlain.status === 404,
            `status ${noCookiePlain.status} — a regression here breaks curl and mobile clients`
        );

        const harnessSource = readSource(SECURITY_HEADERS_HARNESS_FILE);

        check(
            'companion guard: that harness still sends no Cookie header, so its POSTs stay cookie-less',
            !/Cookie/i.test(harnessSource),
            'verify-security-headers.ts now sends a cookie — its write-tier checks changed meaning'
        );
    });

    /* ── G. negative controls ──────────────────────────────────────────── */
    section('G. Negative controls');

    const guardedProbe = await listen(buildGuardProbeApp({ withTokenGuard: true }));
    const unguardedProbe = await listen(buildGuardProbeApp({ withTokenGuard: false }));

    try {
        const guardedPort = portOf(guardedProbe);
        const unguardedPort = portOf(unguardedProbe);

        const guarded = await guardCall(guardedPort, { path: '/probe', session: SESSION_A });
        const unguarded = await guardCall(unguardedPort, { path: '/probe', session: SESSION_A });

        check(
            'NC1: with the guard mounted, the request is rejected',
            isCsrfRejection(guarded),
            `status ${guarded.status}`
        );
        check(
            'NC1: without the guard, the identical request reaches the route — the guard is what blocks it',
            unguarded.status === 200 && envelopeOf(unguarded.body).message === 'reached the route',
            `status ${unguarded.status} body ${unguarded.text.slice(0, 80)}`
        );

        // NC2 — the secret is a verifier input. If the guard compared a token with
        // itself, or ignored the key, the flipped-secret token would still pass.
        const beforeFlip = await guardCall(guardedPort, {
            path: '/probe',
            session: SESSION_A,
            csrf: tokenA ?? '',
        });

        check(
            'NC2: with the current secret the token is accepted',
            beforeFlip.status === 200,
            `status ${beforeFlip.status}`
        );

        const savedSecret = process.env.JWT_SECRET;

        try {
            process.env.JWT_SECRET = `${savedSecret ?? PROBE_SECRET_PLACEHOLDER}-rotated`;

            const afterFlip = await guardCall(guardedPort, {
                path: '/probe',
                session: SESSION_A,
                csrf: tokenA ?? '',
            });

            check(
                'NC2: rotating the secret invalidates the same token (the key is really used)',
                isCsrfRejection(afterFlip),
                `status ${afterFlip.status} — the token verified without the key`
            );
        } finally {
            if (savedSecret === undefined) {
                delete process.env.JWT_SECRET;
            } else {
                process.env.JWT_SECRET = savedSecret;
            }
        }

        const afterRestore = await guardCall(guardedPort, {
            path: '/probe',
            session: SESSION_A,
            csrf: tokenA ?? '',
        });

        check(
            'NC2: restoring the secret makes that token valid again (the flip was the only change)',
            afterRestore.status === 200,
            `status ${afterRestore.status}`
        );

        // NC3 — the session is mixed into the HMAC. A scope-only HMAC is a
        // perfectly valid HMAC of this module's tag, and must still be refused:
        // if the binding were dropped, this is exactly what an attacker gets by
        // knowing nothing but the tag.
        const unbound = createHmac('sha256', probeSecret()).update('csrf.v1:').digest('base64url');
        const unboundResponse = await guardCall(guardedPort, {
            path: '/probe',
            session: SESSION_A,
            csrf: unbound,
        });

        check(
            'NC3: an HMAC of the scope tag alone is refused (the session is genuinely bound in)',
            isCsrfRejection(unboundResponse),
            `status ${unboundResponse.status} — the session is not part of the HMAC`
        );

        const unboundWithOtherSession = await guardCall(guardedPort, {
            path: '/probe',
            session: SESSION_B,
            csrf: unbound,
        });

        check(
            'NC3: that unbound value is refused for every session, not just one',
            isCsrfRejection(unboundWithOtherSession),
            `status ${unboundWithOtherSession.status}`
        );

        // NC4 — the cookie is the trigger. Same path, same absence of a token:
        // the only difference is the session cookie.
        const withCookie = await guardCall(guardedPort, { path: '/probe', session: SESSION_A });
        const withoutCookie = await guardCall(guardedPort, { path: '/probe' });

        check(
            'NC4: with a cookie the request is rejected',
            isCsrfRejection(withCookie),
            `status ${withCookie.status}`
        );
        check(
            'NC4: without a cookie the identical request passes — the cookie is the trigger, not a default',
            withoutCookie.status === 200 && !isCsrfRejection(withoutCookie),
            `status ${withoutCookie.status}`
        );
    } finally {
        guardedProbe.close();
        unguardedProbe.close();
    }

    /* ── H. structural facts a request cannot show ─────────────────────── */
    section('H. Wiring and hygiene (source-level)');

    const appModule = readSource(APP_MODULE_FILE);
    const originGuardSource = readSource(ORIGIN_GUARD_FILE);
    const tokenGuardSource = readSource(TOKEN_GUARD_FILE);
    const authController = readSource(AUTH_CONTROLLER_FILE);
    const authRoutes = readSource(AUTH_ROUTES_FILE);

    const originGuardUse = appModule.indexOf('app.use(csrfOriginGuard)');
    const tokenGuardUse = appModule.indexOf('app.use(csrfTokenGuard)');

    check(
        'the token guard is mounted after the origin guard',
        originGuardUse !== -1 && tokenGuardUse !== -1 && tokenGuardUse > originGuardUse,
        `origin@${originGuardUse} token@${tokenGuardUse}`
    );
    check(
        'the origin guard is still mounted and unchanged in name',
        originGuardSource.includes('export const csrfOriginGuard'),
        'csrfOriginGuard is gone'
    );
    check(
        'the origin guard does not import the token guard (the controls stay independent)',
        !originGuardSource.includes('csrf-token.middleware'),
        'the origin guard now depends on the token guard'
    );
    check(
        'the origin guard still accepts only allowlisted origins',
        originGuardSource.includes('isAllowedOrigin') && originGuardSource.includes('res.status(403)'),
        'the origin allowlist check was removed'
    );
    check(
        'the CORS allowlist is built from the CSRF_HEADER constant, not a copy of the string',
        /allowedHeaders:\s*\[[^\]]*CSRF_HEADER/.test(appModule),
        'allowedHeaders no longer references CSRF_HEADER'
    );
    check(
        'the access token is read from the cookie the guard and the issuer share',
        tokenGuardSource.includes('process.env.JWT_SECRET') && tokenGuardSource.includes('req.cookies'),
        'the session cookie or the secret is gone'
    );
    check(
        'no secret literal is embedded in the token guard',
        !tokenGuardSource.includes(PROBE_SECRET_PLACEHOLDER) && !/=\s*'[A-Za-z0-9+/]{32,}'/.test(tokenGuardSource),
        'a secret-looking literal was found in the module'
    );
    check(
        'the token guard never logs (a token in a log line is a leaked credential)',
        !/console\./.test(tokenGuardSource),
        'the guard logs something'
    );

    const issuedInController = (authController.match(/csrfToken:\s*createCsrfToken\(/g) ?? []).length;

    check(
        'all three auth entry points (register/login/google) issue the token',
        issuedInController === 3,
        `found ${issuedInController} of 3`
    );
    check(
        'GET /me re-issues the token, using the same session source as the guard',
        /csrfToken:\s*createCsrfToken\(readSessionToken\(req\)\)/.test(authRoutes),
        '/me does not re-issue the token'
    );

    /* ── Result ────────────────────────────────────────────────────────── */
    console.log('\n=== Result ===');

    if (failures.length > 0) {
        console.log(`FAILED (${failures.length}):`);
        for (const failure of failures) {
            console.log(`  - ${failure}`);
        }

        // exitCode rather than process.exit(): tearing the process down while
        // fetch handles are still closing trips a libuv assertion on Windows.
        process.exitCode = 1;
        return;
    }

    console.log('All CSRF token checks passed.');
};

void main();
