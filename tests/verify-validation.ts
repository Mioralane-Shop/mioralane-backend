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
import {
    MAX_REVIEW_LENGTH,
    createReviewSchema,
} from '../src/review/review.schemas';
import { createAddressSchema, updateAddressSchema } from '../src/address/address.schemas';
import { createMyAddress } from '../src/address/address.controller';
import { addToWishlistSchema } from '../src/wishlist/wishlist.schemas';
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

    // Review schema (P0-3.4).
    app.post('/review/create', validate({ body: createReviewSchema }), echo);

    // Address schemas (P0-3.5). `/address/create-real` runs the real controller
    // behind a stubbed req.user so its own "Shipping name, phone, ... are
    // required" 400 is exercised; `validateAndNormalizeShippingAddress` throws
    // before the first database call, so only DB-free payloads are sent there.
    app.post('/address/create', validate({ body: createAddressSchema }), echo);
    app.post('/address/update', validate({ body: updateAddressSchema }), echo);
    app.post(
        '/address/create-real',
        stubAuth,
        validate({ body: createAddressSchema }),
        createMyAddress,
    );

    // Wishlist schema (P0-3.6). One echo route proves the schema; the static check
    // below proves both real POST routes carry it.
    app.post('/wishlist/add', validate({ body: addToWishlistSchema }), echo);

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

/**
 * The exact wire payload `review-form.tsx:135-136` sends: rating is a real
 * number and the comment is already trimmed client-side.
 */
const validReview = {
    productId: '507f1f77bcf86cd799439011',
    rating: 5,
    comment: 'Excellent quality, arrived quickly.',
};

