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
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
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
import {
    googleLoginSchema,
    loginUserSchema,
    registerUserSchema,
} from '../src/auth/auth.schemas';
import { registerUser } from '../src/auth/auth.controller';
import {
    MAX_ORDER_ITEM_QUANTITY,
    createOrderSchema,
} from '../src/order/order.schemas';
import { createOrder } from '../src/order/order.controller';
import type { AuthenticatedRequest } from '../src/middleware/auth.middleware';

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

/** The exact 400 wordings the auth routes must keep (see auth.routes.ts). */
const AUTH_REGISTER_MESSAGE = 'Username, email, and password are required';
const AUTH_LOGIN_MESSAGE = 'Username or email and password are required';
const GOOGLE_LOGIN_MESSAGE = 'Google credential is required';

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

/** Stand-in for `protect` so real controllers can run without a database. */
const stubAuth: RequestHandler = (req, _res, next) => {
    (req as AuthenticatedRequest).user = { id: '507f1f77bcf86cd799439011', role: 'user' };
    next();
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

    // Real auth schemas (P0-3.2). `/auth/register-policy` runs the real
    // controller so its own password-length 400 is exercised; only failing
    // payloads are sent there, so no database access is reached.
    app.post(
        '/auth/register',
        validate({ body: registerUserSchema, message: AUTH_REGISTER_MESSAGE }),
        echo,
    );
    app.post(
        '/auth/register-policy',
        validate({ body: registerUserSchema, message: AUTH_REGISTER_MESSAGE }),
        registerUser,
    );
    app.post(
        '/auth/login',
        validate({ body: loginUserSchema, message: AUTH_LOGIN_MESSAGE }),
        echo,
    );
    app.post(
        '/auth/google',
        validate({ body: googleLoginSchema, message: GOOGLE_LOGIN_MESSAGE }),
        echo,
    );

    // Order schema (P0-3.3). `/order/create-real` runs the real controller behind a
    // stubbed req.user so its own "Order items are required" 400 is exercised;
    // only payloads that fail before any database access are sent there.
    app.post('/order/create', validate({ body: createOrderSchema }), echo);
    app.post(
        '/order/create-real',
        stubAuth,
        validate({ body: createOrderSchema }),
        createOrder,
    );

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

const checkOrderSchema = async (url: string): Promise<void> => {
    console.log('\n=== 4. order schema (P0-3.3) ===');

    const validOrder = {
        items: [{ itemId: '507f1f77bcf86cd799439011', itemType: 'product', quantity: 2 }],
        shippingAddress: {
            name: 'Test Customer',
            phone: '01700000000',
            division: 'Dhaka',
            district: 'Dhaka',
            area: 'Gulshan',
            address: 'House 1, Road 1',
        },
        paymentMethod: 'cash_on_delivery',
        couponCode: 'SAVE10',
        quoteFingerprint: 'fingerprint-abc123',
    };

    const valid = await postJson(`${url}/order/create`, validOrder);
    check(
        'valid payload passes, and couponCode + quoteFingerprint survive',
        valid.status === 200 && deepEqual(valid.body.body, validOrder),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedItemId = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [{ ...validOrder.items[0], itemId: { $ne: null } }],
    });
    checkValidationEnvelope(
        'order: operator itemId is rejected by Zod',
        injectedItemId,
        VALIDATION_FAILURE_MESSAGE,
        'body.items.0',
    );

    const malformedItemId = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [{ itemId: 'not-an-object-id', itemType: 'product', quantity: 1 }],
    });
    checkValidationEnvelope(
        'order: non-ObjectId itemId is now a clean 400 (was a Mongoose CastError → 500)',
        malformedItemId,
        VALIDATION_FAILURE_MESSAGE,
        'body.items.0.itemId',
    );

    const unknownFields = await postJson(`${url}/order/create`, {
        ...validOrder,
        totalAmount: 1,
        discountAmount: 5,
    });
    check(
        'order: unknown totalAmount/discountAmount are stripped',
        unknownFields.status === 200 &&
        deepEqual(unknownFields.body.body, validOrder),
        `status=${unknownFields.status} body=${JSON.stringify(unknownFields.body.body)}`,
    );

    const derivedFields = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [
            {
                ...validOrder.items[0],
                title: 'Attacker chosen title',
                price: 1,
                thumbnail: 'evil.jpg',
            },
        ],
        shippingAddress: { ...validOrder.shippingAddress, deliveryZone: 'inside_dhaka' },
    });
    const derivedBody = JSON.stringify(derivedFields.body.body);
    check(
        'order: server-derived fields (title/price/thumbnail/deliveryZone) are stripped',
        derivedFields.status === 200 &&
        !derivedBody.includes('Attacker chosen title') &&
        !derivedBody.includes('evil.jpg') &&
        !derivedBody.includes('deliveryZone') &&
        !derivedBody.includes('"price"'),
        `status=${derivedFields.status} body=${derivedBody}`,
    );

    const numericStringQuantity = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [{ itemId: '507f1f77bcf86cd799439011', itemType: 'product', quantity: '3' }],
    });
    const quantityAfterParse = (
        (numericStringQuantity.body.body as Record<string, unknown> | undefined)?.items as
        | Array<{ quantity: unknown }>
        | undefined
    )?.[0]?.quantity;
    check(
        "order: numeric-string quantity '3' is accepted and coerced to the number 3",
        numericStringQuantity.status === 200 && quantityAfterParse === 3,
        `status=${numericStringQuantity.status} quantity=${String(quantityAfterParse)}`,
    );

    const emptiedQuantity = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [{ itemId: '507f1f77bcf86cd799439011', itemType: 'product', quantity: '' }],
    });
    check(
        'order: empty-string quantity is rejected rather than coerced to 0',
        emptiedQuantity.status === 400,
        `status=${emptiedQuantity.status} message=${String(emptiedQuantity.body.message)}`,
    );

    const overCapQuantity = await postJson(`${url}/order/create`, {
        ...validOrder,
        items: [
            {
                itemId: '507f1f77bcf86cd799439011',
                itemType: 'product',
                quantity: MAX_ORDER_ITEM_QUANTITY + 1,
            },
        ],
    });
    check(
        `order: quantity above the ${MAX_ORDER_ITEM_QUANTITY} cap is rejected`,
        overCapQuantity.status === 400,
        `status=${overCapQuantity.status}`,
    );

    const emptyItems = await postJson(`${url}/order/create-real`, {
        ...validOrder,
        items: [],
    });
    check(
        'order: empty items array keeps the controller\'s exact "Order items are required" 400',
        emptyItems.status === 400 && emptyItems.body.message === 'Order items are required',
        `status=${emptyItems.status} message=${String(emptyItems.body.message)}`,
    );
};

