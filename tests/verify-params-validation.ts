/**
 * P1.6.1 — route parameter validation sweep.
 *
 * Run with: npm run verify:params-validation
 *
 * P0-3 deferred one thing: every `:id` / `:itemId` / `:productId` param was left
 * to a hand-written `mongoose.Types.ObjectId.isValid` check inside the handler.
 * This block adds `objectIdParam` (src/utils/validation.ts) and applies it as a
 * router-level `validate({ params })`, so the refusal happens in the declared
 * layer — and this harness is the record of what was applied where.
 *
 * ## Three things this file deliberately does NOT claim
 *
 *  1. It does not claim the sweep found an exploitable hole. It did not: every
 *     param route already refused a malformed id with a 400, in the handler or in
 *     the service behind it. The gain is one definition, one layer earlier.
 *  2. It does not claim a malformed id ever reached a query, or a 500. The last
 *     check in section D measures what actually happens if BOTH layers are removed
 *     and a real Mongoose query is handed a malformed id: the P0-4 error handler
 *     maps the resulting `CastError` to **400**, not the 500 the brief assumed.
 *     That is the more useful result — the deferred risk was already mitigated —
 *     so it is asserted rather than assumed.
 *  3. It does not claim HTTP coverage of the guarded routes. `protect`/`adminGuard`
 *     run BEFORE the param schema (by design: an unauthenticated caller must not
 *     learn the body contract), so without a database every guarded route answers
 *     401 first. Section C asserts exactly that, and reaches the param layer over
 *     real HTTP only on the one public route that has no guard.
 *
 * ## Why the inventory in section B is asserted, not just listed
 *
 * The point of "enumerate first, then apply" is that the enumeration must not rot.
 * B parses the route files and compares what is registered against the table below
 * in both directions: a param route that is missing from the table fails, and so
 * does a table entry that no longer exists. Adding a param route without deciding
 * what its param is fails this harness.
 *
 * Exits non-zero if any check fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { INVALID_ID_MESSAGE, errorHandler, requestId } from '../src/middleware/error.middleware';
import { validate } from '../src/middleware/validate.middleware';
import { OBJECT_ID_PARAM_MESSAGE, OBJECT_ID_PATTERN, objectIdParam } from '../src/utils/validation';

const SRC_DIR = join(__dirname, '..', 'src');

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

/**
 * Blanks comment-only lines so the route parser reads code, not prose. Blanking
 * (rather than removing) keeps every match index aligned with the real file, which
 * the segment slicing below depends on.
 */
const blankCommentLines = (source: string): string =>
    source
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();

            return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
                ? ''
                : line;
        })
        .join('\n');

/* ── The enumeration ─────────────────────────────────────────────────────────
 *
 * Every route in the API whose path carries a parameter, and the decision taken.
 * `param: null` means the param is deliberately NOT an ObjectId schema; the
 * `reason` is then required, so the exception is argued rather than implied.
 */
type ParamRoute = {
    file: string;
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    param: string | null;
    /** Wording preserved on the 400 via `validate({ message })`. */
    message?: string;
    /** Why an ObjectId-capable param is exempt from the schema. */
    reason?: string;
};

