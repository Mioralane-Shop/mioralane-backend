/**
 * Turnstile verification harness — `npm run verify:turnstile`.
 *
 * ## What this covers
 *
 *   1. `verifyTurnstileSchema` — the required/oversized bounds and the fact that
 *      unknown keys are STRIPPED (the same property `validate()` relies on
 *      everywhere else to stop mass-assignment / operator smuggling).
 *   2. `verifyTurnstile` — every branch of the verdict, with `fetch` stubbed so
 *      no request leaves the process: success, Cloudflare `success: false` (with
 *      and without an error code), a non-2xx, a transport error, an abort, and
 *      the disabled short-circuit. It also asserts the OUTBOUND body — the only
 *      place the secret and token travel — carries exactly those two fields.
 *   3. The real router over a real HTTP request: a missing token is a 400 with
 *      the standard validation envelope, an oversized token is a 400, and a good
 *      token is a 200 `{ success }`.
 *   4. The real `turnstileLimiter`, driven until it trips, proving the route
 *      cannot ship unlimited.
 *   5. A negative control: with `validate()` removed, the same empty request is
 *      no longer a 400 — which is what makes check 3 attributable to the schema
 *      rather than to something incidental.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { errorHandler, notFoundHandler, requestId } from '../src/middleware/error.middleware';
import { TURNSTILE_LIMIT, turnstileLimiter } from '../src/middleware/rateLimiter.middleware';
import { verifyTurnstileHandler } from '../src/turnstile/turnstile.controller';
import { turnstileRoutes } from '../src/turnstile/turnstile.routes';
import {
    MAX_TURNSTILE_TOKEN_LENGTH,
    verifyTurnstileSchema,
} from '../src/turnstile/turnstile.schemas';
import {
    SITEVERIFY_URL,
    TURNSTILE_TIMEOUT_MS,
    verifyTurnstile,
} from '../src/turnstile/turnstile.service';
import authRoutes from '../src/auth/auth.routes';
import mongoose from 'mongoose';
import {
    TURNSTILE_FAILED_CODE,
    TURNSTILE_MISSING_CODE,
    TURNSTILE_MISSING_MESSAGE,
    TURNSTILE_TOKEN_HEADER,
    requireTurnstile,
} from '../src/turnstile/turnstile.middleware';

const SRC_DIR = join(__dirname, '..', 'src');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');
const ROUTES_FILE = join(SRC_DIR, 'turnstile', 'turnstile.routes.ts');
const SERVICE_FILE = join(SRC_DIR, 'turnstile', 'turnstile.service.ts');
const RATE_LIMITER_FILE = join(SRC_DIR, 'middleware', 'rateLimiter.middleware.ts');
const AUTH_ROUTES_FILE = join(SRC_DIR, 'auth', 'auth.routes.ts');
const ORDER_ROUTES_FILE = join(SRC_DIR, 'order', 'order.routes.ts');
const REVIEW_ROUTES_FILE = join(SRC_DIR, 'review', 'review.routes.ts');
const ADDRESS_ROUTES_FILE = join(SRC_DIR, 'address', 'address.routes.ts');

/** One `router.<method>('path', …)` registration, reduced to what a wiring check needs. */
type Registration = { method: string; path: string; hasTurnstile: boolean };

/**
 * The write routes `requireTurnstile` must be mounted on, and nothing else.
 *
 * Every OTHER registration in these files is asserted NOT to carry it — the
 * `get` check below is what keeps a lazy `router.use(requireTurnstile)` from
 * silently protecting the public reads (and the SEO crawlers) too.
 */