const checkStripUnit = (): void => {
    console.log('\n=== 5. stripMongoOperatorsFrom() unit checks ===');

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

const checkAuthSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 3. auth schemas (P0-3.2) ===');

    const register = await postJson(`${url}/auth/register`, validRegister);
    check(
        'register: valid payload passes',
        register.status === 200 && deepEqual(register.body.body, validRegister),
        `status=${register.status} body=${JSON.stringify(register.body.body)}`,
    );

    const injectedPassword = await postJson(`${url}/auth/register`, {
        ...validRegister,
        password: { $ne: null },
    });
    checkValidationEnvelope(
        'register: operator password is rejected by Zod',
        injectedPassword,
        AUTH_REGISTER_MESSAGE,
        'body.password',
    );

    const unknownRole = await postJson(`${url}/auth/register`, {
        ...validRegister,
        role: 'admin',
    });
    check(
        'register: unknown role field is stripped',
        unknownRole.status === 200 &&
        !Object.prototype.hasOwnProperty.call(unknownRole.body.body ?? {}, 'role'),
        `status=${unknownRole.status} body=${JSON.stringify(unknownRole.body.body)}`,
    );

    const shortUsername = await postJson(`${url}/auth/register`, {
        ...validRegister,
        username: 'ab',
    });
    checkValidationEnvelope(
        'register: username under 3 chars is now a 400 (previously a 500 from Mongoose minlength)',
        shortUsername,
        AUTH_REGISTER_MESSAGE,
        'body.username',
    );

    const shortPasswordViaSchema = await postJson(`${url}/auth/register`, {
        ...validRegister,
        password: 'short',
    });
    check(
        'register: schema is shape-only, so a short password still passes Zod (policy is the controller\'s)',
        shortPasswordViaSchema.status === 200,
        `status=${shortPasswordViaSchema.status}`,
    );

    const shortPasswordViaController = await postJson(`${url}/auth/register-policy`, {
        ...validRegister,
        password: 'short',
    });
    check(
        'register: controller still returns its own 400 for a short password',
        shortPasswordViaController.status === 400 &&
        shortPasswordViaController.body.message === 'Password must be at least 8 characters',
        `status=${shortPasswordViaController.status} message=${String(shortPasswordViaController.body.message)}`,
    );

    const usernameInEmailField = await postJson(`${url}/auth/login`, {
        email: 'johndoe',
        password: 'anything',
    });
    check(
        'login: accepts a username sent in the email field (Decision F)',
        usernameInEmailField.status === 200 &&
        deepEqual(usernameInEmailField.body.body, { email: 'johndoe', password: 'anything' }),
        `status=${usernameInEmailField.status} body=${JSON.stringify(usernameInEmailField.body.body)}`,
    );

    const missingIdentifier = await postJson(`${url}/auth/login`, { password: 'anything' });
    checkValidationEnvelope(
        'login: missing identifier returns the exact legacy 400 message',
        missingIdentifier,
        AUTH_LOGIN_MESSAGE,
        'body.username',
    );

    const missingCredential = await postJson(`${url}/auth/google`, {});
    checkValidationEnvelope(
        'google: missing credential returns the exact legacy 400 message',
        missingCredential,
        GOOGLE_LOGIN_MESSAGE,
        'body.credential',
    );
};