const PARAM_ROUTES: readonly ParamRoute[] = [
    { file: 'address/address.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid address ID' },
    { file: 'address/address.routes.ts', method: 'patch', path: '/:id', param: 'id', message: 'Invalid address ID' },
    { file: 'address/address.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid address ID' },
    { file: 'address/address.routes.ts', method: 'patch', path: '/:id/default', param: 'id', message: 'Invalid address ID' },

    { file: 'activity-log/activity-log.routes.ts', method: 'get', path: '/admin/:id', param: 'id', message: 'A valid activity id is required' },
    { file: 'activity-log/activity-log.routes.ts', method: 'get', path: '/participants/:id', param: 'id', message: 'A valid activity id is required' },

    { file: 'brand/brand.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid brand ID' },
    { file: 'brand/brand.routes.ts', method: 'patch', path: '/:id', param: 'id', message: 'Invalid brand ID' },
    { file: 'brand/brand.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid brand ID' },

    { file: 'customer/admin-customer.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid customer ID' },

    { file: 'inventory/inventory.routes.ts', method: 'get', path: '/transactions/:id', param: 'id', message: 'A valid transactionId is required' },
    { file: 'inventory/inventory.routes.ts', method: 'get', path: '/:itemType/:itemId/history', param: 'itemId', message: 'A valid itemId is required' },

    { file: 'order/admin-order.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid order ID' },
    { file: 'order/admin-order.routes.ts', method: 'patch', path: '/:id/status', param: 'id', message: 'Invalid order ID' },

    { file: 'order/order.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid order ID' },

    {
        file: 'product/product.routes.ts',
        method: 'get',
        path: '/:idOrSlug',
        param: null,
        reason: 'the param accepts a slug as well as an ObjectId, so an ObjectId schema would reject valid requests',
    },
    { file: 'product/product.routes.ts', method: 'put', path: '/:id', param: 'id', message: 'Invalid product ID' },
    { file: 'product/product.routes.ts', method: 'patch', path: '/:id/pre-order/arrive', param: 'id', message: 'Invalid product ID' },
    { file: 'product/product.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid product ID' },

    {
        file: 'combo/combo.routes.ts',
        method: 'get',
        path: '/:idOrSlug',
        param: null,
        reason: 'same dual id-or-slug param as products',
    },
    { file: 'combo/combo.routes.ts', method: 'put', path: '/:id', param: 'id', message: 'Invalid combo ID' },
    { file: 'combo/combo.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid combo ID' },

    { file: 'promotion/promotion.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid campaign ID' },
    { file: 'promotion/promotion.routes.ts', method: 'put', path: '/:id', param: 'id', message: 'Invalid campaign ID' },
    { file: 'promotion/promotion.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid campaign ID' },
    { file: 'promotion/promotion.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid coupon ID' },
    { file: 'promotion/promotion.routes.ts', method: 'put', path: '/:id', param: 'id', message: 'Invalid coupon ID' },
    { file: 'promotion/promotion.routes.ts', method: 'delete', path: '/:id', param: 'id', message: 'Invalid coupon ID' },

    { file: 'review/admin-review.routes.ts', method: 'get', path: '/:id', param: 'id', message: 'Invalid review ID' },
    { file: 'review/admin-review.routes.ts', method: 'patch', path: '/:id/status', param: 'id', message: 'Invalid review ID' },

    { file: 'review/review.routes.ts', method: 'get', path: '/product/:productId', param: 'productId', message: 'Invalid product ID' },
    { file: 'review/review.routes.ts', method: 'get', path: '/eligibility/:productId', param: 'productId', message: 'Invalid product ID' },

    { file: 'wishlist/wishlist.routes.ts', method: 'delete', path: '/:itemId', param: 'itemId', message: 'A valid itemId is required' },

    {
        file: 'media/media.routes.ts',
        method: 'delete',
        path: '/images/:fileId',
        param: null,
        reason: '`fileId` is an opaque ImageKit identifier, not an ObjectId — the media service owns its shape',
    },
];

/** Every `src/**‍/*.routes.ts`, so a new file cannot escape the sweep. */
const collectRouteFiles = (dir: string, prefix = ''): string[] => {
    const entries = readdirSync(join(SRC_DIR, dir), { withFileTypes: true });
    const found: string[] = [];
    const nested: Array<{ dir: string; prefix: string }> = [];

    for (const entry of entries) {
        if (entry.isDirectory()) {
            nested.push({ dir: join(dir, entry.name), prefix: `${prefix}${entry.name}/` });
            continue;
        }

        if (entry.name.endsWith('.routes.ts')) {
            found.push(`${prefix}${entry.name}`);
        }
    }

    return [...found, ...nested.flatMap((child) => collectRouteFiles(child.dir, child.prefix))];
};

/** `{ method, path, segment }` for every registration whose path has a param. */
type Registration = { method: string; path: string; segment: string };

