/**
 * P0-3 — validation layer verification.
 *
 * Run with: npm run verify:validation
 *
 * Proves the two controls in `src/middleware/` behave as specified:
 *  - `validate()`      parses with `z.object()` (strip), REPLACES the request
 *                      part with the parsed value, and returns the mandated
 *                      400 envelope. `message` is overridable per route.
 *  - `stripMongoOperators` removes `$`-prefixed and dotted keys recursively.
 *
 * The schemas below are representative of the client payloads (auth register and
 * order create) because the per-module schemas arrive in later sub-commits; each
 * of those sub-commits extends this file with its own real schema cases.
 *
 * Layer isolation trick: routes registered BEFORE the `stripMongoOperators`
 * mount never reach it (Express runs middleware in registration order and a
 * responding handler ends the chain), so the `/zod/*` routes exercise Zod alone
 * and the `/full/*` routes exercise both layers.
 *
 * Exits non-zero if any check fails.
 */
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';
import {
    VALIDATION_FAILURE_MESSAGE,
    validate,
    type ValidationIssue,
} from '../src/middleware/validate.middleware';
import {
    MAX_STRIP_DEPTH,
    stripMongoOperators,
    stripMongoOperatorsFrom,
} from '../src/middleware/strip-mongo-operators.middleware';

type Json = unknown;

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

const deepEqual = (left: Json, right: Json): boolean => {
    if (left === right) {
        return true;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
    }

    if (
        typeof left === 'object' &&
        left !== null &&
        typeof right === 'object' &&
        right !== null &&
        !Array.isArray(left) &&
        !Array.isArray(right)
    ) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);

        return (
            leftKeys.length === rightKeys.length &&
            leftKeys.every(
                (key) =>
                    Object.prototype.hasOwnProperty.call(right, key) &&
                    deepEqual((left as Record<string, Json>)[key], (right as Record<string, Json>)[key]),
            )
        );
    }

    return false;
};

/* ── Representative schemas (real per-module schemas land in later sub-commits) ── */

const registerSchema = z.object({
    username: z.string().min(3),
    email: z.string().min(1),
    password: z.string().min(8),
});

const orderLikeSchema = z.object({
    items: z
        .array(z.object({ itemId: z.string().min(1), quantity: z.number().int().positive() }))
        .min(1),
    shippingAddress: z.object({
        division: z.string().min(1),
        district: z.string().min(1),
        area: z.string().min(1),
    }),
    paymentMethod: z.enum(['cash_on_delivery']),
});

const querySchema = z.object({
    sort: z.enum(['newest', 'oldest']).optional(),
});

const paramsSchema = z.object({
    id: z.string().regex(/^[0-9a-f]{24}$/, 'Invalid id'),
});

const AUTH_MESSAGE_OVERRIDE = 'Username, email, and password are required';

/**
 * Builds an object nested `levels` levels deep around `bottom`. Built
 * iteratively on purpose: `JSON.stringify` of a 50,000-level object would itself
 * blow the stack, which is precisely the failure being tested.
 */
const buildNested = (
    levels: number,
    bottom: Record<string, unknown> = { leaf: true },
): Record<string, unknown> => {
    let node = bottom;

    for (let level = 0; level < levels; level += 1) {
        node = { level, child: node };
    }

    return node;
};

/* ── Mini app ──────────────────────────────────────────────────────────────── */

const echo = (req: express.Request, res: express.Response): void => {
    res.json({ ok: true, body: req.body, query: req.query, params: req.params });
};

const buildApp = (): express.Application => {
    const app = express();
    app.use(express.json());

    // Zod-only routes: registered before the strip middleware is mounted.
    const registerChain: RequestHandler[] = [validate({ body: registerSchema })];
    app.post('/zod/register', ...registerChain, echo);
    app.post(
        '/zod/register-message',
        validate({ body: registerSchema, message: AUTH_MESSAGE_OVERRIDE }),
        echo,
    );
    app.post('/zod/order', validate({ body: orderLikeSchema }), echo);
    app.get('/zod/item/:id', validate({ params: paramsSchema }), echo);

    // Everything below passes through the global operator strip first.
    app.use(stripMongoOperators);

    app.post('/full/register', validate({ body: registerSchema }), echo);
    app.post('/full/order', validate({ body: orderLikeSchema }), echo);
    app.get('/full/list', validate({ query: querySchema }), echo);

    // No schema: isolates the strip middleware's behaviour under deep nesting.
    app.post('/full/deep', echo);

    return app;
};