/**
 * Static check: `validate()` must be the FIRST handler on each auth write route.
 *
 * The auth controllers cast `req.body` to the schema's `z.infer` type, so they
 * trust the route to have parsed it. If the middleware is dropped, that cast
 * becomes a lie: a non-string password (`{"password": {"$ne": null}}`) reaches
 * the controller and throws instead of returning 400. Asserting the POSITION,
 * not merely presence, also catches a `validate()` accidentally moved behind the
 * handler — where it would never run.
 */
const AUTH_VALIDATED_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
    { method: 'post', path: '/register' },
    { method: 'post', path: '/login' },
    { method: 'post', path: '/google' },
];

const checkAuthRoutesValidateFirst = (): void => {
    console.log('\n=== 6. auth routes keep validate() as the first handler ===');

    const source = readFileSync(join(__dirname, '..', 'src', 'auth', 'auth.routes.ts'), 'utf8');

    for (const route of AUTH_VALIDATED_ROUTES) {
        const label = `POST /api/auth${route.path}`;
        const pattern = new RegExp(
            `router\\.${route.method}\\(\\s*'${route.path.replace(/\//g, '\\/')}'\\s*,\\s*([A-Za-z_$][\\w$]*)\\(`,
        );
        const firstHandler = pattern.exec(source)?.[1];

        if (firstHandler === 'validate') {
            console.log(`  OK   ${label}: validate() is the first handler`);
            continue;
        }

        const message = `auth route ${label} lost its validate() middleware — the controller trusts the parsed body and will 500 on malformed input`;
        console.log(`  FAIL ${message}`);

        if (firstHandler !== undefined) {
            console.log(`       (first handler found: ${firstHandler})`);
        }

        failures.push(message);
    }
};

