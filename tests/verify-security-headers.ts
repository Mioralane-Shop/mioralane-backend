/**
 * P0-5 — security headers, CORS, trust proxy, rate limits and docs gating.
 *
 * Run with: npm run verify:security-headers
 *
 * Every check runs against the REAL app. `createApp({ skipDatabaseCheck: true })`
 * mounts the actual middleware chain — the same CORS callback, the same helmet
 * configuration, the same limiters built by the same factories — with only the
 * guard-then-connect middleware omitted. Nothing here re-implements the wiring it
 * is checking, because a harness that mirrors the app only proves the mirror.
 *
 * The env-driven behaviours (doc gating, `CORS_ORIGINS`, limit ceilings) are
 * tested by setting the variable and calling `createApp()` again: the config is
 * read at construction time, so this is exactly how a redeploy behaves.
 *
 * Request paths are restricted to ones that never touch MongoDB — `/api/health`,
 * the docs routes and unmatched paths — since there is no database here.
 *
 * Negative controls are built in, one per control under test: a probe app with
 * `trust proxy` set exercises the fix, and the same probe app without it must
 * exhibit the bug. A check that passes either way would be measuring nothing.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Express } from 'express';
import express from 'express';
import { DEFAULT_ALLOWED_ORIGINS, getAllowedOrigins } from '../src/config/allowed-origins';
import {
    DEFAULT_TRUST_PROXY_HOPS,
    MAX_TRUST_PROXY_HOPS,
    readTrustProxyHops,
} from '../src/config/trust-proxy';
import { errorHandler, notFoundHandler, requestId } from '../src/middleware/error.middleware';
import {
    AUTH_LIMIT,
    DEFAULT_RATE_LIMIT_SETTINGS,
    createGlobalLimiter,
    createWriteLimiter,
    isStateChangingMethod,
    readRateLimitSettings,
} from '../src/middleware/rateLimiter.middleware';
import { createApiDocsHandlers, handleOpenApiJson, isApiDocsEnabled } from '../src/swagger';

const SRC_DIR = join(__dirname, '..', 'src');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');
const MAIN_FILE = join(SRC_DIR, 'main.ts');
const API_INDEX_FILE = join(__dirname, '..', 'api', 'index.ts');
const ACTIVITY_LOG_SERVICE_FILE = join(SRC_DIR, 'activity-log', 'activity-log.service.ts');
const RATE_LIMITER_FILE = join(SRC_DIR, 'middleware', 'rateLimiter.middleware.ts');

const failures: string[] = [];

/**
 * Assigned in `main()` from a dynamic import — see {@link ensureProbeEnv}.
 *
 * Typed from the module's own default export rather than restated by hand: a
 * hand-written `(options?: {…}) => Express` annotation looks equivalent but is
 * not, because Express's `Application` is not assignable to its `Express`
 * interface. Deriving the type means the two can never drift.
 */
let createApp: typeof import('../src/app.module')['default'];

/**
 * Inert ImageKit placeholders.
 *
 * `media.routes.ts` constructs an `ImageKitService` at module load, and that
 * constructor throws when the three ImageKit variables are empty — so importing
 * `app.module` without them aborts the process before a single check runs. This
 * harness never calls ImageKit; it needs only for the import to succeed.
 *
 * `??=` rather than `=`: a real value (from a developer's `.env`, loaded by an
 * entrypoint) wins, and nothing here reads or prints one.
 */
