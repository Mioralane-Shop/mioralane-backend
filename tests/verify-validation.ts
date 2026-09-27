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
import {
    MAX_INVENTORY_NOTE_LENGTH,
    MAX_INVENTORY_REASON_LENGTH,
    MAX_STOCK_LEVEL,
    inventoryOperationSchema,
} from '../src/inventory/inventory.schemas';
import {
    adjustInventoryItem,
    stockInInventoryItem,
} from '../src/inventory/inventory.controller';
import { mediaUploadSchema } from '../src/media/media.schemas';
import type { AuthenticatedRequest } from '../src/middleware/auth.middleware';
import multer from 'multer';

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

/** The exact 400 wording `media.routes.ts` pins on the upload route. */
const MEDIA_ASSET_TYPE_MESSAGE = 'assetType must be product, combo, or campaign';

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

/**
 * Mirrors the real upload chain's shape: multer FIRST (it is what populates
 * `req.body` for a multipart request), then `validate()`. The harness cannot reuse
 * the route file's private `handleSingleUpload`, so the ordering guarantee for the
 * real chain is asserted statically instead (see section 7b).
 */
const testUpload = multer({ storage: multer.memoryStorage() });

const echoMultipart = (req: express.Request, res: express.Response): void => {
    res.json({
        ok: true,
        body: req.body,
        fileReceived: Boolean((req as express.Request & { file?: unknown }).file),
    });
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

    // Inventory schemas (P0-3.7). The six real routes share one schema, so one echo
    // route covers the shape. `/inventory/stock-in-real` and `/inventory/adjust-real`
    // run the real controller behind a stubbed req.user so the service's own
    // "quantity is required" / "targetStock is required" 400s are exercised; both
    // throw before `mongoose.startSession()`, so no database is reached.
    app.post('/inventory/op', validate({ body: inventoryOperationSchema }), echo);
    app.post(
        '/inventory/stock-in-real',
        stubAuth,
        validate({ body: inventoryOperationSchema }),
        stockInInventoryItem,
    );
    app.post(
        '/inventory/adjust-real',
        stubAuth,
        validate({ body: inventoryOperationSchema }),
        adjustInventoryItem,
    );

    // Media schema (P0-3.8). Two routes: a JSON one for the schema itself, and a
    // multipart one whose chain mirrors the real `POST /api/media/images` exactly
    // (multer → validate → handler) so the after-multer ordering is exercised for
    // real rather than only asserted statically.
    app.post(
        '/media/upload-json',
        validate({ body: mediaUploadSchema, message: MEDIA_ASSET_TYPE_MESSAGE }),
        echo,
    );
    app.post(
        '/media/upload',
        testUpload.single('file'),
        validate({ body: mediaUploadSchema, message: MEDIA_ASSET_TYPE_MESSAGE }),
        echoMultipart,
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

/** Multipart POST with a real file part, so multer actually parses the body. */
const postMultipart = async (
    url: string,
    fields: Record<string, string>,
): Promise<ApiResponse> => {
    const form = new FormData();
    form.append(
        'file',
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
        'tiny.png',
    );

    for (const [key, value] of Object.entries(fields)) {
        form.append(key, value);
    }

    const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(5000),
    });

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

/** The exact wire payload `inventory-action-dialog.tsx:113-119` sends for a delta action. */
const validStockIn = {
    itemType: 'product',
    itemId: '507f1f77bcf86cd799439011',
    quantity: 5,
};

const checkInventorySchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4e. inventory schemas (P0-3.7) ===');

    const valid = await postJson(`${url}/inventory/op`, validStockIn);
    check(
        'inventory: valid stock-in payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validStockIn),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedItemId = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        itemId: { $ne: null },
    });
    checkValidationEnvelope(
        'inventory: operator itemId is rejected by Zod',
        injectedItemId,
        VALIDATION_FAILURE_MESSAGE,
        'body.itemId',
    );

    const injectedQuantity = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        quantity: { $ne: null },
    });
    checkValidationEnvelope(
        'inventory: operator quantity is rejected by Zod (would have reached a stock $inc)',
        injectedQuantity,
        VALIDATION_FAILURE_MESSAGE,
        'body.quantity',
    );

    const derivedFields = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        performedBy: 'someone-else',
        actorId: '507f1f77bcf86cd799439012',
        actorRole: 'admin',
        transactionType: 'CANCELLATION_RESTORATION',
        referenceType: 'Order',
        referenceId: '507f1f77bcf86cd799439013',
        _id: '507f1f77bcf86cd799439014',
    });
    const derivedBody = JSON.stringify(derivedFields.body.body);
    check(
        'inventory: performedBy/actor*/transactionType/reference*/_id are stripped — attribution stays server-derived',
        derivedFields.status === 200 &&
        deepEqual(derivedFields.body.body, validStockIn) &&
        !derivedBody.includes('CANCELLATION_RESTORATION') &&
        !derivedBody.includes('someone-else'),
        `status=${derivedFields.status} body=${derivedBody}`,
    );

    const missingItemType = await postJson(`${url}/inventory/op`, {
        itemId: validStockIn.itemId,
        quantity: 5,
    });
    checkValidationEnvelope(
        'inventory: itemType is required',
        missingItemType,
        VALIDATION_FAILURE_MESSAGE,
        'body.itemType',
    );

    const bogusItemType = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        itemType: 'bogus',
    });
    check(
        "inventory: itemType 'bogus' is rejected (required enum, unlike wishlist where it is optional)",
        bogusItemType.status === 400,
        `status=${bogusItemType.status} message=${String(bogusItemType.body.message)}`,
    );

    for (const quantity of [0, -1, 2.5, MAX_STOCK_LEVEL + 1]) {
        const response = await postJson(`${url}/inventory/op`, { ...validStockIn, quantity });
        check(
            `inventory: quantity ${JSON.stringify(quantity)} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const numericStringQuantity = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        quantity: '7',
    });
    const coercedQuantity = (
        numericStringQuantity.body.body as Record<string, unknown> | undefined
    )?.quantity;
    check(
        "inventory: numeric-string quantity '7' is still coerced to the number 7",
        numericStringQuantity.status === 200 && coercedQuantity === 7,
        `status=${numericStringQuantity.status} quantity=${String(coercedQuantity)}`,
    );

    const adjustZero = await postJson(`${url}/inventory/op`, {
        itemType: 'combo',
        itemId: validStockIn.itemId,
        targetStock: 0,
    });
    check(
        'inventory: adjust accepts targetStock 0 (non-negative, not positive)',
        adjustZero.status === 200,
        `status=${adjustZero.status} message=${String(adjustZero.body.message)}`,
    );

    const adjustNegative = await postJson(`${url}/inventory/op`, {
        itemType: 'combo',
        itemId: validStockIn.itemId,
        targetStock: -3,
    });
    check(
        'inventory: adjust rejects a negative targetStock',
        adjustNegative.status === 400,
        `status=${adjustNegative.status} message=${String(adjustNegative.body.message)}`,
    );

    const longReason = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        reason: 'r'.repeat(MAX_INVENTORY_REASON_LENGTH + 1),
    });
    const longNote = await postJson(`${url}/inventory/op`, {
        ...validStockIn,
        note: 'n'.repeat(MAX_INVENTORY_NOTE_LENGTH + 1),
    });
    check(
        `inventory: reason above ${MAX_INVENTORY_REASON_LENGTH} and note above ${MAX_INVENTORY_NOTE_LENGTH} are rejected`,
        longReason.status === 400 && longNote.status === 400,
        `reason=${longReason.status} note=${longNote.status}`,
    );

    // The real controller: proves the service's per-transaction-type presence checks
    // are still reachable and were NOT made dead by this schema.
    const missingQuantity = await postJson(`${url}/inventory/stock-in-real`, {
        itemType: 'product',
        itemId: validStockIn.itemId,
    });
    check(
        'inventory: stock-in without quantity still returns the service\'s exact "quantity is required" 400',
        missingQuantity.status === 400 && missingQuantity.body.message === 'quantity is required',
        `status=${missingQuantity.status} message=${String(missingQuantity.body.message)}`,
    );

    const missingTargetStock = await postJson(`${url}/inventory/adjust-real`, {
        itemType: 'product',
        itemId: validStockIn.itemId,
    });
    check(
        'inventory: adjust without targetStock still returns the service\'s exact "targetStock is required for a manual adjustment" 400',
        missingTargetStock.status === 400 &&
        missingTargetStock.body.message === 'targetStock is required for a manual adjustment',
        `status=${missingTargetStock.status} message=${String(missingTargetStock.body.message)}`,
    );
};

/**
 * Body of `POST /api/media/images`. `assetType` is the only field the client may
 * influence; the file itself is multer's job.
 */
const checkMediaSchema = async (url: string): Promise<void> => {
    console.log('\n=== 4f. media schema (P0-3.8) ===');

    const valid = await postJson(`${url}/media/upload-json`, { assetType: 'product' });
    check(
        'media: valid assetType passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, { assetType: 'product' }),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const upper = await postJson(`${url}/media/upload-json`, { assetType: 'PRODUCT' });
    const upperValue = (upper.body.body as Record<string, unknown> | undefined)?.assetType;
    check(
        "media: 'PRODUCT' is still accepted and normalised to 'product' (parseAssetType's behaviour preserved)",
        upper.status === 200 && upperValue === 'product',
        `status=${upper.status} assetType=${JSON.stringify(upperValue)}`,
    );

    const padded = await postJson(`${url}/media/upload-json`, { assetType: '  combo  ' });
    const paddedValue = (padded.body.body as Record<string, unknown> | undefined)?.assetType;
    check(
        "media: '  combo  ' is still trimmed and accepted",
        padded.status === 200 && paddedValue === 'combo',
        `status=${padded.status} assetType=${JSON.stringify(paddedValue)}`,
    );

    const disabledType = await postJson(`${url}/media/upload-json`, { assetType: 'review' });
    check(
        "media: 'review' is rejected while review uploads are disabled",
        disabledType.status === 400 && disabledType.body.message === MEDIA_ASSET_TYPE_MESSAGE,
        `status=${disabledType.status} message=${String(disabledType.body.message)}`,
    );

    const bogus = await postJson(`${url}/media/upload-json`, { assetType: 'bogus' });
    check(
        "media: unknown assetType keeps the route's exact legacy 400 wording",
        bogus.status === 400 && bogus.body.message === MEDIA_ASSET_TYPE_MESSAGE,
        `status=${bogus.status} message=${String(bogus.body.message)}`,
    );

    const missing = await postJson(`${url}/media/upload-json`, {});
    check(
        "media: missing assetType 400s with the same wording (it is a required field)",
        missing.status === 400 && missing.body.message === MEDIA_ASSET_TYPE_MESSAGE,
        `status=${missing.status} message=${String(missing.body.message)}`,
    );

    const operatorType = await postJson(`${url}/media/upload-json`, { assetType: { $ne: null } });
    check(
        'media: a non-string assetType (operator payload) is rejected',
        operatorType.status === 400,
        `status=${operatorType.status} message=${String(operatorType.body.message)}`,
    );

    const extra = await postJson(`${url}/media/upload-json`, {
        assetType: 'product',
        folder: '/evil',
        fileNamePrefix: 'evil',
        isPrivate: true,
    });
    check(
        'media: folder/fileNamePrefix/isPrivate are stripped — a client cannot choose its ImageKit destination',
        extra.status === 200 && deepEqual(extra.body.body, { assetType: 'product' }),
        `status=${extra.status} body=${JSON.stringify(extra.body.body)}`,
    );

    const multipart = await postMultipart(`${url}/media/upload`, { assetType: 'campaign' });
    check(
        'media: multipart upload validates after multer populates req.body (file really parsed)',
        multipart.status === 200 &&
        deepEqual(multipart.body.body, { assetType: 'campaign' }) &&
        multipart.body.fileReceived === true,
        `status=${multipart.status} body=${JSON.stringify(multipart.body.body)} file=${String(multipart.body.fileReceived)}`,
    );

    const multipartMissing = await postMultipart(`${url}/media/upload`, {});
    check(
        'media: multipart upload with no assetType is rejected — proves the after-multer ordering works',
        multipartMissing.status === 400 && multipartMissing.body.message === MEDIA_ASSET_TYPE_MESSAGE,
        `status=${multipartMissing.status} message=${String(multipartMissing.body.message)}`,
    );

    const multipartExtra = await postMultipart(`${url}/media/upload`, {
        assetType: 'product',
        folder: '/evil',
    });
    check(
        'media: multipart unknown field is stripped',
        multipartExtra.status === 200 && deepEqual(multipartExtra.body.body, { assetType: 'product' }),
        `status=${multipartExtra.status} body=${JSON.stringify(multipartExtra.body.body)}`,
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

/**
 * All six manual stock operations. They live on `adminInventoryRoutes` (mounted at
 * `/api/admin/inventory`), not on a router literally named `router`.
 */
const INVENTORY_VALIDATED_ROUTES = [
    { path: '/stock-in', controller: 'stockInInventoryItem' },
    { path: '/restock', controller: 'restockInventoryItem' },
    { path: '/stock-out', controller: 'stockOutInventoryItem' },
    { path: '/adjust', controller: 'adjustInventoryItem' },
    { path: '/damaged', controller: 'markInventoryDamaged' },
    { path: '/lost', controller: 'markInventoryLost' },
].map((route) => ({
    ...route,
    file: 'inventory/inventory.routes.ts',
    method: 'post',
    routerName: 'adminInventoryRoutes',
    subject: 'inventory',
    label: `POST /api/admin/inventory${route.path}`,
}));

/**
 * Parses `<routerName>.<method>('path', ...handlers)` registrations.
 *
 * `routerName` is a parameter because not every router is named `router` — the
 * inventory routes are registered on `adminInventoryRoutes`.
 */
const parseRouterRegistrations = (
    source: string,
    routerName = 'router',
): Array<{ method: string; path: string; args: string }> => {
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const routes: Array<{ method: string; path: string; args: string }> = [];

    for (const method of methods) {
        const needle = `${routerName}.${method}(`;
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
    /** Router identifier in the source file; defaults to `router`. */
    routerName?: string;
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
    const registration = parseRouterRegistrations(source, spec.routerName ?? 'router').find(
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

    for (const spec of INVENTORY_VALIDATED_ROUTES) {
        assertValidateBeforeController(spec);
    }
};

/**
 * Media is the one route where `validate()` must NOT come first.
 *
 * `POST /api/media/images` is `multipart/form-data`, so `req.body` only exists
 * after multer has parsed the request. Validating before `handleSingleUpload`
 * would read `assetType === undefined` and reject every upload — a total outage of
 * the admin image pipeline that no schema-level test could catch.
 */
const MEDIA_UPLOAD_ROUTE = {
    file: 'media/media.routes.ts',
    method: 'post',
    path: '/images',
    controller: 'mediaController',
};

const checkMediaValidateFollowsMulter = (): void => {
    console.log('\n=== 7b. media: validate() runs AFTER multer ===');

    const label = 'POST /api/media/images';
    const failureMessage = `media route ${label} must validate AFTER handleSingleUpload — multer populates req.body for a multipart request, so a check before it would reject every upload with a missing assetType`;

    const source = readFileSync(join(__dirname, '..', 'src', MEDIA_UPLOAD_ROUTE.file), 'utf8');
    const registration = parseRouterRegistrations(source).find(
        (route) => route.method === MEDIA_UPLOAD_ROUTE.method && route.path === MEDIA_UPLOAD_ROUTE.path,
    );

    if (!registration) {
        console.log(`  FAIL ${failureMessage}`);
        console.log(`       (no POST '/images' registration found in ${MEDIA_UPLOAD_ROUTE.file})`);
        failures.push(failureMessage);
        return;
    }

    const argumentsAfterPath = registration.args.slice(
        registration.args.indexOf("'", registration.args.indexOf("'") + 1) + 1,
    );
    const multerIndex = argumentsAfterPath.indexOf('handleSingleUpload');
    const validateIndex = argumentsAfterPath.indexOf('validate(');
    const controllerIndex = argumentsAfterPath.indexOf(MEDIA_UPLOAD_ROUTE.controller);

    const ordered =
        multerIndex !== -1 &&
        validateIndex !== -1 &&
        multerIndex < validateIndex &&
        validateIndex < controllerIndex;

    if (ordered) {
        console.log(
            `  OK   ${label}: handleSingleUpload (${multerIndex}) runs before validate() (${validateIndex}), which runs before the controller (${controllerIndex})`,
        );
        return;
    }

    console.log(`  FAIL ${failureMessage}`);
    console.log(
        `       (multer at ${multerIndex}, validate() at ${validateIndex}, controller at ${controllerIndex})`,
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
        await checkReviewSchema(url);
        await checkAddressSchemas(url);
        await checkWishlistSchema(url);
        await checkInventorySchemas(url);
        await checkMediaSchema(url);
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    checkStripUnit();
    checkAuthRoutesValidateFirst();
    checkValidatedRoutes();
    checkMediaValidateFollowsMulter();

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