/**
 * Static check for the order route.
 *
 * Unlike the auth routes, `protect` legitimately runs first here, so the
 * invariant is not "validate() is first" but "validate() runs before the
 * controller" — the controller casts `req.body` to `CreateOrderInput`, so if the
 * middleware is dropped or moved behind it, the cast becomes a lie.
 */
const ORDER_VALIDATED_ROUTE = {
    file: 'order/order.routes.ts',
    method: 'post',
    path: '/',
    controller: 'createOrder',
};

/** Parses `router.<method>('path', ...handlers)` registrations without regex. */
const parseRouterRegistrations = (
    source: string,
): Array<{ method: string; path: string; args: string }> => {
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const routes: Array<{ method: string; path: string; args: string }> = [];

    for (const method of methods) {
        const needle = `router.${method}(`;
        let index = source.indexOf(needle);

        while (index !== -1) {
            const openParen = index + needle.length;
            let depth = 1;
            let cursor = openParen;

            for (; cursor < source.length; cursor += 1) {
                const char = source[cursor];

                if (char === '(') {
                    depth += 1;
                } else if (char === ')') {
                    depth -= 1;
                    if (depth === 0) {
                        break;
                    }
                }
            }

            const args = source.slice(openParen, cursor);
            const quoteStart = args.indexOf("'");
            const quoteEnd = quoteStart === -1 ? -1 : args.indexOf("'", quoteStart + 1);

            if (quoteStart !== -1 && quoteEnd !== -1) {
                routes.push({ method, path: args.slice(quoteStart + 1, quoteEnd), args });
            }

            index = source.indexOf(needle, cursor + 1);
        }
    }

    return routes;
};

const checkOrderRouteValidated = (): void => {
    console.log('\n=== 7. order route keeps validate() before the controller ===');

    const source = readFileSync(join(__dirname, '..', 'src', ORDER_VALIDATED_ROUTE.file), 'utf8');
    const registration = parseRouterRegistrations(source).find(
        (route) =>
            route.method === ORDER_VALIDATED_ROUTE.method &&
            route.path === ORDER_VALIDATED_ROUTE.path,
    );

    const label = `POST /api/orders`;
    const failureMessage = `order route ${label} lost its validate() middleware — the controller trusts the parsed body and will 500 on malformed input`;

    if (!registration) {
        console.log(`  FAIL ${failureMessage}`);
        console.log(`       (no POST '/' registration found in ${ORDER_VALIDATED_ROUTE.file})`);
        failures.push(failureMessage);
        return;
    }

    const quoteEnd = registration.args.indexOf("'", registration.args.indexOf("'") + 1);
    const afterPath = registration.args.slice(quoteEnd + 1);
    const validateIndex = afterPath.indexOf('validate(');
    const controllerIndex = afterPath.indexOf(ORDER_VALIDATED_ROUTE.controller);

    if (validateIndex !== -1 && (controllerIndex === -1 || validateIndex < controllerIndex)) {
        console.log(`  OK   ${label}: validate() runs before ${ORDER_VALIDATED_ROUTE.controller}`);
        return;
    }

    console.log(`  FAIL ${failureMessage}`);
    console.log(
        `       (validate() at ${validateIndex}, ${ORDER_VALIDATED_ROUTE.controller} at ${controllerIndex})`,
    );
    failures.push(failureMessage);
};

const main = async (): Promise<void> => {
    const server = await startServer(buildApp());
    const url = baseUrl(server);

    try {
        await checkZodLayer(url);
        await checkGlobalStripLayer(url);
        await checkAuthSchemas(url);
        await checkOrderSchema(url);
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    checkStripUnit();
    checkAuthRoutesValidateFirst();
    checkOrderRouteValidated();

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