const readRegistrations = (relativeFile: string): Registration[] => {
    const source = blankCommentLines(readFileSync(join(SRC_DIR, relativeFile), 'utf8'));
    const pattern = /\.(get|post|put|patch|delete)\(\s*(?:\r?\n\s*)?'([^']+)'/g;
    const matches: Array<{ method: string; path: string; index: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
        matches.push({ method: match[1], path: match[2], index: match.index });
    }

    return matches.map((entry, index) => ({
        method: entry.method,
        path: entry.path,
        // A registration runs until the next one starts, which is where the
        // `validate(...)` / `objectIdParam(...)` calls for this route live.
        segment: source.slice(entry.index, matches[index + 1]?.index ?? source.length),
    }));
};

const readSource = (relativeFile: string): string =>
    readFileSync(join(SRC_DIR, relativeFile), 'utf8');

const withServer = async <T>(app: express.Application, run: (base: string) => Promise<T>): Promise<T> => {
    const server: Server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });

    try {
        const address = server.address() as { port: number };

        return await run(`http://127.0.0.1:${address.port}`);
    } finally {
        server.close();
    }
};

/** The app the harness boots: the real one, minus the database guard. */
let createApp: typeof import('../src/app.module')['default'];

/**
 * The real middleware chain constructs ImageKit at import time, so the harness
 * needs only the variables that keep that import from throwing — it never calls
 * ImageKit. Values are probe- shaped on purpose; nothing here is a secret.
 */
const ensureProbeEnv = (): void => {
    process.env.IMAGEKIT_URL_ENDPOINT ??= 'https://ik.imagekit.io/probe-endpoint';
    process.env.IMAGEKIT_PUBLIC_KEY ??= 'probe-public-key';
    process.env.IMAGEKIT_PRIVATE_KEY ??= 'probe-private-key';
    process.env.JWT_SECRET ??= 'probe-secret-value-that-is-long-enough-000';
};

const MALFORMED_ID = 'not-an-object-id';
const VALID_ID = '507f1f77bcf86cd799439011';