const PROTECTED_ROUTES: { label: string; file: string; expected: { method: string; path: string }[] }[] = [
    {
        label: 'auth.routes.ts',
        file: AUTH_ROUTES_FILE,
        expected: [
            { method: 'post', path: '/register' },
            { method: 'post', path: '/login' },
            { method: 'post', path: '/google' },
        ],
    },
    { label: 'order.routes.ts', file: ORDER_ROUTES_FILE, expected: [{ method: 'post', path: '/' }] },
    { label: 'review.routes.ts', file: REVIEW_ROUTES_FILE, expected: [{ method: 'post', path: '/' }] },
    { label: 'address.routes.ts', file: ADDRESS_ROUTES_FILE, expected: [{ method: 'post', path: '/' }] },
];

/** The process's real `fetch`, captured before any test replaces it. */
const realFetch = globalThis.fetch.bind(globalThis);

type OutboundCall = { url: string; body: Record<string, unknown> | null };

let outbound: OutboundCall[] = [];
let respond: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 });

/** Replaces `globalThis.fetch` so the service's Siteverify call never leaves the process. */
const stubFetch = (impl: () => Promise<Response>): void => {
    respond = impl;
    outbound = [];

    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
        outbound.push({
            url: typeof input === 'string' ? input : String(input),
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        });

        return respond();
    }) as unknown as typeof fetch;
};

const restoreFetch = (): void => {
    globalThis.fetch = realFetch;
};

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

type Server = { base: string; close: () => Promise<void> };

const listen = (app: express.Express): Promise<Server> =>
    new Promise((resolve) => {
        const server = app.listen(0, () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;

            resolve({
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>((done) => server.close(() => done())),
            });
        });
    });

/** The response body, viewed without `any`. */
type RouteBody = {
    success?: boolean;
    reason?: string;
    message?: string;
    code?: string;
    reached?: boolean;
    errors?: { path?: string; message?: string }[];
};

const asBody = (value: unknown): RouteBody =>
    typeof value === 'object' && value !== null ? (value as RouteBody) : {};