/* ── HTTP helpers ──────────────────────────────────────────────────────────── */

const startServer = async (app: express.Application): Promise<Server> =>
    new Promise((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });

const baseUrl = (server: Server): string => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    return `http://127.0.0.1:${port}`;
};

type ApiResponse = { status: number; body: Record<string, unknown> };

const postJson = async (url: string, payload: Json): Promise<ApiResponse> => {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
    });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const getJson = async (url: string): Promise<ApiResponse> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/* ── Checks ────────────────────────────────────────────────────────────────── */

const validRegister = { username: 'johndoe', email: 'john@example.com', password: 'securePass123' };

const checkValidationEnvelope = (
    label: string,
    response: ApiResponse,
    expectedMessage: string,
    expectedPathPrefix: string,
): void => {
    const errors = response.body.errors as ValidationIssue[] | undefined;
    const firstPath = errors?.[0]?.path ?? '';

    check(
        label,
        response.status === 400 &&
        response.body.success === false &&
        response.body.message === expectedMessage &&
        Array.isArray(errors) &&
        errors.length > 0 &&
        typeof errors[0]?.message === 'string' &&
        firstPath.startsWith(expectedPathPrefix),
        `status=${response.status} message=${String(response.body.message)} path=${firstPath}`,
    );
};

const checkZodLayer = async (url: string): Promise<void> => {
    console.log('\n=== 1. validate(): strip + replace (Zod only) ===');

    const valid = await postJson(`${url}/zod/register`, validRegister);
    check(
        'valid payload passes and body is replaced with the parsed result',
        valid.status === 200 && deepEqual(valid.body.body, validRegister),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const withUnknown = await postJson(`${url}/zod/register`, {
        ...validRegister,
        role: 'admin',
        isAdmin: true,
    });
    check(
        'unknown fields (role/isAdmin) are stripped — mass assignment blocked',
        withUnknown.status === 200 &&
        deepEqual(withUnknown.body.body, validRegister) &&
        !Object.prototype.hasOwnProperty.call(withUnknown.body.body ?? {}, 'role'),
        `status=${withUnknown.status} body=${JSON.stringify(withUnknown.body.body)}`,
    );

    const injected = await postJson(`${url}/zod/register`, {
        username: { $ne: null },
        email: 'john@example.com',
        password: 'securePass123',
    });
    checkValidationEnvelope(
        'operator payload ({ $ne: null }) is rejected by Zod alone',
        injected,
        VALIDATION_FAILURE_MESSAGE,
        'body.',
    );

    const tooShort = await postJson(`${url}/zod/register`, {
        ...validRegister,
        password: 'short',
    });
    checkValidationEnvelope(
        'schema rule failure returns the mandated envelope',
        tooShort,
        VALIDATION_FAILURE_MESSAGE,
        'body.',
    );

    const overridden = await postJson(`${url}/zod/register-message`, { username: 'ab' });
    checkValidationEnvelope(
        'per-route message override is honoured',
        overridden,
        AUTH_MESSAGE_OVERRIDE,
        'body.',
    );

    const badParams = await getJson(`${url}/zod/item/not-an-object-id`);
    checkValidationEnvelope(
        'params failure is reported with a params.* path',
        badParams,
        VALIDATION_FAILURE_MESSAGE,
        'params.',
    );

    const goodParams = await getJson(`${url}/zod/item/507f1f77bcf86cd799439011`);
    check(
        'valid params pass and are replaced',
        goodParams.status === 200 && deepEqual(goodParams.body.params, { id: '507f1f77bcf86cd799439011' }),
        `status=${goodParams.status} params=${JSON.stringify(goodParams.body.params)}`,
    );
};

const checkGlobalStripLayer = async (url: string): Promise<void> => {
    console.log('\n=== 2. stripMongoOperators mounted globally ===');

    const nestedOrder = {
        items: [{ itemId: '507f1f77bcf86cd799439011', quantity: 2 }],
        shippingAddress: { division: 'Dhaka', district: 'Dhaka', area: 'Gulshan' },
        paymentMethod: 'cash_on_delivery',
    };

    const legit = await postJson(`${url}/full/order`, nestedOrder);
    check(
        'legitimate nested payload survives both layers byte-identical',
        legit.status === 200 && deepEqual(legit.body.body, nestedOrder),
        `status=${legit.status} body=${JSON.stringify(legit.body.body)}`,
    );

    const nestedInjection = await postJson(`${url}/full/order`, {
        ...nestedOrder,
        items: [{ itemId: { $ne: null }, quantity: 1 }],
    });
    checkValidationEnvelope(
        'operator nested inside an array element is stripped, then rejected',
        nestedInjection,
        VALIDATION_FAILURE_MESSAGE,
        'body.items.',
    );

    const topLevelOperator = await postJson(`${url}/full/register`, {
        $where: 'this.password',
        ...validRegister,
    });
    check(
        'top-level $where is removed before validation',
        topLevelOperator.status === 200 &&
        deepEqual(topLevelOperator.body.body, validRegister),
        `status=${topLevelOperator.status} body=${JSON.stringify(topLevelOperator.body.body)}`,
    );

    const queryStripped = await getJson(`${url}/full/list?sort=newest&$where=1&a.b=1&limit=5`);
    check(
        'query: legitimate key kept, $where and dotted keys removed, unknown keys stripped',
        queryStripped.status === 200 && deepEqual(queryStripped.body.query, { sort: 'newest' }),
        `status=${queryStripped.status} query=${JSON.stringify(queryStripped.body.query)}`,
    );

    const deepBody = buildNested(25, { $ne: 'deep-operator' });
    const deepResponse = await postJson(`${url}/full/deep`, deepBody);
    check(
        'a 25-level nested body does not 500 and does not exhaust the stack',
        deepResponse.status === 200 && !JSON.stringify(deepResponse.body).includes('$ne'),
        `status=${deepResponse.status}`,
    );
};

const checkStripUnit = (): void => {
    console.log('\n=== 3. stripMongoOperatorsFrom() unit checks ===');

    check(
        'strips operators recursively, keeps legitimate values',
        deepEqual(
            stripMongoOperatorsFrom({
                $ne: null,
                items: [{ $gt: 1, itemId: 'abc' }],
                'a.b': 1,
                keep: 'me',
            }),
            { items: [{ itemId: 'abc' }], keep: 'me' },
        ),
        JSON.stringify(stripMongoOperatorsFrom({ $ne: null, items: [{ $gt: 1, itemId: 'abc' }], 'a.b': 1, keep: 'me' })),
    );

    const input = { nested: { deep: { $where: 'x', ok: true } } };
    const output = stripMongoOperatorsFrom(input) as Record<string, unknown>;
    check(
        'does not mutate the input object',
        deepEqual(input, { nested: { deep: { $where: 'x', ok: true } } }) && deepEqual(output, { nested: { deep: { ok: true } } }),
        JSON.stringify({ input, output }),
    );

    check(
        'passes primitives and null through untouched',
        stripMongoOperatorsFrom('text') === 'text' &&
        stripMongoOperatorsFrom(7) === 7 &&
        stripMongoOperatorsFrom(null) === null &&
        stripMongoOperatorsFrom(undefined) === undefined,
    );

    const atCap = buildNested(MAX_STRIP_DEPTH);
    check(
        `nesting exactly at the cap (${MAX_STRIP_DEPTH} levels) is preserved intact`,
        deepEqual(stripMongoOperatorsFrom(atCap), atCap),
    );

    const overCap = buildNested(MAX_STRIP_DEPTH + 5, { $ne: 'deep-operator' });
    const strippedOverCap = stripMongoOperatorsFrom(overCap);
    check(
        'beyond the cap the branch is dropped, not passed through un-sanitised',
        !JSON.stringify(strippedOverCap).includes('$ne') &&
        JSON.stringify(strippedOverCap).length < JSON.stringify(overCap).length,
        `stripped=${JSON.stringify(strippedOverCap)}`,
    );

    let extremeThrew = false;

    try {
        stripMongoOperatorsFrom(buildNested(50_000));
    } catch {
        extremeThrew = true;
    }

    check('50,000-level nesting does not overflow the stack', !extremeThrew);
};

const main = async (): Promise<void> => {
    const server = await startServer(buildApp());
    const url = baseUrl(server);

    try {
        await checkZodLayer(url);
        await checkGlobalStripLayer(url);
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    checkStripUnit();

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

    console.log('All validation layer checks passed.');
};

void main();