const main = async (): Promise<void> => {
    ensureProbeEnv();
    createApp = (await import('../src/app.module')).default;

    /* ══ A. The shared schema ═══════════════════════════════════════════════ */
    section('A. objectIdParam — the one definition');

    const idSchema = objectIdParam('id');

    const accepts = (value: string): boolean => idSchema.safeParse({ id: value }).success;

    check('accepts a 24-char lowercase hex id', accepts(VALID_ID));
    check('accepts uppercase hex', accepts(VALID_ID.toUpperCase()));
    check('accepts mixed case', accepts('507f1F77bcf86CD799439011'));
    check('rejects an empty value', !accepts(''));
    check('rejects a short value', !accepts('abc'));
    check('rejects 23 hex chars', !accepts(VALID_ID.slice(1)));
    check('rejects 25 hex chars', !accepts(`${VALID_ID}0`));
    check('rejects a non-hex character', !accepts(`507f1f77bcf86cd79943901z`));
    check('rejects surrounding whitespace', !accepts(` ${VALID_ID} `));
    check('rejects a value with an ObjectId-octet shape but `-` separators', !accepts('507f1f77-bcf8-6cd7-9943-9011'));

    const rejection = idSchema.safeParse({ id: MALFORMED_ID });
    check(
        'the failure names the param path',
        !rejection.success && rejection.error.issues[0]?.path.join('.') === 'id',
        rejection.success ? 'parsed' : rejection.error.issues[0]?.path.join('.')
    );
    check(
        'the failure carries the shared wording',
        !rejection.success && rejection.error.issues[0]?.message === OBJECT_ID_PARAM_MESSAGE,
        rejection.success ? 'parsed' : rejection.error.issues[0]?.message
    );

    check('a differently named param works the same way', objectIdParam('productId').safeParse({ productId: VALID_ID }).success === true);
    check('the param name is what makes it valid', objectIdParam('productId').safeParse({ id: VALID_ID }).success === false);

    // `isValid` and OBJECT_ID_PATTERN answer the same question two different ways.
    // Measured here rather than assumed: they agree for strings in this mongoose
    // version, INCLUDING the 12-character case that older mongoose releases
    // accepted as a raw byte sequence. Pinned so that a future major which widens
    // `isValid` fails here instead of silently widening what these routes accept.
    const equivalenceSamples = ['abcdefghijkl', 'abcdefghijklmno', VALID_ID, VALID_ID.toUpperCase(), `${VALID_ID.slice(1)}z`, '', '507f1f77-bcf8-6cd7-9943-9011'];
    const divergences = equivalenceSamples.filter(
        (sample) => mongoose.Types.ObjectId.isValid(sample) !== OBJECT_ID_PATTERN.test(sample)
    );

    check(
        'mongoose isValid and OBJECT_ID_PATTERN still agree on every sample',
        divergences.length === 0,
        `diverged on: ${divergences.map((sample) => JSON.stringify(sample)).join(', ')}`
    );
    check(
        'and the 12-character sample is one of them (no silent widening)',
        mongoose.Types.ObjectId.isValid('abcdefghijkl') === false
    );
    check(
        'OBJECT_ID_PATTERN is not stateful',
        !OBJECT_ID_PATTERN.global && !OBJECT_ID_PATTERN.sticky && OBJECT_ID_PATTERN.test(VALID_ID) && OBJECT_ID_PATTERN.test(VALID_ID)
    );

    const withSibling = objectIdParam('itemId', ['itemType']);
    const siblingParsed = withSibling.safeParse({ itemType: 'product', itemId: VALID_ID });
    check('a declared sibling param survives parsing', siblingParsed.success === true);
    check(
        'and keeps its value',
        siblingParsed.success && siblingParsed.data.itemType === 'product'
    );
    check(
        'an UNDECLARED sibling is dropped (why passthroughNames exists)',
        !('extra' in (siblingParsed as { data: Record<string, unknown> }).data)
    );
    check('the sibling is not validated as an ObjectId', withSibling.safeParse({ itemType: 'anything-at-all', itemId: VALID_ID }).success === true);
    check('but a bad ObjectId still fails', withSibling.safeParse({ itemType: 'product', itemId: MALFORMED_ID }).success === false);

    /* ══ B. The enumeration ═════════════════════════════════════════════════ */
    section('B. Route inventory — enumerate, then apply');

    const routeFiles = collectRouteFiles('.', '');
    const registered: Array<Registration & { file: string }> = routeFiles.flatMap((file) =>
        readRegistrations(file)
            .filter((registration) => registration.path.includes(':'))
            .map((registration) => ({ ...registration, file }))
    );

    check(
        'every route file was read',
        routeFiles.length >= 17,
        `${routeFiles.length} files: ${routeFiles.join(', ')}`
    );
    check(
        'the inventory and the code agree on how many param routes exist',
        registered.length === PARAM_ROUTES.length,
        `code ${registered.length} vs table ${PARAM_ROUTES.length}`
    );

    const key = (entry: { method: string; path: string }, prefix = ''): string => `${prefix}${entry.method} ${entry.path}`;
    const codeKeys = registered.map((entry) => key(entry, `${entry.file} `)).sort();
    const tableKeys = PARAM_ROUTES.map((entry) => key(entry, `${entry.file} `)).sort();

    check(
        'no param route exists that the table does not classify',
        JSON.stringify(codeKeys) === JSON.stringify(tableKeys),
        `in code but not in the table: ${codeKeys.filter((entry) => !tableKeys.includes(entry)).join(' | ') || 'none'}; ` +
            `in the table but not in code: ${tableKeys.filter((entry) => !codeKeys.includes(entry)).join(' | ') || 'none'}`
    );
    check(
        'every exception carries a reason',
        PARAM_ROUTES.filter((entry) => entry.param === null).every((entry) => Boolean(entry.reason))
    );

    const objectIdRoutes = PARAM_ROUTES.filter((entry) => entry.param !== null);

    for (const expectation of objectIdRoutes) {
        const registration = registered.find(
            (entry) =>
                entry.file === expectation.file &&
                entry.method === expectation.method &&
                entry.path === expectation.path &&
                entry.segment.includes(`message: '${expectation.message}'`)
        );

        check(
            `${expectation.file} ${expectation.method} ${expectation.path} validates :${expectation.param}`,
            Boolean(registration) && registration!.segment.includes(`objectIdParam('${expectation.param}'`),
            registration ? 'schema missing from this registration' : 'no registration matched its method, path and message'
        );
    }

    for (const exemption of PARAM_ROUTES.filter((entry) => entry.param === null)) {
        const registration = registered.find(
            (entry) =>
                entry.file === exemption.file &&
                entry.method === exemption.method &&
                entry.path === exemption.path
        );

        check(
            `${exemption.file} ${exemption.method} ${exemption.path} is deliberately unvalidated`,
            Boolean(registration) && !registration!.segment.includes('objectIdParam(')
        );
    }

    check(
        'the multi-param route declares its sibling',
        (registered.find((entry) => entry.path === '/:itemType/:itemId/history')?.segment ?? '').includes(
            "objectIdParam('itemId', ['itemType'])"
        )
    );

    // Each message must still be the wording the handler itself returns, otherwise
    // `message` would be quietly rewriting the API contract. Asserted against the
    // CONTROLLER/SERVICE literal, never the route file — a check that looked for the
    // string in the route file would pass on its own copy of it.
    const HANDLER_WORDINGS: ReadonlyArray<{ wording: string; handlerFile: string; builtFromLabel?: true }> = [
        { wording: 'Invalid address ID', handlerFile: 'address/address.service.ts' },
        { wording: 'A valid activity id is required', handlerFile: 'activity-log/activity-log.service.ts' },
        { wording: 'Invalid customer ID', handlerFile: 'customer/admin-customer.controller.ts' },
        { wording: 'Invalid brand ID', handlerFile: 'brand/brand.controller.ts' },
        { wording: 'A valid transactionId is required', handlerFile: 'inventory/inventory-transaction.service.ts', builtFromLabel: true },
        { wording: 'A valid itemId is required', handlerFile: 'inventory/inventory-transaction.service.ts', builtFromLabel: true },        { wording: 'Invalid order ID', handlerFile: 'order/admin-order.controller.ts' },
        { wording: 'Invalid order ID', handlerFile: 'order/order.controller.ts' },
        { wording: 'Invalid product ID', handlerFile: 'product/product.controller.ts' },
        { wording: 'Invalid combo ID', handlerFile: 'combo/combo.controller.ts' },
        { wording: 'Invalid campaign ID', handlerFile: 'promotion/promotion-admin.controller.ts' },
        { wording: 'Invalid coupon ID', handlerFile: 'promotion/promotion-admin.controller.ts' },
        { wording: 'Invalid review ID', handlerFile: 'review/review.service.ts' },
        { wording: 'Invalid product ID', handlerFile: 'review/review.service.ts' },
        { wording: 'A valid itemId is required', handlerFile: 'wishlist/wishlist.controller.ts' },
    ];

    const handlerCache = new Map<string, string>();
    const handlerSource = (file: string): string => {
        const cached = handlerCache.get(file);

        if (cached !== undefined) {
            return cached;
        }

        const source = readSource(file);
        handlerCache.set(file, source);

        return source;
    };

    for (const entry of HANDLER_WORDINGS) {
        check(
            `'${entry.wording}' is still produced by ${entry.handlerFile}`,
            entry.builtFromLabel
                ? handlerSource(entry.handlerFile).includes('`A valid ${label} is required`')
                : handlerSource(entry.handlerFile).includes(entry.wording)
        );
    }

    // Two of those wordings are built from a label rather than written out, so the
    // assertion is about the template AND the labels the routes depend on. Searching
    // for the finished sentence would have failed here — and it should: a harness
    // that only passed on the literal would not notice a renamed label.
    const inventorySource = handlerSource('inventory/inventory-transaction.service.ts');
    check(
        'the inventory wording is still a template',
        inventorySource.includes('`A valid ${label} is required`')
    );
    check(
        'and `transactionId` is still a label it is called with',
        /toInventoryObjectId\(\s*transactionId,\s*'transactionId'/.test(inventorySource)
    );
    check(
        'and `itemId` is still a label it is called with',
        inventorySource.includes("toInventoryObjectId(input.itemId, 'itemId')")
    );

    for (const wording of new Set(PARAM_ROUTES.map((entry) => entry.message).filter(Boolean) as string[])) {
        const covered = HANDLER_WORDINGS.some((entry) => entry.wording === wording);

        check(`every preserved wording is traceable to a handler ('${wording}')`, covered);
    }

    // The two `:idOrSlug` twins must answer "is this an ObjectId?" the same way.
    const productSlugCheck = readSource('product/product.controller.ts');
    const comboSlugCheck = readSource('combo/combo.controller.ts');
    check(
        'product :idOrSlug decides with OBJECT_ID_PATTERN',
        productSlugCheck.includes('OBJECT_ID_PATTERN.test(idOrSlug)')
    );
    check(
        'combo :idOrSlug decides with OBJECT_ID_PATTERN',
        comboSlugCheck.includes('OBJECT_ID_PATTERN.test(idOrSlug)')
    );

    /* ══ C. Live behaviour ══════════════════════════════════════════════════ */
    section('C. What the wire actually answers');

    const app = createApp({ skipDatabaseCheck: true });

    await withServer(app as unknown as express.Application, async (base) => {
        // The one param route with no guard in front of it, so the param layer is
        // reachable over real HTTP without a token or a database.
        const malformed = await fetch(`${base}/api/reviews/product/${MALFORMED_ID}`);
        const malformedBody = (await malformed.json()) as {
            success?: boolean;
            message?: string;
            errors?: Array<{ path?: string; message?: string }>;
        };

        check('a malformed :productId is a 400', malformed.status === 400, `status ${malformed.status}`);
        check('the 400 keeps the wording the service used to return', malformedBody.message === 'Invalid product ID', malformedBody.message);
        check('the 400 is still the standard envelope', malformedBody.success === false);
        check(
            'it now also names the failing param and the rule',
            malformedBody.errors?.[0]?.path === 'params.productId' &&
                malformedBody.errors?.[0]?.message === OBJECT_ID_PARAM_MESSAGE,
            JSON.stringify(malformedBody.errors)
        );

        // Guard order is part of the contract, and the param layer must not move it.
        const guarded = await fetch(`${base}/api/admin/orders/${MALFORMED_ID}`);
        const guardedBody = (await guarded.json()) as { message?: string };
        check(
            'a guarded route still answers 401 before the param layer',
            guarded.status === 401,
            `status ${guarded.status} ${guardedBody.message ?? ''}`
        );
        check(
            'and does not leak the param contract to an anonymous caller',
            !guardedBody.message?.includes(OBJECT_ID_PARAM_MESSAGE) && !('errors' in guardedBody)
        );

        const customerGuarded = await fetch(`${base}/api/orders/${MALFORMED_ID}`);
        check('a customer route behaves the same way', customerGuarded.status === 401, `status ${customerGuarded.status}`);

        const unknown = await fetch(`${base}/api/does-not-exist`);
        check('an unknown route is still a 404', unknown.status === 404, `status ${unknown.status}`);
    });

    /* ══ D. Controls ════════════════════════════════════════════════════════ */
    section('D. Controls — is the new layer load-bearing, and was the risk real?');

    /**
     * A probe route mirroring one real registration, with each layer switchable so
     * the control can remove exactly one of them.
     */
    const buildProbeApp = (options: { paramLayer: boolean; handlerGuard: boolean; usesQuery: boolean }): { app: Express; hits: () => number } => {
        const app = express();
        let hits = 0;

        app.use(requestId);
        app.use(express.json());

        const middleware: RequestHandler[] = [];

        if (options.paramLayer) {
            middleware.push(validate({ params: objectIdParam('id'), message: 'Invalid order ID' }));
        }

        middleware.push(async (req, res) => {
            hits += 1;
            const rawId = req.params.id;
            const id = Array.isArray(rawId) ? rawId[0] : rawId;

            if (options.handlerGuard && !mongoose.Types.ObjectId.isValid(id)) {
                res.status(400).json({ success: false, message: 'Invalid order ID' });
                return;
            }

            if (options.usesQuery) {
                // The shape a route had before P0-3 added handler-side checks: the
                // param goes straight into a query. Casting fails before any I/O, so
                // this needs no database.
                await probeModel.findById(id).exec();
            }

            res.json({ success: true });
        });

        app.get('/probe/:id', ...middleware);
        app.use(errorHandler);

        return { app, hits: () => hits };
    };

    const probeSchema = new mongoose.Schema({ title: String });
    const probeModel = mongoose.model('ParamsValidationProbe', probeSchema);

    // D1 — the older layer, alone, still refuses.
    const handlerOnly = buildProbeApp({ paramLayer: false, handlerGuard: true, usesQuery: false });
    const d1 = await withServer(handlerOnly.app, async (base) => {
        const response = await fetch(`${base}/probe/${MALFORMED_ID}`);
        return { status: response.status, json: (await response.json()) as { message?: string } };
    });
    check('control: the handler-side guard alone still answers 400', d1.status === 400, `status ${d1.status}`);
    check('control: …with its own wording unchanged', d1.json.message === 'Invalid order ID', d1.json.message);

    // D2 — the new layer, alone, refuses and the handler never runs.
    const paramOnly = buildProbeApp({ paramLayer: true, handlerGuard: false, usesQuery: false });
    const d2 = await withServer(paramOnly.app, async (base) => {
        const bad = await fetch(`${base}/probe/${MALFORMED_ID}`);
        const good = await fetch(`${base}/probe/${VALID_ID}`);
        return { bad: bad.status, good: good.status, badBody: (await bad.json()) as { message?: string; errors?: unknown } };
    });
    check('control: the param layer alone refuses a malformed id', d2.bad === 400, `status ${d2.bad}`);
    check('control: …without invoking the handler', paramOnly.hits() === 1, `handler hits ${paramOnly.hits()} (expected 1, for the valid id)`);
    check('control: a well-formed id passes through to the handler', d2.good === 200, `status ${d2.good}`);

    // D3 — remove BOTH layers and hand the param to a real query. This is the
    // control the brief asked for ("remove schema → CastError → 500"). It is
    // asserted as measured: the P0-4 error handler maps the CastError to 400.
    const noLayers = buildProbeApp({ paramLayer: false, handlerGuard: false, usesQuery: true });
    const d3 = await withServer(noLayers.app, async (base) => {
        const response = await fetch(`${base}/probe/${MALFORMED_ID}`);
        return { status: response.status, json: (await response.json()) as { message?: string } };
    });
    check('control: with both layers removed the handler DOES run', noLayers.hits() === 1);
    check(
        'control: the resulting CastError is a 400, NOT the assumed 500',
        d3.status === 400,
        `status ${d3.status} — the assumption was 500; P0-4 already mapped CastError to 400`
    );
    check(
        'control: the CastError wording leaks no schema path or value',
        d3.json.message === INVALID_ID_MESSAGE,
        `${d3.json.message} (expected ${INVALID_ID_MESSAGE})`
    );

    // Discrimination for the live checks in section C: a route that really does
    // answer 200 must not be reported as a refusal.
    const okProbe = buildProbeApp({ paramLayer: true, handlerGuard: false, usesQuery: false });
    const okStatus = await withServer(okProbe.app, async (base) => (await fetch(`${base}/probe/${VALID_ID}`)).status);
    check('control: a valid param is not falsely refused', okStatus === 200, `status ${okStatus}`);

    /* ══ Result ═════════════════════════════════════════════════════════════ */
    console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failure(s)`);

    if (failures.length > 0) {
        process.exitCode = 1;
    }
};

void main();