const post = async (
    base: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: RouteBody }> => {
    const headers: Record<string, string> = { ...extraHeaders };

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await realFetch(`${base}${path}`, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const parsed: unknown = await response.json().catch(() => null);

    return { status: response.status, body: asBody(parsed) };
};

/** The real router, exactly as `app.module` mounts it — minus the limiter (see §D). */
const buildRouteApp = (): express.Express => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.use('/api/verify-turnstile', turnstileRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

/** Control: the same handler with NO `validate()` in front of it. */
const buildSchemaLessApp = (): express.Express => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.post('/api/verify-turnstile', verifyTurnstileHandler as RequestHandler);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

/** The real mount from `app.module`: limiter THEN router. */
const buildRateLimitedApp = (): express.Express => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.use('/api/verify-turnstile', turnstileLimiter, turnstileRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

const stripCommentLines = (source: string): string =>
    source
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();

            return !(
                trimmed.startsWith('//') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*/')
            );
        })
        .join('\n');

const main = async (): Promise<void> => {
    const failures: string[] = [];

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

    const originalSecret = process.env.TURNSTILE_SECRET_KEY;
    const setSecret = (value: string | undefined): void => {
        if (value === undefined) {
            delete process.env.TURNSTILE_SECRET_KEY;
            return;
        }

        process.env.TURNSTILE_SECRET_KEY = value;
    };

    try {
        /* ── A. schema ─────────────────────────────────────────────────────── */
        section('A. verifyTurnstileSchema');

        check('a missing token is rejected', !verifyTurnstileSchema.safeParse({}).success);
        check('an empty token is rejected', !verifyTurnstileSchema.safeParse({ token: '' }).success);
        check('a token is accepted', verifyTurnstileSchema.safeParse({ token: 'abc' }).success);
        check(
            `the ceiling is ${MAX_TURNSTILE_TOKEN_LENGTH}`,
            MAX_TURNSTILE_TOKEN_LENGTH === 4096,
            String(MAX_TURNSTILE_TOKEN_LENGTH)
        );
        check(
            `a token of exactly ${MAX_TURNSTILE_TOKEN_LENGTH} characters is accepted`,
            verifyTurnstileSchema.safeParse({ token: 'a'.repeat(MAX_TURNSTILE_TOKEN_LENGTH) }).success
        );
        check(
            'a token one character over the ceiling is rejected',
            !verifyTurnstileSchema.safeParse({ token: 'a'.repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) })
                .success
        );

        const stripped = verifyTurnstileSchema.safeParse({ token: 'abc', $ne: null, extra: 'x' });
        const strippedData = stripped.success ? stripped.data : null;
        check(
            'unknown keys are STRIPPED (mass-assignment / operator smuggling)',
            strippedData !== null &&
                Object.keys(strippedData).length === 1 &&
                !('$ne' in strippedData) &&
                !('extra' in strippedData),
            strippedData === null ? 'parse failed' : JSON.stringify(strippedData)
        );

        /* ── B. service (fetch stubbed) ────────────────────────────────────── */
        section('B. verifyTurnstile service (fetch stubbed)');

        check(
            'the Siteverify URL is the documented one',
            SITEVERIFY_URL === 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            SITEVERIFY_URL
        );
        check('the timeout ceiling is 5s', TURNSTILE_TIMEOUT_MS === 5000, String(TURNSTILE_TIMEOUT_MS));

        setSecret('test-secret-value');

        stubFetch(async () => jsonResponse({ success: true }));
        const ok = await verifyTurnstile('token-valid');
        check('a valid token → { success: true }', ok.success === true, JSON.stringify(ok));
        check(
            'exactly one outbound call, POSTed to the Siteverify URL',
            outbound.length === 1 && outbound[0].url === SITEVERIFY_URL,
            JSON.stringify(outbound)
        );
        check(
            'the outbound body carries secret + response and nothing else',
            outbound[0]?.body?.secret === 'test-secret-value' &&
                outbound[0]?.body?.response === 'token-valid' &&
                Object.keys(outbound[0]?.body ?? {}).length === 2,
            JSON.stringify(outbound[0]?.body)
        );

        stubFetch(async () =>
            jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] })
        );
        const invalid = await verifyTurnstile('token-invalid');
        check('an invalid token → { success: false }', invalid.success === false, JSON.stringify(invalid));
        check(
            "Cloudflare's error code becomes the reason",
            invalid.reason === 'invalid-input-response',
            JSON.stringify(invalid)
        );

        stubFetch(async () => jsonResponse({ success: false }));
        const noCode = await verifyTurnstile('token-nocode');
        check(
            "a failure with no error code → reason 'verification_failed'",
            noCode.success === false && noCode.reason === 'verification_failed',
            JSON.stringify(noCode)
        );

        stubFetch(async () => jsonResponse({ message: 'boom' }, 500));
        const httpError = await verifyTurnstile('token-http');
        check(
            "a non-2xx → { success: false, reason: 'http_500' }",
            !httpError.success && httpError.reason === 'http_500',
            JSON.stringify(httpError)
        );

        stubFetch(async () => {
            throw new TypeError('network down');
        });
        const network = await verifyTurnstile('token-network');
        check(
            "a transport error → { success: false, reason: 'network_error' }",
            !network.success && network.reason === 'network_error',
            JSON.stringify(network)
        );

        stubFetch(async () => {
            const aborted = new Error('aborted');
            aborted.name = 'AbortError';
            throw aborted;
        });
        const timedOut = await verifyTurnstile('token-timeout');
        check(
            "an abort → { success: false, reason: 'timeout' }",
            !timedOut.success && timedOut.reason === 'timeout',
            JSON.stringify(timedOut)
        );

        setSecret(undefined);
        stubFetch(async () => {
            throw new Error('fetch must not be called when the secret is missing');
        });
        let disabled: { success?: boolean; reason?: string; threw?: string } = {};
        try {
            disabled = await verifyTurnstile('token-disabled');
        } catch (error) {
            disabled = { threw: String(error) };
        }
        check(
            "a missing secret → { success: false, reason: 'disabled' } without throwing",
            disabled.success === false && disabled.reason === 'disabled',
            JSON.stringify(disabled)
        );
        check('a missing secret makes NO outbound call', outbound.length === 0);

        /* ── C. the real route ─────────────────────────────────────────────── */
        section('C. POST /api/verify-turnstile (real router)');

        setSecret('test-secret-value');
        stubFetch(async () => jsonResponse({ success: true }));

        {
            const server = await listen(buildRouteApp());

            try {
                const missing = await post(server.base, '/api/verify-turnstile', {});
                check(
                    'a missing token → 400 with the validation envelope',
                    missing.status === 400 &&
                        missing.body.success === false &&
                        missing.body.errors?.[0]?.path === 'body.token',
                    `${missing.status} ${JSON.stringify(missing.body)}`
                );

                const oversized = await post(server.base, '/api/verify-turnstile', {
                    token: 'a'.repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1),
                });
                check(
                    'an oversized token → 400',
                    oversized.status === 400 && oversized.body.success === false,
                    `${oversized.status} ${JSON.stringify(oversized.body)}`
                );

                const valid = await post(server.base, '/api/verify-turnstile', { token: 'good-token' });
                check(
                    'a valid token → 200 { success: true }',
                    valid.status === 200 && valid.body.success === true,
                    `${valid.status} ${JSON.stringify(valid.body)}`
                );
            } finally {
                await server.close();
            }
        }

        stubFetch(async () => jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
        {
            const server = await listen(buildRouteApp());

            try {
                const rejected = await post(server.base, '/api/verify-turnstile', { token: 'bad' });
                check(
                    'a token Cloudflare rejects → 200 { success: false }',
                    rejected.status === 200 && rejected.body.success === false,
                    `${rejected.status} ${JSON.stringify(rejected.body)}`
                );
            } finally {
                await server.close();
            }
        }

        /* ── D. rate limit ─────────────────────────────────────────────────── */
        section('D. rate limit');

        setSecret('test-secret-value');
        stubFetch(async () => jsonResponse({ success: true }));

        check(
            'the turnstile limit is a positive integer',
            Number.isInteger(TURNSTILE_LIMIT.limit) && TURNSTILE_LIMIT.limit > 0,
            String(TURNSTILE_LIMIT.limit)
        );

        {
            const server = await listen(buildRateLimitedApp());

            try {
                let firstLimited = -1;

                for (let index = 0; index < TURNSTILE_LIMIT.limit + 2; index += 1) {
                    const response = await post(server.base, '/api/verify-turnstile', { token: 'limited' });

                    if (response.status === 429) {
                        firstLimited = index;
                        break;
                    }
                }

                check(
                    `the route answers 429 only after ${TURNSTILE_LIMIT.limit} requests`,
                    firstLimited === TURNSTILE_LIMIT.limit,
                    `first 429 at request #${firstLimited + 1}`
                );
            } finally {
                await server.close();
            }
        }

        /* ── E. negative control ───────────────────────────────────────────── */
        section('E. Negative control: the schema is load-bearing');

        setSecret('test-secret-value');
        stubFetch(async () => jsonResponse({ success: true }));

        {
            const server = await listen(buildRouteApp());

            try {
                const withSchema = await post(server.base, '/api/verify-turnstile', {});
                check('WITH the schema, an empty body never reaches the handler (400)', withSchema.status === 400);
            } finally {
                await server.close();
            }
        }

        {
            const server = await listen(buildSchemaLessApp());

            try {
                const withoutSchema = await post(server.base, '/api/verify-turnstile', {});
                check(
                    'WITHOUT the schema, the same request is no longer a 400',
                    withoutSchema.status !== 400,
                    `status=${withoutSchema.status}`
                );
                check(
                    'WITHOUT the schema, the missing token surfaces as an unhandled 500',
                    withoutSchema.status === 500,
                    `measured status=${withoutSchema.status} body=${JSON.stringify(withoutSchema.body)}`
                );
            } finally {
                await server.close();
            }
        }

        /* ── F. static wiring ─────────────────────────────────────────────── */
        section('F. Static wiring');

        const appModule = stripCommentLines(readFileSync(APP_MODULE_FILE, 'utf8'));
        const routesSource = stripCommentLines(readFileSync(ROUTES_FILE, 'utf8'));
        const serviceSource = stripCommentLines(readFileSync(SERVICE_FILE, 'utf8'));
        const rateLimiterSource = stripCommentLines(readFileSync(RATE_LIMITER_FILE, 'utf8'));

        check(
            'app.module mounts /api/verify-turnstile behind turnstileLimiter',
            /app\.use\(\s*'\/api\/verify-turnstile'\s*,\s*turnstileLimiter\s*,\s*turnstileRoutes\s*\)/.test(
                appModule
            ),
            'the mount is missing or is not limiter-first'
        );
        check(
            'the route validates the body with verifyTurnstileSchema',
            /validate\(\s*\{\s*body:\s*verifyTurnstileSchema/.test(routesSource)
        );
        check(
            'the route is public (no adminGuard / protect / adminOnly)',
            !/adminGuard|adminOnly|\bprotect\b/.test(routesSource)
        );
        check(
            'the service uses native fetch (no SDK, no require)',
            !/from\s+'(@cloudflare|node-fetch|undici)'/.test(serviceSource) && !/\brequire\(/.test(serviceSource)
        );
        check(
            'the service wires the abort-based timeout',
            serviceSource.includes('AbortController') && serviceSource.includes('TURNSTILE_TIMEOUT_MS')
        );

        const consoleCalls = Array.from(serviceSource.matchAll(/console\.[a-z]+\([^;]*\)/g)).map(
            (match) => match[0]
        );
        check(
            'the service makes exactly one console call',
            consoleCalls.length === 1,
            String(consoleCalls.length)
        );
        check(
            'that call never references the token or the secret value',
            consoleCalls.every((call) => !/\btoken\b/.test(call) && !/\$\{\s*secret\s*\}/.test(call)),
            consoleCalls.join(' | ')
        );
        check(
            'no limiter sets a custom keyGenerator (v8 keeps IPv6 normalisation)',
            !/keyGenerator\s*:/.test(rateLimiterSource)
        );
        check(
            'the rate-limit module exports a dedicated turnstileLimiter',
            /export const turnstileLimiter/.test(rateLimiterSource)
        );

        /* ── G. requireTurnstile, in front of a trivial handler ─────────────── */
        section('G. requireTurnstile, in front of a trivial handler');

        // A probe app rather than a real route: with no database in this harness a
        // controller cannot answer 200, and "next() ran" is exactly what this
        // section has to observe.
        const buildProbeApp = (): express.Express => {
            const app = express();
            app.use(requestId);
            app.use(express.json());
            app.post('/probe', requireTurnstile, (_req, res) => {
                res.json({ success: true, reached: true });
            });
            app.use(notFoundHandler);
            app.use(errorHandler);

            return app;
        };

        const PROBE_BODY = { any: 'body' };

        setSecret('test-secret-value');
        stubFetch(async () => jsonResponse({ success: true }));

        {
            const server = await listen(buildProbeApp());

            try {
                const noHeader = await post(server.base, '/probe', PROBE_BODY);
                check(
                    'no header → 400 TURNSTILE_MISSING with the stable code and wording',
                    noHeader.status === 400 &&
                        noHeader.body.code === TURNSTILE_MISSING_CODE &&
                        noHeader.body.message === TURNSTILE_MISSING_MESSAGE,
                    `${noHeader.status} ${JSON.stringify(noHeader.body)}`
                );
                check(
                    'a missing token never reaches Siteverify',
                    outbound.length === 0,
                    String(outbound.length)
                );

                const blankHeader = await post(server.base, '/probe', PROBE_BODY, {
                    [TURNSTILE_TOKEN_HEADER]: '   ',
                });
                check(
                    'a blank header is treated as missing, not as a token',
                    blankHeader.status === 400 && blankHeader.body.code === TURNSTILE_MISSING_CODE,
                    `${blankHeader.status} ${JSON.stringify(blankHeader.body)}`
                );

                const good = await post(server.base, '/probe', PROBE_BODY, {
                    [TURNSTILE_TOKEN_HEADER]: 'good-token',
                });
                check(
                    'a valid token calls next() — the handler answers 200',
                    good.status === 200 && good.body.reached === true,
                    `${good.status} ${JSON.stringify(good.body)}`
                );
                check(
                    'and that request DID reach Siteverify, with the token in the body',
                    outbound.length === 1 && outbound[0]?.body?.response === 'good-token',
                    JSON.stringify(outbound)
                );
            } finally {
                await server.close();
            }
        }

        stubFetch(async () => jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
        {
            const server = await listen(buildProbeApp());

            try {
                const rejected = await post(server.base, '/probe', PROBE_BODY, {
                    [TURNSTILE_TOKEN_HEADER]: 'bad-token',
                });
                check(
                    'a token Cloudflare rejects → 400 TURNSTILE_FAILED',
                    rejected.status === 400 && rejected.body.code === TURNSTILE_FAILED_CODE,
                    `${rejected.status} ${JSON.stringify(rejected.body)}`
                );
                check(
                    "the Siteverify reason is NOT echoed to the client",
                    !JSON.stringify(rejected.body).includes('invalid-input-response'),
                    JSON.stringify(rejected.body)
                );
            } finally {
                await server.close();
            }
        }

        setSecret(undefined);
        stubFetch(async () => {
            throw new Error('Siteverify must not be called without a secret');
        });
        {
            const server = await listen(buildProbeApp());

            try {
                const failOpen = await post(server.base, '/probe', PROBE_BODY);
                check(
                    'no secret → the request passes through (dev/preview fail-open)',
                    failOpen.status === 200 && failOpen.body.reached === true,
                    `${failOpen.status} ${JSON.stringify(failOpen.body)}`
                );
                check('no secret → no Siteverify call', outbound.length === 0, String(outbound.length));
            } finally {
                await server.close();
            }
        }

        /* ── H. Wiring: structural, then one live route ─────────────────────── */
        section('H. requireTurnstile is mounted on exactly the write routes');

        /**
         * Splits a route file on `router.` and reads each registration.
         *
         * Deliberately not a paren-matching parser: `router.post('/', a({ b }), h)`
         * contains nested parens, so a non-greedy `\);` regex stops in the wrong
         * place. Slicing on the `router.` boundary sidesteps that entirely, and the
         * comments are stripped first so the middleware's own name in a comment
         * cannot be mistaken for a mount.
         */
        const registrations = (source: string): Registration[] =>
            source
                .split(/\brouter\./)
                .slice(1)
                .map((chunk) => ({
                    method: (chunk.match(/^(get|post|put|patch|delete)\b/) ?? [])[1] ?? '',
                    path: (chunk.match(/'([^']*)'/) ?? [])[1] ?? '',
                    hasTurnstile: chunk.includes('requireTurnstile'),
                }))
                .filter((entry) => entry.method !== '');

        let wiredWrites = 0;

        for (const expectation of PROTECTED_ROUTES) {
            const entries = registrations(stripCommentLines(readFileSync(expectation.file, 'utf8')));

            for (const wanted of expectation.expected) {
                const match = entries.find(
                    (entry) => entry.method === wanted.method && entry.path === wanted.path
                );
                const wired = match !== undefined && match.hasTurnstile;

                check(
                    `${expectation.label}: ${wanted.method.toUpperCase()} ${wanted.path} mounts requireTurnstile`,
                    wired,
                    match === undefined ? 'registration not found' : 'middleware missing'
                );

                if (wired) wiredWrites += 1;
            }

            const leakedGets = entries.filter((entry) => entry.method === 'get' && entry.hasTurnstile);
            check(
                `${expectation.label}: no GET carries it (public reads and crawlers are untouched)`,
                leakedGets.length === 0,
                leakedGets.map((entry) => `GET ${entry.path}`).join(', ')
            );
        }

        check('all six protected writes are wired', wiredWrites === 6, String(wiredWrites));

        // The structural checks above prove the mount exists. This one proves the
        // mount is LOAD-BEARING on a real router, by driving the refusal through it.
        //
        // `loginUser` needs MongoDB, and this harness has none — so a request that
        // gets PAST the middleware still ends in a 500. That is the point: the
        // assertion is "no longer refused by the security check", not "200", and
        // the buffer timeout is shortened so the wait is ~200ms instead of 10s.
        mongoose.set('bufferTimeoutMS', 200);

        const buildAuthApp = (): express.Express => {
            const app = express();
            app.use(requestId);
            app.use(express.json());
            app.use('/api/auth', authRoutes);
            app.use(notFoundHandler);
            app.use(errorHandler);

            return app;
        };

        const VALID_LOGIN_BODY = { username: 'someone', password: 'password123' };

        setSecret('test-secret-value');
        stubFetch(async () => jsonResponse({ success: true }));

        {
            const server = await listen(buildAuthApp());

            try {
                const withoutToken = await post(server.base, '/api/auth/login', VALID_LOGIN_BODY);
                check(
                    'the real POST /api/auth/login refuses a token-less write (TURNSTILE_MISSING)',
                    withoutToken.status === 400 && withoutToken.body.code === TURNSTILE_MISSING_CODE,
                    `${withoutToken.status} ${JSON.stringify(withoutToken.body)}`
                );

                stubFetch(async () => jsonResponse({ success: true }));
                const withToken = await post(server.base, '/api/auth/login', VALID_LOGIN_BODY, {
                    [TURNSTILE_TOKEN_HEADER]: 'good-token',
                });
                check(
                    'the same write WITH a token is no longer refused by the security check',
                    withToken.body.code !== TURNSTILE_MISSING_CODE &&
                        withToken.body.code !== TURNSTILE_FAILED_CODE,
                    `${withToken.status} ${JSON.stringify(withToken.body)}`
                );
                check(
                    'and the token was actually exchanged with Siteverify',
                    outbound.length === 1 && outbound[0]?.body?.response === 'good-token',
                    JSON.stringify(outbound)
                );
            } finally {
                await server.close();
            }
        }

        /* ── I. Negative control ───────────────────────────────────────────── */
        section('I. Negative control: the refusal is attributable to the middleware');

        // Same request, same route, secret removed. If the 400 above were coming
        // from anything other than `requireTurnstile` (validation, a route guard),
        // it would still be a 400 here — and this check would fail.
        //
        // The `remove the middleware from auth.routes.ts` trial is the structural
        // check in section H: it reads the file, so deleting the mount fails the
        // suite. It was also performed by hand — see the report.
        setSecret(undefined);
        stubFetch(async () => {
            throw new Error('Siteverify must not be called without a secret');
        });

        {
            const server = await listen(buildAuthApp());

            try {
                const failOpen = await post(server.base, '/api/auth/login', VALID_LOGIN_BODY);
                check(
                    'WITHOUT a secret the same token-less write is NOT refused (fail-open)',
                    failOpen.body.code !== TURNSTILE_MISSING_CODE,
                    `${failOpen.status} ${JSON.stringify(failOpen.body)}`
                );
                check(
                    'and nothing was sent to Siteverify',
                    outbound.length === 0,
                    String(outbound.length)
                );
            } finally {
                await server.close();
            }
        }
    } finally {
        restoreFetch();

        if (originalSecret === undefined) {
            delete process.env.TURNSTILE_SECRET_KEY;
        } else {
            process.env.TURNSTILE_SECRET_KEY = originalSecret;
        }
    }

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

    console.log('All Turnstile verification checks passed.');
};

void main();