const checkReviewSchema = async (url: string): Promise<void> => {
    console.log('\n=== 4b. review schema (P0-3.4) ===');

    const valid = await postJson(`${url}/review/create`, validReview);
    check(
        'review: valid payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validReview),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedProductId = await postJson(`${url}/review/create`, {
        ...validReview,
        productId: { $ne: null },
    });
    checkValidationEnvelope(
        'review: operator productId is rejected by Zod (was a CastError → 500)',
        injectedProductId,
        VALIDATION_FAILURE_MESSAGE,
        'body.productId',
    );

    const malformedProductId = await postJson(`${url}/review/create`, {
        ...validReview,
        productId: 'not-an-object-id',
    });
    checkValidationEnvelope(
        'review: non-ObjectId productId is a clean 400',
        malformedProductId,
        VALIDATION_FAILURE_MESSAGE,
        'body.productId',
    );

    const derivedFields = await postJson(`${url}/review/create`, {
        ...validReview,
        status: 'approved',
        verifiedPurchase: false,
        userId: '507f1f77bcf86cd799439012',
        order: '507f1f77bcf86cd799439013',
        moderatedAt: '2020-01-01T00:00:00.000Z',
    });
    check(
        'review: server-derived status/verifiedPurchase/userId/order/moderatedAt are stripped',
        derivedFields.status === 200 && deepEqual(derivedFields.body.body, validReview),
        `status=${derivedFields.status} body=${JSON.stringify(derivedFields.body.body)}`,
    );

    const withImages = await postJson(`${url}/review/create`, {
        ...validReview,
        images: [{ url: 'https://evil.example/x.png', fileId: 'abc', assetType: 'image' }],
    });
    const imagesBody = JSON.stringify(withImages.body.body);
    check(
        'review: images is stripped — the disabled upload feature cannot be re-enabled from the client',
        withImages.status === 200 && !imagesBody.includes('images') && !imagesBody.includes('evil.example'),
        `status=${withImages.status} body=${imagesBody}`,
    );

    const paddedComment = await postJson(`${url}/review/create`, {
        ...validReview,
        comment: '   padded on both sides   ',
    });
    const paddedValue = (paddedComment.body.body as Record<string, unknown> | undefined)?.comment;
    check(
        "review: comment is trimmed by the schema (replaces the service's removed body.comment.trim())",
        paddedComment.status === 200 && paddedValue === 'padded on both sides',
        `status=${paddedComment.status} comment=${JSON.stringify(paddedValue)}`,
    );

    for (const rating of [0, 6, 2.5, '5', null]) {
        const response = await postJson(`${url}/review/create`, { ...validReview, rating });
        check(
            `review: rating ${JSON.stringify(rating)} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const emptyComment = await postJson(`${url}/review/create`, { ...validReview, comment: '' });
    checkValidationEnvelope(
        'review: empty comment is rejected',
        emptyComment,
        VALIDATION_FAILURE_MESSAGE,
        'body.comment',
    );

    const whitespaceComment = await postJson(`${url}/review/create`, {
        ...validReview,
        comment: '        ',
    });
    check(
        'review: whitespace-only comment is rejected after trimming',
        whitespaceComment.status === 400,
        `status=${whitespaceComment.status} message=${String(whitespaceComment.body.message)}`,
    );

    const overCapComment = await postJson(`${url}/review/create`, {
        ...validReview,
        comment: 'a'.repeat(MAX_REVIEW_LENGTH + 1),
    });
    check(
        `review: comment above the ${MAX_REVIEW_LENGTH}-character cap is rejected`,
        overCapComment.status === 400,
        `status=${overCapComment.status} message=${String(overCapComment.body.message)}`,
    );
};

/**
 * The exact wire payload `address.service.ts:15-21` sends for create, i.e.
 * `SavedAddressPayload`. `deliveryZone` is absent on purpose — it is derived
 * server-side.
 */
const validAddress = {
    name: 'Test Customer',
    phone: '01700000000',
    division: 'Dhaka',
    district: 'Dhaka',
    area: 'Gulshan',
    fullAddress: 'House 1, Road 1, Gulshan',
    isDefault: true,
};

const checkAddressSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4c. address schemas (P0-3.5) ===');

    const valid = await postJson(`${url}/address/create`, validAddress);
    check(
        'address: valid create payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validAddress),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedField = await postJson(`${url}/address/create`, {
        ...validAddress,
        district: { $ne: null },
    });
    checkValidationEnvelope(
        'address: operator district is rejected by Zod (was stored as a Mongo operator)',
        injectedField,
        VALIDATION_FAILURE_MESSAGE,
        'body.district',
    );

    const injectedLandmark = await postJson(`${url}/address/update`, {
        landmark: { $ne: null },
    });
    checkValidationEnvelope(
        'address: operator landmark is rejected on the update schema too',
        injectedLandmark,
        VALIDATION_FAILURE_MESSAGE,
        'body.landmark',
    );

    const derivedFields = await postJson(`${url}/address/create`, {
        ...validAddress,
        userId: '507f1f77bcf86cd799439012',
        deliveryZone: 'free',
        _id: '507f1f77bcf86cd799439013',
    });
    const derivedBody = JSON.stringify(derivedFields.body.body);
    check(
        'address: userId / deliveryZone / _id are stripped — ownership and zone stay server-derived',
        derivedFields.status === 200 &&
        deepEqual(derivedFields.body.body, validAddress) &&
        !derivedBody.includes('507f1f77bcf86cd799439012') &&
        !derivedBody.includes('free'),
        `status=${derivedFields.status} body=${derivedBody}`,
    );

    const aliasPayload = {
        name: 'Test Customer',
        phone: '01700000000',
        division: 'Dhaka',
        district: 'Dhaka',
        thana: 'Gulshan',
        detailedAddress: 'House 1, Road 1',
    };
    const aliases = await postJson(`${url}/address/create`, aliasPayload);
    check(
        'address: thana / detailedAddress aliases survive — the schema must not strip them',
        aliases.status === 200 && deepEqual(aliases.body.body, aliasPayload),
        `status=${aliases.status} body=${JSON.stringify(aliases.body.body)}`,
    );

    const partialUpdate = await postJson(`${url}/address/update`, { landmark: 'Near the park' });
    check(
        'address: partial update payload validates (the frontend sends Partial<SavedAddressPayload>)',
        partialUpdate.status === 200 && deepEqual(partialUpdate.body.body, { landmark: 'Near the park' }),
        `status=${partialUpdate.status} body=${JSON.stringify(partialUpdate.body.body)}`,
    );

    const stringTrue = await postJson(`${url}/address/create`, {
        ...validAddress,
        isDefault: 'true',
    });
    check(
        "address: isDefault 'true' is still accepted (readBoolean() compat), and 'true' is preserved",
        stringTrue.status === 200 &&
        (stringTrue.body.body as Record<string, unknown> | undefined)?.isDefault === 'true',
        `status=${stringTrue.status} isDefault=${JSON.stringify((stringTrue.body.body as Record<string, unknown> | undefined)?.isDefault)}`,
    );

    const bogusBoolean = await postJson(`${url}/address/create`, {
        ...validAddress,
        isDefault: 'yes',
    });
    check(
        "address: isDefault 'yes' is rejected rather than silently read as truthy",
        bogusBoolean.status === 400,
        `status=${bogusBoolean.status} message=${String(bogusBoolean.body.message)}`,
    );

    const missingRequired = await postJson(`${url}/address/create-real`, { landmark: 'Only a landmark' });
    check(
        'address: create still returns the shipping validator\'s exact 400 for a payload missing the core fields',
        missingRequired.status === 400 &&
        missingRequired.body.message ===
        'Shipping name, phone, division, district, area/thana, and detailed address are required' &&
        missingRequired.body.code === 'invalid_shipping_address',
        `status=${missingRequired.status} message=${String(missingRequired.body.message)} code=${String(missingRequired.body.code)}`,
    );
};

/** The exact wire payload `wishlist.service.ts:20` sends. */
const validWishlistAdd = {
    itemId: '507f1f77bcf86cd799439011',
    itemType: 'product',
};

const checkWishlistSchema = async (url: string): Promise<void> => {
    console.log('\n=== 4d. wishlist schema (P0-3.6) ===');

    const valid = await postJson(`${url}/wishlist/add`, validWishlistAdd);
    check(
        'wishlist: valid add payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validWishlistAdd),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedItemId = await postJson(`${url}/wishlist/add`, {
        ...validWishlistAdd,
        itemId: { $ne: null },
    });
    checkValidationEnvelope(
        'wishlist: operator itemId is rejected by Zod (was a CastError → 500)',
        injectedItemId,
        VALIDATION_FAILURE_MESSAGE,
        'body.itemId',
    );

    const derivedFields = await postJson(`${url}/wishlist/add`, {
        ...validWishlistAdd,
        user: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439012',
        priceAtAdd: 1,
        _id: '507f1f77bcf86cd799439013',
    });
    const derivedBody = JSON.stringify(derivedFields.body.body);
    check(
        'wishlist: user/userId/priceAtAdd/_id are stripped — price-drop baseline stays server-derived',
        derivedFields.status === 200 &&
        deepEqual(derivedFields.body.body, validWishlistAdd) &&
        !derivedBody.includes('priceAtAdd'),
        `status=${derivedFields.status} body=${derivedBody}`,
    );

    const legacyAlias = { productId: '507f1f77bcf86cd799439011', itemType: 'product' };
    const alias = await postJson(`${url}/wishlist/add`, legacyAlias);
    check(
        'wishlist: legacy productId alias survives (readWishlistTarget reads it)',
        alias.status === 200 && deepEqual(alias.body.body, legacyAlias),
        `status=${alias.status} body=${JSON.stringify(alias.body.body)}`,
    );

    const noTarget = await postJson(`${url}/wishlist/add`, { itemType: 'product' });
    checkValidationEnvelope(
        'wishlist: neither itemId nor productId is rejected',
        noTarget,
        VALIDATION_FAILURE_MESSAGE,
        'body.itemId',
    );

    const combo = await postJson(`${url}/wishlist/add`, { ...validWishlistAdd, itemType: 'combo' });
    check(
        "wishlist: itemType 'combo' is accepted",
        combo.status === 200 && (combo.body.body as Record<string, unknown> | undefined)?.itemType === 'combo',
        `status=${combo.status} itemType=${String((combo.body.body as Record<string, unknown> | undefined)?.itemType)}`,
    );

    const bogusType = await postJson(`${url}/wishlist/add`, {
        ...validWishlistAdd,
        itemType: 'bogus',
    });
    check(
        "wishlist: itemType 'bogus' is rejected at the edge instead of reaching the service",
        bogusType.status === 400 && bogusType.body.success === false,
        `status=${bogusType.status} message=${String(bogusType.body.message)}`,
    );

    const emptyType = await postJson(`${url}/wishlist/add`, { ...validWishlistAdd, itemType: '' });
    check(
        "wishlist: itemType '' is now rejected — P0-3.6a dropped the empty-string tolerance",
        emptyType.status === 400,
        `status=${emptyType.status} message=${String(emptyType.body.message)}`,
    );

    const nullType = await postJson(`${url}/wishlist/add`, { ...validWishlistAdd, itemType: null });
    check(
        'wishlist: itemType null is rejected (strict enum, no legacy tolerance)',
        nullType.status === 400,
        `status=${nullType.status} message=${String(nullType.body.message)}`,
    );

    const withSort = { ...validWishlistAdd, sort: 'price-asc' };
    const sorted = await postJson(`${url}/wishlist/add`, withSort);
    check(
        'wishlist: body sort survives — Zod must not strip a field the handlers still read',
        sorted.status === 200 && deepEqual(sorted.body.body, withSort),
        `status=${sorted.status} body=${JSON.stringify(sorted.body.body)}`,
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

/**
 * Review reads `req.body as CreateReviewInput` for the same reason, and the
 * service's own shape checks were deleted in P0-3.4 — so if `validate()` is
 * removed from this route, malformed input reaches Mongoose unchecked.
 */
const REVIEW_VALIDATED_ROUTE = {
    file: 'review/review.routes.ts',
    method: 'post',
    path: '/',
    controller: 'createReview',
};

/**
 * Address create and update. The controller already cast `req.body` before
 * P0-3.5, so these assertions keep that cast honest. Note the API is PATCH-only:
 * there is no PUT route, so there is nothing else to assert.
 */
const ADDRESS_CREATE_VALIDATED_ROUTE = {
    file: 'address/address.routes.ts',
    method: 'post',
    path: '/',
    controller: 'createMyAddress',
};

const ADDRESS_UPDATE_VALIDATED_ROUTE = {
    file: 'address/address.routes.ts',
    method: 'patch',
    path: '/:id',
    controller: 'updateMyAddress',
};

/**
 * Both wishlist POSTs read the same target payload, so both must be validated.
 * `DELETE /:itemId` carries no body and is deliberately excluded (see the route
 * file comment / P0-3.5 §3.5).
 */
const WISHLIST_ADD_VALIDATED_ROUTE = {
    file: 'wishlist/wishlist.routes.ts',
    method: 'post',
    path: '/',
    controller: 'addToWishlist',
};

const WISHLIST_TOGGLE_VALIDATED_ROUTE = {
    file: 'wishlist/wishlist.routes.ts',
    method: 'post',
    path: '/toggle',
    controller: 'toggleWishlist',
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

type ValidatedRouteSpec = {
    file: string;
    method: string;
    path: string;
    controller: string;
    /** Used in the failure message, e.g. `order route POST /api/orders lost ...`. */
    subject: string;
    /** Human-readable label for log output. */
    label: string;
};

/**
 * Asserts `validate()` is registered ahead of the controller by parsing the real
 * route file. Order and review are both included because both controllers cast
 * `req.body`, so a missing middleware turns the cast into a lie.
 */
const assertValidateBeforeController = (spec: ValidatedRouteSpec): void => {
    const source = readFileSync(join(__dirname, '..', 'src', spec.file), 'utf8');
    const registration = parseRouterRegistrations(source).find(
        (route) => route.method === spec.method && route.path === spec.path,
    );

    const failureMessage = `${spec.subject} route ${spec.label} lost its validate() middleware — the controller trusts the parsed body and will 500 on malformed input`;

    if (!registration) {
        console.log(`  FAIL ${failureMessage}`);
        console.log(
            `       (no ${spec.method.toUpperCase()} '${spec.path}' registration found in ${spec.file})`,
        );
        failures.push(failureMessage);
        return;
    }

    const quoteEnd = registration.args.indexOf("'", registration.args.indexOf("'") + 1);
    const afterPath = registration.args.slice(quoteEnd + 1);
    const validateIndex = afterPath.indexOf('validate(');
    const controllerIndex = afterPath.indexOf(spec.controller);

    if (validateIndex !== -1 && (controllerIndex === -1 || validateIndex < controllerIndex)) {
        console.log(`  OK   ${spec.label}: validate() runs before ${spec.controller}`);
        return;
    }

    console.log(`  FAIL ${failureMessage}`);
    console.log(`       (validate() at ${validateIndex}, ${spec.controller} at ${controllerIndex})`);
    failures.push(failureMessage);
};

const checkValidatedRoutes = (): void => {
    console.log('\n=== 7. validate() runs before the controller that casts req.body ===');

    assertValidateBeforeController({
        ...ORDER_VALIDATED_ROUTE,
        subject: 'order',
        label: 'POST /api/orders',
    });
    assertValidateBeforeController({
        ...REVIEW_VALIDATED_ROUTE,
        subject: 'review',
        label: 'POST /api/reviews',
    });
    assertValidateBeforeController({
        ...ADDRESS_CREATE_VALIDATED_ROUTE,
        subject: 'address create',
        label: 'POST /api/addresses',
    });
    assertValidateBeforeController({
        ...ADDRESS_UPDATE_VALIDATED_ROUTE,
        subject: 'address update',
        label: 'PATCH /api/addresses/:id',
    });
    assertValidateBeforeController({
        ...WISHLIST_ADD_VALIDATED_ROUTE,
        subject: 'wishlist add',
        label: 'POST /api/wishlist',
    });
    assertValidateBeforeController({
        ...WISHLIST_TOGGLE_VALIDATED_ROUTE,
        subject: 'wishlist toggle',
        label: 'POST /api/wishlist/toggle',
    });
};

const main = async (): Promise<void> => {
    const server = await startServer(buildApp());
    const url = baseUrl(server);

    try {
        await checkZodLayer(url);
        await checkGlobalStripLayer(url);
        await checkAuthSchemas(url);
        await checkOrderSchema(url);
        await checkReviewSchema(url);
        await checkAddressSchemas(url);
        await checkWishlistSchema(url);
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    checkStripUnit();
    checkAuthRoutesValidateFirst();
    checkValidatedRoutes();

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