const ensureProbeEnv = (): void => {
    process.env.IMAGEKIT_URL_ENDPOINT ??= 'https://ik.imagekit.io/probe-endpoint';
    process.env.IMAGEKIT_PUBLIC_KEY ??= 'probe-public-key';
    process.env.IMAGEKIT_PRIVATE_KEY ??= 'probe-private-key';
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

/**
 * Strips comment-ONLY lines so structural assertions read code, not prose.
 *
 * The modules under test document the behaviour they replace (`X-Forwarded-For`,
 * `swaggerServe`), so a raw text search would match documentation. Line-based on
 * purpose — a character-level stripper would have to understand template and
 * regex literals.
 */
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

/* ──────────────────────────── http helpers ──────────────────────────── */

type ProbeResponse = {
    status: number;
    body: unknown;
    text: string;
    headers: Headers;
};

/**
 * `express.Application`, not the exported `Express` type: `Express` *extends*
 * `Application` (it adds the `request`/`response` singletons), so the two are not
 * interchangeable — and `createApp()` is declared to return `Application`.
 */
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

const envelopeOf = (body: unknown): { success?: unknown; message?: unknown } =>
    typeof body === 'object' && body !== null ? (body as { success?: unknown; message?: unknown }) : {};

/** Case-insensitive header lookup that returns '' rather than null. */
const headerOf = (headers: Headers, name: string): string => headers.get(name) ?? '';

/** Any `RateLimit-*` header, whatever its casing. */
const rateLimitHeaderNames = (headers: Headers): string[] =>
    [...headers.keys()].filter((key) => key.toLowerCase().startsWith('ratelimit'));

/**
 * Sets the given env vars, builds a fresh app, runs the probe, then restores the
 * environment — in a `finally`, so a failing assertion cannot leak a variable
 * into a later scenario and make it pass for the wrong reason.
 */
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

/** Collects everything written to stderr while `run` executes. */
const captureConsoleError = async (run: () => Promise<void>): Promise<string> => {
    const original = console.error;
    const lines: string[] = [];

    console.error = (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
        await run();
    } finally {
        console.error = original;
    }

    return lines.join('\n');
};

/** Probe app with the real limiter, optionally with `trust proxy` configured. */
const buildLimitProbeApp = (
    trustProxy: number | false,
    settings: { windowMs: number; max: number }
): Express => {
    const app = express();

    if (trustProxy !== false) {
        app.set('trust proxy', trustProxy);
    }

    app.use(requestId);
    app.use(
        createGlobalLimiter({
            windowMs: settings.windowMs,
            globalMax: settings.max,
            writeMax: settings.max,
        })
    );

    app.get('/ping', (_req, res) => {
        res.json({ success: true });
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

    /* ── A. helmet headers ─────────────────────────────────────────────── */
    section('A. Security headers (helmet)');

    await withApp({}, async (port) => {
        const ok = await call(port, '/api/health');

        check('health endpoint reachable without the DB middleware', ok.status === 200, `status ${ok.status}`);

        check(
            'X-Content-Type-Options: nosniff',
            headerOf(ok.headers, 'x-content-type-options') === 'nosniff',
            headerOf(ok.headers, 'x-content-type-options')
        );
        check(
            'X-Frame-Options: DENY (frameguard, not the helmet SAMEORIGIN default)',
            headerOf(ok.headers, 'x-frame-options') === 'DENY',
            headerOf(ok.headers, 'x-frame-options')
        );
        check(
            'Referrer-Policy: no-referrer',
            headerOf(ok.headers, 'referrer-policy') === 'no-referrer',
            headerOf(ok.headers, 'referrer-policy')
        );
        check(
            'Strict-Transport-Security present with max-age and includeSubDomains',
            /max-age=31536000/.test(headerOf(ok.headers, 'strict-transport-security')) &&
                /includeSubDomains/.test(headerOf(ok.headers, 'strict-transport-security')),
            headerOf(ok.headers, 'strict-transport-security')
        );
        check(
            'Cross-Origin-Resource-Policy: cross-origin (ImageKit assets must keep loading)',
            headerOf(ok.headers, 'cross-origin-resource-policy') === 'cross-origin',
            headerOf(ok.headers, 'cross-origin-resource-policy')
        );
        check(
            'Content-Security-Policy is absent (JSON API, CSP disabled)',
            headerOf(ok.headers, 'content-security-policy') === '',
            headerOf(ok.headers, 'content-security-policy')
        );
        check(
            'X-Powered-By is absent (Express fingerprint removed)',
            headerOf(ok.headers, 'x-powered-by') === '',
            headerOf(ok.headers, 'x-powered-by')
        );

        // Headers must also be on the paths that fail, or a client learns from a
        // 404 whether the app is what it thinks it is.
        const missing = await call(port, '/definitely-not-a-route');

        check(
            'headers also present on a 404',
            missing.status === 404 && headerOf(missing.headers, 'x-content-type-options') === 'nosniff',
            `status ${missing.status} nosniff="${headerOf(missing.headers, 'x-content-type-options')}"`
        );

        const denied = await call(port, '/api/health', { headers: { Origin: 'https://evil.example' } });

        check(
            'headers also present on a CORS-denied 403 (helmet precedes CORS)',
            denied.status === 403 && headerOf(denied.headers, 'x-frame-options') === 'DENY',
            `status ${denied.status} xfo="${headerOf(denied.headers, 'x-frame-options')}"`
        );
    });

    /* ── B. trust proxy and client IP ──────────────────────────────────── */
    section('B. trust proxy / client IP');

    // The real app, at a ceiling of 1. With `trust proxy` honoured, two distinct
    // X-Forwarded-For values are two distinct buckets and both succeed; with it
    // missing, both requests key on the socket address and the second is refused.
    // This is the check that fails if `app.set('trust proxy', …)` is removed.
    await withApp({ RATE_LIMIT_GLOBAL_MAX: '1', RATE_LIMIT_WRITE_MAX: '1' }, async (port) => {
        const first = await call(port, '/api/health', {
            headers: { 'X-Forwarded-For': '198.51.100.1' },
        });
        const second = await call(port, '/api/health', {
            headers: { 'X-Forwarded-For': '198.51.100.2' },
        });

        check(
            'real app honours trust proxy: two forwarded clients get separate buckets',
            first.status === 200 && second.status === 200,
            `${first.status}/${second.status} — both keyed on the proxy address`
        );
    });

    check(
        'default hop count is 1 (Cloudflare -> Vercel)',
        DEFAULT_TRUST_PROXY_HOPS === 1 && readTrustProxyHops(undefined) === 1,
        `default=${DEFAULT_TRUST_PROXY_HOPS}`
    );
    check(
        'TRUST_PROXY_HOPS is clamped, never trusted blindly',
        readTrustProxyHops('99') === DEFAULT_TRUST_PROXY_HOPS &&
            readTrustProxyHops('-1') === DEFAULT_TRUST_PROXY_HOPS &&
            readTrustProxyHops('abc') === DEFAULT_TRUST_PROXY_HOPS &&
            readTrustProxyHops('2') === 2 &&
            readTrustProxyHops('0') === 0,
        `max=${MAX_TRUST_PROXY_HOPS}`
    );

    // Behavioural proof that the key is the CLIENT address, not the peer's:
    // two callers behind the same proxy must get separate buckets.
    const settings = { windowMs: 60_000, max: 2 };

    await (async () => {
        const server = await listen(buildLimitProbeApp(1, settings));
        const port = portOf(server);

        try {
            const first = await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
            const second = await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
            const third = await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
            const other = await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.2' } });

            check(
                'a client is limited after exceeding the ceiling (XFF honoured)',
                first.status === 200 && second.status === 200 && third.status === 429,
                `${first.status}/${second.status}/${third.status}`
            );
            check(
                'a DIFFERENT client behind the same proxy is NOT limited (own bucket)',
                other.status === 200,
                `status ${other.status} — all callers share one bucket`
            );
        } finally {
            server.close();
        }
    })();

    // Negative control: identical probe, no trust proxy. Every caller collapses
    // into one bucket, which is the P0-1 deferral this block closes.
    await (async () => {
        const server = await listen(buildLimitProbeApp(false, settings));
        const port = portOf(server);

        try {
            await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
            await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
            const other = await call(port, '/ping', { headers: { 'X-Forwarded-For': '203.0.113.9' } });

            check(
                'negative control: WITHOUT trust proxy a second client is locked out too',
                other.status === 429,
                `status ${other.status} — the probe is not sensitive to trust proxy`
            );
        } finally {
            server.close();
        }
    })();

    // express-rate-limit v8 reports the misconfiguration itself; assert the
    // diagnostic appears without trust proxy and is gone with it.
    const warningWithout = await captureConsoleError(async () => {
        const server = await listen(buildLimitProbeApp(false, settings));

        try {
            await call(portOf(server), '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
        } finally {
            server.close();
        }
    });

    const warningWith = await captureConsoleError(async () => {
        const server = await listen(buildLimitProbeApp(1, settings));

        try {
            await call(portOf(server), '/ping', { headers: { 'X-Forwarded-For': '203.0.113.1' } });
        } finally {
            server.close();
        }
    });

    check(
        'v8 emits ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when trust proxy is unset',
        warningWithout.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'),
        warningWithout.slice(0, 140) || 'no console.error output captured'
    );
    check(
        'that warning is gone once trust proxy is set',
        !warningWith.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'),
        warningWith.slice(0, 140) || 'clean'
    );

    // IPv6: the default key generator masks to the /56 subnet, so one allocation
    // cannot be used to multiply a bucket. No custom keyGenerator is configured,
    // which is what keeps this property (see the rate limiter's module note).
    const subnetA = ipKeyGenerator('2001:db8:0:0::1');
    const subnetB = ipKeyGenerator('2001:db8:0:0::99');
    const subnetOther = ipKeyGenerator('2001:db8:1:0::1');

    check(
        'ipKeyGenerator collapses addresses within one IPv6 /56',
        subnetA === subnetB,
        `${subnetA} vs ${subnetB}`
    );
    check('ipKeyGenerator separates different /56 subnets', subnetA !== subnetOther);

    await (async () => {
        const server = await listen(buildLimitProbeApp(1, { windowMs: 60_000, max: 2 }));
        const port = portOf(server);

        try {
            const a = await call(port, '/ping', { headers: { 'X-Forwarded-For': '2001:db8:0:0::1' } });
            const b = await call(port, '/ping', { headers: { 'X-Forwarded-For': '2001:db8:0:0::99' } });
            const c = await call(port, '/ping', { headers: { 'X-Forwarded-For': '2001:db8:0:0::50' } });

            check(
                'IPv6 /56 normalisation is active on the mounted limiter',
                a.status === 200 && b.status === 200 && c.status === 429,
                `${a.status}/${b.status}/${c.status} — raw-IP keying would not trip`
            );
        } finally {
            server.close();
        }
    })();

    /* ── C. CORS_ORIGINS override ──────────────────────────────────────── */
    section('C. CORS origins (env override)');

    check(
        'the built-in default list is unchanged when CORS_ORIGINS is unset',
        getAllowedOrigins().length === DEFAULT_ALLOWED_ORIGINS.length,
        `${getAllowedOrigins().length} vs ${DEFAULT_ALLOWED_ORIGINS.length}`
    );

    await withApp({ CORS_ORIGINS: 'https://staging.example' }, async (port) => {
        const staging = await call(port, '/api/health', { headers: { Origin: 'https://staging.example' } });

        check(
            'an origin from CORS_ORIGINS is allowed',
            staging.status === 200 &&
                headerOf(staging.headers, 'access-control-allow-origin') === 'https://staging.example',
            `${staging.status} acao="${headerOf(staging.headers, 'access-control-allow-origin')}"`
        );

        // Override, not extend: this is what lets production drop localhost.
        const localhost = await call(port, '/api/health', { headers: { Origin: 'http://localhost:3000' } });

        check(
            'CORS_ORIGINS OVERRIDES the built-in list (localhost now refused)',
            localhost.status === 403,
            `status ${localhost.status}`
        );

        const unknown = await call(port, '/api/health', { headers: { Origin: 'https://mioralane.com' } });

        check(
            'a built-in origin is refused while the override is active',
            unknown.status === 403,
            `status ${unknown.status}`
        );
    });

    await withApp({ CORS_ORIGINS: undefined }, async (port) => {
        const staging = await call(port, '/api/health', { headers: { Origin: 'https://staging.example' } });

        check(
            'negative control: without the override that origin is refused',
            staging.status === 403,
            `status ${staging.status} — the override assertion is not vacuous`
        );
    });

    await withApp(
        { CORS_ORIGINS: 'https://ok.example,*,https://x.example/path,not-a-host,https://ok.example' },
        async (port) => {
            const valid = await call(port, '/api/health', { headers: { Origin: 'https://ok.example' } });

            check('valid entries in a mixed list are still honoured', valid.status === 200, `status ${valid.status}`);

            const wildcard = await call(port, '/api/health', { headers: { Origin: '*' } });

            check(
                'a wildcard entry is rejected, not trusted (credentials are in play)',
                wildcard.status === 403 && getAllowedOrigins().every((origin) => origin !== '*'),
                `status ${wildcard.status}`
            );
            check(
                'an entry with a path is rejected',
                getAllowedOrigins().every((origin) => origin === 'https://ok.example'),
                getAllowedOrigins().join(',')
            );
        }
    );

    await withApp({ CORS_ORIGINS: '*' }, async (port) => {
        const localhost = await call(port, '/api/health', { headers: { Origin: 'http://localhost:3000' } });

        check(
            'an unusable CORS_ORIGINS falls back to the built-in list (no outage)',
            localhost.status === 200,
            `status ${localhost.status}`
        );
    });

    await withApp({}, async (port) => {
        const preflight = await call(port, '/api/health', {
            method: 'OPTIONS',
            headers: {
                Origin: 'http://localhost:3000',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            },
        });

        check(
            'preflight is answered with the allow-origin header',
            preflight.status < 400 &&
                headerOf(preflight.headers, 'access-control-allow-origin') === 'http://localhost:3000',
            `${preflight.status} acao="${headerOf(preflight.headers, 'access-control-allow-origin')}"`
        );
        check(
            'preflight result is cacheable for a day (maxAge 86400)',
            headerOf(preflight.headers, 'access-control-max-age') === '86400',
            headerOf(preflight.headers, 'access-control-max-age')
        );
    });

    /* ── D. rate limits ────────────────────────────────────────────────── */
    section('D. Rate limits');

    check(
        'default ceilings match the specified tiers (300 global / 60 write / 15 min)',
        DEFAULT_RATE_LIMIT_SETTINGS.globalMax === 300 &&
            DEFAULT_RATE_LIMIT_SETTINGS.writeMax === 60 &&
            DEFAULT_RATE_LIMIT_SETTINGS.windowMs === 900000,
        JSON.stringify(DEFAULT_RATE_LIMIT_SETTINGS)
    );
    check(
        'authLimiter is still the strict tier (15 per minute)',
        AUTH_LIMIT.limit === 15 && AUTH_LIMIT.windowMs === 60000,
        JSON.stringify(AUTH_LIMIT)
    );
    check(
        'write tier covers exactly the state-changing methods',
        isStateChangingMethod('POST') &&
            isStateChangingMethod('put') &&
            isStateChangingMethod('PATCH') &&
            isStateChangingMethod('DELETE') &&
            !isStateChangingMethod('GET') &&
            !isStateChangingMethod('OPTIONS') &&
            !isStateChangingMethod('HEAD')
    );
    check(
        'invalid tunables fall back instead of breaking the boot',
        readRateLimitSettings({ RATE_LIMIT_GLOBAL_MAX: 'abc' } as NodeJS.ProcessEnv).globalMax === 300 &&
            readRateLimitSettings({ RATE_LIMIT_GLOBAL_MAX: '-5' } as NodeJS.ProcessEnv).globalMax === 300 &&
            readRateLimitSettings({ RATE_LIMIT_GLOBAL_MAX: '25' } as NodeJS.ProcessEnv).globalMax === 25
    );

    await withApp({ RATE_LIMIT_GLOBAL_MAX: '3', RATE_LIMIT_WRITE_MAX: '2' }, async (port) => {
        const statuses: number[] = [];
        let last: ProbeResponse | null = null;

        for (let index = 0; index < 4; index += 1) {
            last = await call(port, '/api/health');
            statuses.push(last.status);
        }

        check(
            'global tier returns 429 once the ceiling is passed',
            statuses.slice(0, 3).every((status) => status === 200) && statuses[3] === 429,
            statuses.join('/')
        );
        check(
            "429 body matches the terminal error handler's envelope",
            last !== null &&
                envelopeOf(last.body).success === false &&
                envelopeOf(last.body).message === 'Too many requests',
            JSON.stringify(last?.body)
        );
        check(
            '429 carries RateLimit-* headers so a client can back off',
            last !== null && rateLimitHeaderNames(last.headers).length >= 2,
            last !== null ? rateLimitHeaderNames(last.headers).join(',') : 'none'
        );

        // A fresh app for the write tier: the global bucket above is exhausted.
    });

    await withApp({ RATE_LIMIT_GLOBAL_MAX: '100', RATE_LIMIT_WRITE_MAX: '2' }, async (port) => {
        const first = await call(port, '/nonexistent', { method: 'POST' });
        const second = await call(port, '/nonexistent', { method: 'POST' });
        const third = await call(port, '/nonexistent', { method: 'POST' });

        check(
            'write tier limits POST after its own lower ceiling',
            first.status === 404 && second.status === 404 && third.status === 429,
            `${first.status}/${second.status}/${third.status}`
        );

        // The write bucket is exhausted; reads must be unaffected. This is what
        // proves the `skip` predicate, not just that a limiter exists.
        const read = await call(port, '/api/health');

        check(
            'a GET is unaffected by the exhausted write bucket',
            read.status === 200,
            `status ${read.status} — the write tier is not skipping reads`
        );
    });

    /* ── E. docs gating ────────────────────────────────────────────────── */
    section('E. API docs gating');

    check(
        'isApiDocsEnabled is false only for production',
        isApiDocsEnabled('production') === false &&
            isApiDocsEnabled('development') === true &&
            isApiDocsEnabled('test') === true &&
            isApiDocsEnabled(undefined) === true,
        `prod=${isApiDocsEnabled('production')} dev=${isApiDocsEnabled('development')}`
    );
    check(
        'prod builds no docs handlers at all (not merely gated inside)',
        createApiDocsHandlers('production').length === 0 &&
            createApiDocsHandlers('development').length > 0,
        `prod=${createApiDocsHandlers('production').length} dev=${createApiDocsHandlers('development').length}`
    );

    // Mount the REAL handlers, once as production would (nothing) and once as
    // development would.
    const buildDocsProbeApp = (env: string): Express => {
        const app = express();
        const handlers = createApiDocsHandlers(env);

        if (handlers.length > 0) {
            app.use('/api/docs', ...handlers);
            app.get('/api/docs-json', handleOpenApiJson);
        }

        app.use(notFoundHandler);
        app.use(errorHandler);

        return app;
    };

    await (async () => {
        const devServer = await listen(buildDocsProbeApp('development'));
        const prodServer = await listen(buildDocsProbeApp('production'));

        try {
            const devUi = await call(portOf(devServer), '/api/docs/');
            const devJson = await call(portOf(devServer), '/api/docs-json');
            const prodUi = await call(portOf(prodServer), '/api/docs/');
            const prodJson = await call(portOf(prodServer), '/api/docs-json');

            check('development: /api/docs serves the UI', devUi.status === 200, `status ${devUi.status}`);
            check(
                'development: /api/docs-json serves the raw document',
                devJson.status === 200 && devJson.text.includes('"openapi"'),
                `status ${devJson.status}`
            );
            check('production: /api/docs is a 404', prodUi.status === 404, `status ${prodUi.status}`);
            check('production: /api/docs-json is a 404', prodJson.status === 404, `status ${prodJson.status}`);
            check(
                "production: the 404 is the standard envelope, not a hint that docs exist",
                (() => {
                    const body = (prodJson.body ?? {}) as { message?: unknown };

                    return body.message === 'Not found' && !prodJson.text.includes('openapi');
                })(),
                prodJson.text.slice(0, 120)
            );
        } finally {
            devServer.close();
            prodServer.close();
        }
    })();

    // End to end on the real app: flip NODE_ENV and rebuild.
    await withApp({ NODE_ENV: 'production' }, async (port) => {
        const docs = await call(port, '/api/docs/');
        const json = await call(port, '/api/docs-json');

        check(
            'real app in production mode: both docs routes 404',
            docs.status === 404 && json.status === 404,
            `${docs.status}/${json.status}`
        );
    });

    await withApp({ NODE_ENV: 'development' }, async (port) => {
        const docs = await call(port, '/api/docs/');
        const json = await call(port, '/api/docs-json');

        check(
            'real app in development mode: both docs routes 200',
            docs.status === 200 && json.status === 200,
            `${docs.status}/${json.status}`
        );
    });

    /* ── F. static wiring ──────────────────────────────────────────────── */
    section('F. Static wiring checks');

    const appModule = stripCommentLines(readFileSync(APP_MODULE_FILE, 'utf8'));
    const mainSource = stripCommentLines(readFileSync(MAIN_FILE, 'utf8'));
    const apiIndexSource = stripCommentLines(readFileSync(API_INDEX_FILE, 'utf8'));
    const activityService = stripCommentLines(readFileSync(ACTIVITY_LOG_SERVICE_FILE, 'utf8'));
    const rateLimiterSource = stripCommentLines(readFileSync(RATE_LIMITER_FILE, 'utf8'));

    check(
        "app.set('trust proxy', …) is present",
        /app\.set\(\s*'trust proxy'/.test(appModule),
        "app.set('trust proxy') missing from createApp"
    );
    check(
        'trust proxy is set before the first middleware is mounted',
        appModule.indexOf("app.set('trust proxy'") < appModule.indexOf('app.use(requestId)'),
        'trust proxy is set after requestId'
    );
    check(
        'helmet is mounted',
        /app\.use\(\s*helmet\(/.test(appModule),
        'helmet is not mounted'
    );
    check(
        'helmet precedes the CORS mount (a CORS 403 still gets the headers)',
        appModule.indexOf('helmet(') < appModule.indexOf('cors({'),
        'helmet is mounted after CORS'
    );
    check(
        'both new limiters are mounted',
        appModule.includes('createGlobalLimiter(') && appModule.includes('createWriteLimiter('),
        'a limiter is not mounted'
    );
    check(
        'the docs mount is inside the gate, not unconditional',
        appModule.includes('apiDocsHandlers.length > 0'),
        'the /api/docs mount is unconditional'
    );
    check(
        'no limiters set a custom keyGenerator (so v8 keeps IPv6 normalisation)',
        !/keyGenerator\s*:/.test(rateLimiterSource),
        'a custom keyGenerator would bypass ipKeyGenerator'
    );
    check(
        "the audit log no longer reads raw X-Forwarded-For (spoofable, and now redundant)",
        !/x-forwarded-for/i.test(activityService),
        'activity-log.service.ts still reads the header directly'
    );
    check(
        'entrypoints build the app with no test seam: main.ts',
        /createApp\(\s*\)/.test(mainSource),
        'main.ts passes options to createApp'
    );
    check(
        'entrypoints build the app with no test seam: api/index.ts',
        /createApp\(\s*\)/.test(apiIndexSource),
        'api/index.ts passes options to createApp'
    );

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

    console.log('All security header checks passed.');
};

void main();
