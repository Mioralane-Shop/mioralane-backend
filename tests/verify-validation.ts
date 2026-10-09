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
import { mediaUploadSchema } from '../src/media/media-upload.schemas';
import {
    COUPON_CODE_PATTERN,
    createCampaignSchema,
    createCouponSchema,
    updateCampaignSchema,
    updateCouponSchema,
} from '../src/promotion/promotion.schemas';
import { createComboSchema, updateComboSchema } from '../src/combo/combo.schemas';
import {
    createProductSchema,
    productArrivalSchema,
    updateProductSchema,
} from '../src/product/product.schemas';
import { announcementSettingsSchema } from '../src/announcement/announcement.schemas';
import { crossSellSettingsSchema } from '../src/cross-sell/cross-sell.schemas';
import { shippingSettingsSchema } from '../src/shipping/shipping.schemas';
import { inventorySettingsSchema } from '../src/inventory/inventory-settings.schemas';
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
const MEDIA_ASSET_TYPE_MESSAGE = 'assetType must be product, combo, campaign, or brand-logo';

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
 * Narrows an `AuthenticatedRequest` controller to the plain `RequestHandler`
 * Express accepts.
 *
 * Type-level only and erased at compile time — the same cast `adminGuard` uses in
 * `auth.middleware.ts`. It is needed because `AuthenticatedRequest` widens the
 * handler's parameter to one that *requires* `req.user`, and under
 * `strictFunctionTypes` a function that needs more on its parameter is not
 * assignable to one accepting any `Request`. Registering `stubAuth` ahead of each
 * controller below is what makes the narrowed parameter true at runtime.
 */
const asHandler = (handler: unknown): RequestHandler => handler as RequestHandler;

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
        asHandler(createOrder),
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
        asHandler(createMyAddress),
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
        asHandler(stockInInventoryItem),
    );
    app.post(
        '/inventory/adjust-real',
        stubAuth,
        validate({ body: inventoryOperationSchema }),
        asHandler(adjustInventoryItem),
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

    // Promotion schemas (P0-3.9). Four mutations, four schemas: create requires the
    // fields the models mark `required`, update is a partial patch (the handlers
    // use `.set(body)`).
    app.post('/promotion/campaign', validate({ body: createCampaignSchema }), echo);
    app.put('/promotion/campaign', validate({ body: updateCampaignSchema }), echo);
    app.post('/promotion/coupon', validate({ body: createCouponSchema }), echo);
    app.put('/promotion/coupon', validate({ body: updateCouponSchema }), echo);

    // Combo schemas (P0-3.10). The real router is mixed (public GETs), so the guard
    // and the schema are applied per route; these echo routes cover the schemas.
    app.post('/combo/create', validate({ body: createComboSchema }), echo);
    app.put('/combo/update', validate({ body: updateComboSchema }), echo);

    // Product schemas (P0-3.11). The real handlers run `sanitizeMutationBody()`
    // (an allowlist filter) *after* `validate()`, so these echo routes exercise the
    // schema layer; the filter itself is unchanged and still runs last.
    app.post('/product/create', validate({ body: createProductSchema }), echo);
    app.put('/product/update', validate({ body: updateProductSchema }), echo);
    app.patch('/product/arrival', validate({ body: productArrivalSchema }), echo);

    // Settings singletons (P0-3.12). All four are PUT upserts whose normalizers apply
    // per-field defaults, so the schemas are deliberately all-optional.
    app.put('/settings/announcement', validate({ body: announcementSettingsSchema }), echo);
    app.put('/settings/cross-sell', validate({ body: crossSellSettingsSchema }), echo);
    app.put('/settings/shipping', validate({ body: shippingSettingsSchema }), echo);
    app.put('/settings/inventory', validate({ body: inventorySettingsSchema }), echo);

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

const sendJson = async (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload: Json,
): Promise<ApiResponse> => {
    const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
    });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const postJson = async (url: string, payload: Json): Promise<ApiResponse> =>
    sendJson('POST', url, payload);

/** The promotion and campaign/coupon updates are PUTs, not POSTs. */
const putJson = async (url: string, payload: Json): Promise<ApiResponse> =>
    sendJson('PUT', url, payload);

/** `PATCH /api/products/:id/pre-order/arrive`. */
const patchJson = async (url: string, payload: Json): Promise<ApiResponse> =>
    sendJson('PATCH', url, payload);

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

/** The shape `campaign-form.tsx:110-118` sends (it also spreads the whole fetched doc). */
const validCampaignCreate = {
    name: 'Eid Sale',
    campaignType: 'automatic_discount',
    status: 'draft',
    discount: { type: 'percentage', value: 15 },
    schedule: {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T00:00:00.000Z',
    },
};

/** The shape `coupon-form.tsx:65-70` sends (code as typed; the schema normalises it). */
const validCouponCreate = {
    code: 'save10',
    discountType: 'percentage',
    discountValue: 10,
    startDate: '2026-01-01T00:00:00.000Z',
    expiryDate: '2026-01-31T00:00:00.000Z',
    isActive: true,
};

/** What `validCouponCreate` becomes after the code transform. */
const normalizedCouponCreate = { ...validCouponCreate, code: 'SAVE10' };

const checkPromotionSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4g. promotion schemas (P0-3.9) ===');

    /* ── campaign: the happy path ───────────────────────────────────────────── */

    const validCampaign = await postJson(`${url}/promotion/campaign`, validCampaignCreate);
    check(
        'campaign: valid create payload passes unchanged',
        validCampaign.status === 200 && deepEqual(validCampaign.body.body, validCampaignCreate),
        `status=${validCampaign.status} body=${JSON.stringify(validCampaign.body.body)}`,
    );

    /* ── campaign: mass assignment ──────────────────────────────────────────── */

    const campaignMassAssignment = await postJson(`${url}/promotion/campaign`, {
        ...validCampaignCreate,
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439012',
        __v: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        publishedAt: '2020-01-01T00:00:00.000Z',
        runtimeStatus: 'active',
        createdBy: '507f1f77bcf86cd799439013',
        createdByAdmin: true,
        role: 'admin',
    });
    const campaignMassBody = JSON.stringify(campaignMassAssignment.body.body);
    check(
        'campaign: _id/id/__v/createdAt/updatedAt/publishedAt/runtimeStatus/createdBy/role are all stripped',
        campaignMassAssignment.status === 200 &&
        deepEqual(campaignMassAssignment.body.body, validCampaignCreate) &&
        !campaignMassBody.includes('publishedAt') &&
        !campaignMassBody.includes('createdBy') &&
        !campaignMassBody.includes('2020-01-01'),
        `status=${campaignMassAssignment.status} body=${campaignMassBody}`,
    );

    /* ── campaign: enums ────────────────────────────────────────────────────── */

    const campaignEnumCases: Array<[string, unknown]> = [
        ['campaignType', 'bogus_campaign'],
        ['status', 'archived'],
    ];
    for (const [field, value] of campaignEnumCases) {
        const response = await postJson(`${url}/promotion/campaign`, {
            ...validCampaignCreate,
            [field]: value,
        });
        check(
            `campaign: ${field} '${String(value)}' is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const campaignNestedEnumCases: Array<[string, Record<string, unknown>]> = [
        ['discount.type', { ...validCampaignCreate.discount, type: 'bogus' }],
        [
            'popup.actionType',
            { enabled: true, actionType: 'bogus' },
        ],
        ['eligibility.appliesTo', { appliesTo: 'bogus' }],
    ];
    for (const [label, nestedValue] of campaignNestedEnumCases) {
        const [group] = label.split('.');
        const response = await postJson(`${url}/promotion/campaign`, {
            ...validCampaignCreate,
            [group]: nestedValue,
        });
        check(
            `campaign: ${label} bogus value is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    /* ── campaign: numeric shapes ───────────────────────────────────────────── */

    const campaignNumericCases: Array<[string, Record<string, unknown>]> = [
        ['priority -1', { priority: -1 }],
        ['discount.value -5', { discount: { type: 'percentage', value: -5 } }],
        ['discount.minimumOrderValue -1', { discount: { type: 'fixed', value: 50, minimumOrderValue: -1 } }],
        ['usageLimits.totalUsageLimit 0', { usageLimits: { totalUsageLimit: 0 } }],
        ['usageLimits.perCustomerUsageLimit 2.5', { usageLimits: { perCustomerUsageLimit: 2.5 } }],
    ];
    for (const [label, patch] of campaignNumericCases) {
        const response = await postJson(`${url}/promotion/campaign`, {
            ...validCampaignCreate,
            ...patch,
        });
        check(
            `campaign: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    /* ── campaign: injection-shaped nested values ────────────────────────────── */

    const campaignProductIdInjection = await postJson(`${url}/promotion/campaign`, {
        ...validCampaignCreate,
        eligibility: { appliesTo: 'products', productIds: [{ $ne: null }] },
    });
    checkValidationEnvelope(
        'campaign: operator value inside eligibility.productIds is rejected',
        campaignProductIdInjection,
        VALIDATION_FAILURE_MESSAGE,
        'body.eligibility.productIds',
    );

    const campaignCategoryInjection = await postJson(`${url}/promotion/campaign`, {
        ...validCampaignCreate,
        eligibility: { appliesTo: 'categories', categories: [{ $ne: null }] },
    });
    checkValidationEnvelope(
        'campaign: operator value inside eligibility.categories is rejected',
        campaignCategoryInjection,
        VALIDATION_FAILURE_MESSAGE,
        'body.eligibility.categories',
    );

    const campaignCouponIdInjection = await postJson(`${url}/promotion/campaign`, {
        ...validCampaignCreate,
        popup: { enabled: true, actionType: 'coupon', couponId: { $ne: null } },
    });
    checkValidationEnvelope(
        'campaign: operator popup.couponId is rejected',
        campaignCouponIdInjection,
        VALIDATION_FAILURE_MESSAGE,
        'body.popup.couponId',
    );

    /* ── campaign: dates ────────────────────────────────────────────────────── */

    const campaignBadDate = await postJson(`${url}/promotion/campaign`, {
        ...validCampaignCreate,
        schedule: { startDate: 'garbage', endDate: '2026-01-31T00:00:00.000Z' },
    });
    checkValidationEnvelope(
        "campaign: an unparseable schedule.startDate is a clean 400 (was a Mongoose CastError)",
        campaignBadDate,
        VALIDATION_FAILURE_MESSAGE,
        'body.schedule.startDate',
    );

    /* ── campaign: create requires the model's required fields ──────────────── */

    const campaignRequiredCases: Array<[string, Record<string, unknown>]> = [
        ['name', { name: undefined }],
        ['campaignType', { campaignType: undefined }],
        ['schedule', { schedule: undefined }],
    ];
    for (const [field, patch] of campaignRequiredCases) {
        const response = await postJson(`${url}/promotion/campaign`, {
            ...validCampaignCreate,
            ...patch,
        });
        checkValidationEnvelope(
            `campaign: create without ${field} is rejected`,
            response,
            VALIDATION_FAILURE_MESSAGE,
            `body.${field}`,
        );
    }

    /* ── campaign: update is a partial patch ────────────────────────────────── */

    const campaignPartialUpdate = await putJson(`${url}/promotion/campaign`, {
        status: 'published',
    });
    check(
        'campaign: update accepts a partial body ({ status: published } alone)',
        campaignPartialUpdate.status === 200 &&
        deepEqual(campaignPartialUpdate.body.body, { status: 'published' }),
        `status=${campaignPartialUpdate.status} body=${JSON.stringify(campaignPartialUpdate.body.body)}`,
    );

    /* ── coupon: happy path + code normalisation ────────────────────────────── */

    const validCoupon = await postJson(`${url}/promotion/coupon`, validCouponCreate);
    check(
        'coupon: valid create payload passes, with code normalised to upper case',
        validCoupon.status === 200 && deepEqual(validCoupon.body.body, normalizedCouponCreate),
        `status=${validCoupon.status} body=${JSON.stringify(validCoupon.body.body)}`,
    );

    const messyCode = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        code: '  save  10 ',
    });
    const messyCodeValue = (messyCode.body.body as Record<string, unknown> | undefined)?.code;
    check(
        "coupon: '  save  10 ' is normalised to 'SAVE10' exactly as normalizeCouponCode does",
        messyCode.status === 200 && messyCodeValue === 'SAVE10',
        `status=${messyCode.status} code=${JSON.stringify(messyCodeValue)}`,
    );

    /* ── coupon: code charset (P1.6.7) ──────────────────────────────────────── */

    // The rule is asserted from the exported constant, never re-typed here, so a
    // change to the pattern cannot leave this section testing the old one.
    check(
        'coupon: the exported pattern is the documented allowlist',
        COUPON_CODE_PATTERN.source === '^[A-Z0-9_-]{2,40}$',
        COUPON_CODE_PATTERN.source,
    );

    const codeCases: Array<{ code: unknown; accepted: boolean; why: string }> = [
        { code: 'SAVE10', accepted: true, why: 'the plain case' },
        { code: 'save10', accepted: true, why: 'normalised to upper case first' },
        { code: 'SAVE 10', accepted: true, why: 'whitespace is stripped' },
        { code: 'SUMMER-25_BD', accepted: true, why: 'hyphen and underscore are allowed' },
        { code: 'AB', accepted: true, why: 'the 2-character lower bound' },
        { code: 'A'.repeat(40), accepted: true, why: 'the 40-character upper bound' },
        { code: 'A', accepted: false, why: 'shorter than the lower bound' },
        { code: 'A'.repeat(41), accepted: false, why: 'longer than the upper bound' },
        { code: 'SAVE@10', accepted: false, why: 'a character outside the allowlist' },
        { code: 'SAVE$10', accepted: false, why: 'the operator sigil must not be storable' },
        { code: 'SAVE.10', accepted: false, why: 'a dot is not in the allowlist' },
        { code: 'SUM&MER', accepted: false, why: 'an ampersand is not in the allowlist' },
        { code: 'সেভ১০', accepted: false, why: 'a non-ASCII code' },
    ];

    for (const entry of codeCases) {
        const response = await postJson(`${url}/promotion/coupon`, {
            ...validCouponCreate,
            code: entry.code,
        });

        check(
            `coupon: ${JSON.stringify(entry.code)} is ${entry.accepted ? 'accepted' : 'refused'} (${entry.why})`,
            entry.accepted ? response.status === 200 : response.status === 400,
            `status=${response.status} body=${JSON.stringify(response.body).slice(0, 200)}`,
        );
    }

    // An empty code keeps its original wording — the charset rule must not become
    // the message a client shows for "you did not type anything".
    const emptyCode = await postJson(`${url}/promotion/coupon`, { ...validCouponCreate, code: '' });
    const emptyCodeIssues = JSON.stringify(emptyCode.body.errors);
    check(
        'coupon: an empty code still reports "Coupon code is required"',
        emptyCode.status === 400 && emptyCodeIssues.includes('Coupon code is required'),
        `status=${emptyCode.status} errors=${emptyCodeIssues.slice(0, 160)}`,
    );

    // Discrimination: the same request must NOT be refused when the pattern accepts
    // it, otherwise every check above would pass on a route that rejects everything.
    const acceptControl = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        code: 'CONTROL-1',
    });
    check(
        'coupon: control — a code inside the allowlist is still accepted',
        acceptControl.status === 200,
        `status=${acceptControl.status}`,
    );

    /* ── coupon: mass assignment (usageCount is the important one) ──────────── */

    const couponMassAssignment = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        usageCount: 0,
        stats: { totalUses: 0, totalDiscountGiven: 0, uniqueCustomers: 0, remainingUses: null },
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439012',
        __v: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        role: 'admin',
    });
    const couponMassBody = JSON.stringify(couponMassAssignment.body.body);
    check(
        'coupon: usageCount/stats/_id/id/__v/createdAt/updatedAt/role are all stripped',
        couponMassAssignment.status === 200 &&
        deepEqual(couponMassAssignment.body.body, normalizedCouponCreate) &&
        !couponMassBody.includes('usageCount') &&
        !couponMassBody.includes('stats') &&
        !couponMassBody.includes('2020-01-01'),
        `status=${couponMassAssignment.status} body=${couponMassBody}`,
    );

    /* ── coupon: shapes ─────────────────────────────────────────────────────── */

    const couponBadType = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        discountType: 'bogus',
    });
    check(
        'coupon: discountType bogus value is rejected',
        couponBadType.status === 400,
        `status=${couponBadType.status} message=${String(couponBadType.body.message)}`,
    );

    const couponNegativeValue = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        discountValue: -1,
    });
    check(
        'coupon: negative discountValue is rejected',
        couponNegativeValue.status === 400,
        `status=${couponNegativeValue.status} message=${String(couponNegativeValue.body.message)}`,
    );

    const couponBadExpiry = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        expiryDate: 'garbage',
    });
    checkValidationEnvelope(
        'coupon: an unparseable expiryDate is a clean 400',
        couponBadExpiry,
        VALIDATION_FAILURE_MESSAGE,
        'body.expiryDate',
    );

    const couponProductIdInjection = await postJson(`${url}/promotion/coupon`, {
        ...validCouponCreate,
        appliesTo: 'products',
        productIds: [{ $ne: null }],
    });
    checkValidationEnvelope(
        'coupon: operator value inside productIds is rejected',
        couponProductIdInjection,
        VALIDATION_FAILURE_MESSAGE,
        'body.productIds',
    );

    /* ── coupon: create requires the model's required fields ───────────────── */

    const couponRequiredCases: Array<[string, Record<string, unknown>]> = [
        ['code', { code: undefined }],
        ['discountType', { discountType: undefined }],
        ['discountValue', { discountValue: undefined }],
        ['startDate', { startDate: undefined }],
        ['expiryDate', { expiryDate: undefined }],
    ];
    for (const [field, patch] of couponRequiredCases) {
        const response = await postJson(`${url}/promotion/coupon`, {
            ...validCouponCreate,
            ...patch,
        });
        checkValidationEnvelope(
            `coupon: create without ${field} is rejected`,
            response,
            VALIDATION_FAILURE_MESSAGE,
            `body.${field}`,
        );
    }

    /* ── coupon: update is a partial patch ─────────────────────────────────── */

    const couponPartialUpdate = await putJson(`${url}/promotion/coupon`, { isActive: false });
    check(
        'coupon: update accepts a partial body ({ isActive: false } alone)',
        couponPartialUpdate.status === 200 &&
        deepEqual(couponPartialUpdate.body.body, { isActive: false }),
        `status=${couponPartialUpdate.status} body=${JSON.stringify(couponPartialUpdate.body.body)}`,
    );
};

/** Minimal shape the admin combo form sends for a create. */
const validComboCreate = {
    title: 'Glass Skin Bundle',
    description: 'Five piece routine',
    badge: 'MORNING PACK',
    routineTag: 'For Glass Skin',
    price: 2400,
    compareAtPrice: 3000,
    includedItems: ['Cleanser', 'Toner', 'Serum'],
    concerns: ['Complete Routine'],
    images: ['https://ik.imagekit.io/mioralane/combos/a.png'],
    stock: 12,
    skinType: 'All skin types',
    isBestSeller: true,
    isNewArrival: false,
};

const checkComboSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4h. combo schemas (P0-3.10) ===');

    const valid = await postJson(`${url}/combo/create`, validComboCreate);
    check(
        'combo: valid create payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validComboCreate),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedTitle = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        title: { $ne: null },
    });
    checkValidationEnvelope(
        'combo: operator title is rejected by Zod',
        injectedTitle,
        VALIDATION_FAILURE_MESSAGE,
        'body.title',
    );

    /* ── mass assignment: the point of this block ─────────────────────────────── */

    const massAssignment = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439012',
        __v: 7,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        slug: 'attacker-chosen-slug',
        rating: 5,
        numReviews: 999,
        savings: 999999,
    });
    const massBody = JSON.stringify(massAssignment.body.body);
    check(
        'combo: slug/rating/numReviews/savings/_id/id/__v/createdAt/updatedAt are all stripped',
        massAssignment.status === 200 &&
        deepEqual(massAssignment.body.body, validComboCreate) &&
        !massBody.includes('attacker-chosen-slug') &&
        !massBody.includes('999999') &&
        !massBody.includes('2020-01-01'),
        `status=${massAssignment.status} body=${massBody}`,
    );

    /* ── helper fields must SURVIVE, or uploads/images silently stop working ──── */

    const withMedia = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        media: [{ provider: 'imagekit', url: 'https://ik.imagekit.io/mioralane/combos/b.png', alt: 'x' }],
    });
    const withMediaBody = withMedia.body.body as Record<string, unknown> | undefined;
    check(
        'combo: media and images are NOT stripped (declaring them is what keeps uploads working)',
        withMedia.status === 200 &&
        Array.isArray(withMediaBody?.media) &&
        (withMediaBody?.media as unknown[]).length === 1 &&
        Array.isArray(withMediaBody?.images),
        `status=${withMedia.status} body=${JSON.stringify(withMedia.body.body)}`,
    );

    /* ── required + numeric ranges ───────────────────────────────────────────── */

    const missingTitle = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        title: undefined,
    });
    checkValidationEnvelope(
        'combo: create without title is rejected',
        missingTitle,
        VALIDATION_FAILURE_MESSAGE,
        'body.title',
    );

    const missingPrice = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        price: undefined,
    });
    checkValidationEnvelope(
        'combo: create without price is rejected',
        missingPrice,
        VALIDATION_FAILURE_MESSAGE,
        'body.price',
    );

    const comboNumericCases: Array<[string, Record<string, unknown>]> = [
        ['price -1', { price: -1 }],
        ['compareAtPrice -1', { compareAtPrice: -1 }],
        ['stock -1', { stock: -1 }],
        ['stock 1.5', { stock: 1.5 }],
    ];
    for (const [label, patch] of comboNumericCases) {
        const response = await postJson(`${url}/combo/create`, { ...validComboCreate, ...patch });
        check(
            `combo: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const descriptionTooLong = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        description: 'd'.repeat(2001),
    });
    check(
        'combo: description above the model\'s 2000-character cap is rejected',
        descriptionTooLong.status === 400,
        `status=${descriptionTooLong.status} message=${String(descriptionTooLong.body.message)}`,
    );

    /* ── arrays ─────────────────────────────────────────────────────────────── */

    const injectedIncludedItems = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        includedItems: [{ $ne: null }],
    });
    checkValidationEnvelope(
        'combo: operator value inside includedItems is rejected',
        injectedIncludedItems,
        VALIDATION_FAILURE_MESSAGE,
        'body.includedItems',
    );

    const nonStringImages = await postJson(`${url}/combo/create`, {
        ...validComboCreate,
        images: [123],
    });
    check(
        'combo: non-string image entry is rejected (Mongoose would have silently cast it)',
        nonStringImages.status === 400,
        `status=${nonStringImages.status} message=${String(nonStringImages.body.message)}`,
    );

    /* ── update: partial patch + same server-owned field stripping ──────────── */

    const partialStockUpdate = await putJson(`${url}/combo/update`, { stock: 5 });
    check(
        'combo: update accepts a partial body ({ stock: 5 } alone)',
        partialStockUpdate.status === 200 && deepEqual(partialStockUpdate.body.body, { stock: 5 }),
        `status=${partialStockUpdate.status} body=${JSON.stringify(partialStockUpdate.body.body)}`,
    );

    const updateMassAssignment = await putJson(`${url}/combo/update`, {
        title: 'Renamed',
        slug: 'attacker-chosen-slug',
        rating: 5,
        numReviews: 999,
        savings: 999999,
        category: 'not-a-combo',
        brand: 'Attacker Brand',
    });
    const updateMassBody = JSON.stringify(updateMassAssignment.body.body);
    check(
        'combo: update strips slug/rating/numReviews/savings and cannot change category/brand (not in the allowlist)',
        updateMassAssignment.status === 200 &&
        deepEqual(updateMassAssignment.body.body, { title: 'Renamed' }),
        `status=${updateMassAssignment.status} body=${updateMassBody}`,
    );

    const badBoolean = await putJson(`${url}/combo/update`, { isBestSeller: 'yes' });
    check(
        'combo: update rejects a non-boolean isBestSeller',
        badBoolean.status === 400,
        `status=${badBoolean.status} message=${String(badBoolean.body.message)}`,
    );
};

/** Minimal shape the admin product form sends for a create. */
const validProductCreate = {
    title: 'Vitamin C Serum',
    brand: 'Mioralane',
    category: 'serum',
    description: 'Brightening serum',
    price: 1200,
    salePrice: 990,
    stock: 25,
    images: ['https://ik.imagekit.io/mioralane/products/a.png'],
    skinType: ['Oily'],
    skinConcern: ['Dullness'],
    keyIngredients: [{ name: 'Vitamin C', benefit: 'Brightens' }],
    isBestSeller: false,
    isNewArrival: true,
};

const checkProductSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4i. product schemas (P0-3.11) ===');

    const valid = await postJson(`${url}/product/create`, validProductCreate);
    check(
        'product: valid create payload passes unchanged',
        valid.status === 200 && deepEqual(valid.body.body, validProductCreate),
        `status=${valid.status} body=${JSON.stringify(valid.body.body)}`,
    );

    const injectedTitle = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        title: { $ne: null },
    });
    checkValidationEnvelope(
        'product: operator title is rejected by Zod',
        injectedTitle,
        VALIDATION_FAILURE_MESSAGE,
        'body.title',
    );

    /* ── mass assignment (the allowlist is the second layer) ──────────────────── */

    const massAssignment = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        rating: 5,
        numReviews: 999,
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439012',
        __v: 7,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const massBody = JSON.stringify(massAssignment.body.body);
    check(
        'product: rating/numReviews/_id/id/__v/createdAt/updatedAt are all stripped',
        massAssignment.status === 200 &&
        deepEqual(massAssignment.body.body, validProductCreate) &&
        !massBody.includes('999') &&
        !massBody.includes('2020-01-01'),
        `status=${massAssignment.status} body=${massBody}`,
    );

    /* ── slug MUST survive: resolveSlug() prefers it, and the admin sends it ─── */

    const withSlug = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        slug: 'custom-url-slug',
    });
    const slugValue = (withSlug.body.body as Record<string, unknown> | undefined)?.slug;
    check(
        "product: a client-supplied slug is NOT stripped — resolveSlug() prefers it and the admin sends one on every save",
        withSlug.status === 200 && slugValue === 'custom-url-slug',
        `status=${withSlug.status} slug=${JSON.stringify(slugValue)}`,
    );

    /* ── helper fields must survive ──────────────────────────────────────────── */

    const withMedia = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        media: [{ provider: 'imagekit', url: 'https://ik.imagekit.io/mioralane/products/b.png' }],
        lowStockThreshold: 3,
    });
    const withMediaBody = withMedia.body.body as Record<string, unknown> | undefined;
    check(
        'product: media and lowStockThreshold are NOT stripped',
        withMedia.status === 200 &&
        Array.isArray(withMediaBody?.media) &&
        (withMediaBody?.media as unknown[]).length === 1 &&
        withMediaBody?.lowStockThreshold === 3,
        `status=${withMedia.status} body=${JSON.stringify(withMedia.body.body)}`,
    );

    const clearedThreshold = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        lowStockThreshold: null,
    });
    check(
        'product: lowStockThreshold null is preserved (it clears the threshold)',
        clearedThreshold.status === 200 &&
        (clearedThreshold.body.body as Record<string, unknown> | undefined)?.lowStockThreshold === null,
        `status=${clearedThreshold.status} body=${JSON.stringify(clearedThreshold.body.body)}`,
    );

    /* ── create requires the model's required fields ─────────────────────────── */

    for (const field of ['title', 'brand', 'category', 'price']) {
        const response = await postJson(`${url}/product/create`, {
            ...validProductCreate,
            [field]: undefined,
        });
        checkValidationEnvelope(
            `product: create without ${field} is rejected`,
            response,
            VALIDATION_FAILURE_MESSAGE,
            `body.${field}`,
        );
    }

    /* ── numeric ranges ─────────────────────────────────────────────────────── */

    const productNumericCases: Array<[string, Record<string, unknown>]> = [
        ['price -1', { price: -1 }],
        ['salePrice -1', { salePrice: -1 }],
        ['stock -1', { stock: -1 }],
        ['stock 1.5', { stock: 1.5 }],
        ['lowStockThreshold -1', { lowStockThreshold: -1 }],
        ['lowStockThreshold 2.5', { lowStockThreshold: 2.5 }],
    ];
    for (const [label, patch] of productNumericCases) {
        const response = await postJson(`${url}/product/create`, { ...validProductCreate, ...patch });
        check(
            `product: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const descriptionTooLong = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        description: 'd'.repeat(2001),
    });
    check(
        "product: description above the model's 2000-character cap is rejected",
        descriptionTooLong.status === 400,
        `status=${descriptionTooLong.status}`,
    );

    /* ── enums that DO exist in the model ───────────────────────────────────── */

    const badAvailability = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        availabilityMode: 'coming_soon',
    });
    check(
        "product: availabilityMode 'coming_soon' is rejected (model enum: in_stock | pre_order)",
        badAvailability.status === 400,
        `status=${badAvailability.status} message=${String(badAvailability.body.message)}`,
    );

    const badPreOrderStatus = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        availabilityMode: 'pre_order',
        preOrder: { status: 'pending', expectedArrivalDate: '2026-03-01T00:00:00.000Z', quantityLimit: 10 },
    });
    check(
        "product: preOrder.status 'pending' is rejected (model enum: accepting | closed | arrived)",
        badPreOrderStatus.status === 400,
        `status=${badPreOrderStatus.status} message=${String(badPreOrderStatus.body.message)}`,
    );

    const badArrivalDate = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        availabilityMode: 'pre_order',
        preOrder: { expectedArrivalDate: 'garbage', quantityLimit: 10 },
    });
    check(
        'product: an unparseable preOrder.expectedArrivalDate is a clean 400',
        badArrivalDate.status === 400,
        `status=${badArrivalDate.status} message=${String(badArrivalDate.body.message)}`,
    );

    /* ── nested arrays ─────────────────────────────────────────────────────── */

    const emptyIngredientName = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        keyIngredients: [{ benefit: 'no name' }],
    });
    check(
        'product: a key ingredient row without a name is rejected',
        emptyIngredientName.status === 400,
        `status=${emptyIngredientName.status} message=${String(emptyIngredientName.body.message)}`,
    );

    const badCrossSellId = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        crossSellRecommendations: [{ productId: 'not-an-object-id' }],
    });
    checkValidationEnvelope(
        'product: non-ObjectId crossSellRecommendations.productId is rejected',
        badCrossSellId,
        VALIDATION_FAILURE_MESSAGE,
        'body.crossSellRecommendations',
    );

    const injectedCrossSellId = await postJson(`${url}/product/create`, {
        ...validProductCreate,
        crossSellRecommendations: [{ productId: { $ne: null } }],
    });
    checkValidationEnvelope(
        'product: operator crossSellRecommendations.productId is rejected',
        injectedCrossSellId,
        VALIDATION_FAILURE_MESSAGE,
        'body.crossSellRecommendations',
    );

    /* ── update: partial + the removed empty-string check ───────────────────── */

    const partialUpdate = await putJson(`${url}/product/update`, { stock: 5 });
    check(
        'product: update accepts a partial body ({ stock: 5 } alone)',
        partialUpdate.status === 200 && deepEqual(partialUpdate.body.body, { stock: 5 }),
        `status=${partialUpdate.status} body=${JSON.stringify(partialUpdate.body.body)}`,
    );

    const emptyTitleUpdate = await putJson(`${url}/product/update`, { title: '   ' });
    checkValidationEnvelope(
        'product: update with a blank title is rejected (replaces the old "cannot be empty" 400)',
        emptyTitleUpdate,
        VALIDATION_FAILURE_MESSAGE,
        'body.title',
    );

    /* ── PATCH pre-order arrival ────────────────────────────────────────────── */

    const arrival = await patchJson(`${url}/product/arrival`, { actualReceivedQuantity: 40 });
    check(
        'product arrival: valid payload passes and is normalised to a number',
        arrival.status === 200 &&
        (arrival.body.body as Record<string, unknown> | undefined)?.actualReceivedQuantity === 40,
        `status=${arrival.status} body=${JSON.stringify(arrival.body.body)}`,
    );

    const numericStringArrival = await patchJson(`${url}/product/arrival`, {
        actualReceivedQuantity: '40',
    });
    check(
        "product arrival: numeric string '40' is still coerced (numericField preserves the old Number())",
        numericStringArrival.status === 200 &&
        (numericStringArrival.body.body as Record<string, unknown> | undefined)?.actualReceivedQuantity === 40,
        `status=${numericStringArrival.status} body=${JSON.stringify(numericStringArrival.body.body)}`,
    );

    const missingArrival = await patchJson(`${url}/product/arrival`, {});
    checkValidationEnvelope(
        'product arrival: missing actualReceivedQuantity is rejected',
        missingArrival,
        VALIDATION_FAILURE_MESSAGE,
        'body.actualReceivedQuantity',
    );

    const negativeArrival = await patchJson(`${url}/product/arrival`, {
        actualReceivedQuantity: -1,
    });
    check(
        'product arrival: negative actualReceivedQuantity is rejected',
        negativeArrival.status === 400,
        `status=${negativeArrival.status} message=${String(negativeArrival.body.message)}`,
    );
};

/** Full announcement payload as the admin form sends it. */
const validAnnouncement = {
    enabled: true,
    messages: [{ text: 'Free delivery over 2000 taka', url: '/shop' }],
    animation: 'marquee',
    direction: 'rtl',
    background: 'sheen',
    backgroundColor: '#006400',
    textColor: '#FFEE32',
    intervalSeconds: 4,
    speedSeconds: 18,
};

const validCrossSell = {
    enabled: true,
    maximumRecommendations: 4,
    minimumRecommendedProductPrice: 0,
    maximumRecommendedProductPrice: 5000,
};

const validShipping = {
    zones: {
        inside_dhaka: { enabled: true, charge: 60, estimatedMinDays: 1, estimatedMaxDays: 2 },
        dhaka_suburban: { enabled: true, charge: 90, estimatedMinDays: 2, estimatedMaxDays: 3 },
        outside_dhaka: { enabled: true, charge: 130, estimatedMinDays: 3, estimatedMaxDays: 5 },
    },
    freeDeliveryThreshold: { enabled: true, minimumOrderValue: 2000 },
    addressRequirements: { landmarkRequired: false },
};

const checkSettingsSchemas = async (url: string): Promise<void> => {
    console.log('\n=== 4j. settings schemas (P0-3.12) ===');

    /* ── announcement ───────────────────────────────────────────────────────── */

    const announcement = await putJson(`${url}/settings/announcement`, validAnnouncement);
    check(
        'announcement: valid payload passes unchanged',
        announcement.status === 200 && deepEqual(announcement.body.body, validAnnouncement),
        `status=${announcement.status} body=${JSON.stringify(announcement.body.body)}`,
    );

    const announcementMass = await putJson(`${url}/settings/announcement`, {
        ...validAnnouncement,
        singletonKey: 'attacker_key',
        _id: '507f1f77bcf86cd799439011',
        id: '507f1f77bcf86cd799439012',
        __v: 3,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        updatedBy: '507f1f77bcf86cd799439013',
    });
    const announcementMassBody = JSON.stringify(announcementMass.body.body);
    check(
        'announcement: singletonKey/_id/id/__v/createdAt/updatedAt/updatedBy are stripped',
        announcementMass.status === 200 &&
        deepEqual(announcementMass.body.body, validAnnouncement) &&
        !announcementMassBody.includes('attacker_key') &&
        !announcementMassBody.includes('2020-01-01'),
        `status=${announcementMass.status} body=${announcementMassBody}`,
    );

    const announcementEnums: Array<[string, Record<string, unknown>]> = [
        ['animation', { animation: 'bounce' }],
        ['direction', { direction: 'ttb' }],
        ['background', { background: 'stripes' }],
    ];
    for (const [label, patch] of announcementEnums) {
        const response = await putJson(`${url}/settings/announcement`, {
            ...validAnnouncement,
            ...patch,
        });
        check(
            `announcement: ${label} bogus value is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const announcementColours: Array<[string, Record<string, unknown>]> = [
        ['backgroundColor red', { backgroundColor: 'red' }],
        ['backgroundColor #FFF (3 digit)', { backgroundColor: '#FFF' }],
        ['textColor rgb(...)', { textColor: 'rgb(0,0,0)' }],
    ];
    for (const [label, patch] of announcementColours) {
        const response = await putJson(`${url}/settings/announcement`, {
            ...validAnnouncement,
            ...patch,
        });
        check(
            `announcement: ${label} is rejected — colours go straight into storefront CSS`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const announcementRanges: Array<[string, Record<string, unknown>]> = [
        ['intervalSeconds 1', { intervalSeconds: 1 }],
        ['intervalSeconds 61', { intervalSeconds: 61 }],
        ['speedSeconds 5', { speedSeconds: 5 }],
        ['speedSeconds 61', { speedSeconds: 61 }],
    ];
    for (const [label, patch] of announcementRanges) {
        const response = await putJson(`${url}/settings/announcement`, {
            ...validAnnouncement,
            ...patch,
        });
        check(
            `announcement: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const blankMessage = await putJson(`${url}/settings/announcement`, {
        ...validAnnouncement,
        messages: [{ text: '', url: '' }],
    });
    check(
        'announcement: a blank message row is NOT a schema error (the service drops it)',
        blankMessage.status === 200,
        `status=${blankMessage.status} message=${String(blankMessage.body.message)}`,
    );

    const overlongMessage = await putJson(`${url}/settings/announcement`, {
        ...validAnnouncement,
        messages: [{ text: 'm'.repeat(221) }],
    });
    check(
        'announcement: a message above 220 characters is rejected',
        overlongMessage.status === 400,
        `status=${overlongMessage.status}`,
    );

    const partialAnnouncement = await putJson(`${url}/settings/announcement`, { enabled: false });
    check(
        'announcement: a partial payload is accepted (the service defaults the rest)',
        partialAnnouncement.status === 200 && deepEqual(partialAnnouncement.body.body, { enabled: false }),
        `status=${partialAnnouncement.status} body=${JSON.stringify(partialAnnouncement.body.body)}`,
    );

    /* ── cross-sell ─────────────────────────────────────────────────────────── */

    const crossSell = await putJson(`${url}/settings/cross-sell`, validCrossSell);
    check(
        'cross-sell: valid payload passes unchanged',
        crossSell.status === 200 && deepEqual(crossSell.body.body, validCrossSell),
        `status=${crossSell.status} body=${JSON.stringify(crossSell.body.body)}`,
    );

    const injectedMaximum = await putJson(`${url}/settings/cross-sell`, {
        ...validCrossSell,
        maximumRecommendations: { $ne: null },
    });
    checkValidationEnvelope(
        'cross-sell: operator maximumRecommendations is rejected (it becomes a query .limit())',
        injectedMaximum,
        VALIDATION_FAILURE_MESSAGE,
        'body.maximumRecommendations',
    );

    const crossSellNumerics: Array<[string, Record<string, unknown>]> = [
        ['maximumRecommendations 0', { maximumRecommendations: 0 }],
        ['maximumRecommendations 1.5', { maximumRecommendations: 1.5 }],
        ['minimumRecommendedProductPrice -1', { minimumRecommendedProductPrice: -1 }],
    ];
    for (const [label, patch] of crossSellNumerics) {
        const response = await putJson(`${url}/settings/cross-sell`, {
            ...validCrossSell,
            ...patch,
        });
        check(
            `cross-sell: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const nullMaximumPrice = await putJson(`${url}/settings/cross-sell`, {
        ...validCrossSell,
        maximumRecommendedProductPrice: null,
    });
    check(
        'cross-sell: maximumRecommendedProductPrice null is preserved (means "no upper limit")',
        nullMaximumPrice.status === 200 &&
        (nullMaximumPrice.body.body as Record<string, unknown> | undefined)?.maximumRecommendedProductPrice === null,
        `status=${nullMaximumPrice.status} body=${JSON.stringify(nullMaximumPrice.body.body)}`,
    );

    const stringEnabled = await putJson(`${url}/settings/cross-sell`, {
        ...validCrossSell,
        enabled: 'yes',
    });
    check(
        "cross-sell: enabled 'yes' is rejected — Boolean('yes') used to silently read as TRUE",
        stringEnabled.status === 400,
        `status=${stringEnabled.status} message=${String(stringEnabled.body.message)}`,
    );

    /* ── shipping ───────────────────────────────────────────────────────────── */

    const shipping = await putJson(`${url}/settings/shipping`, validShipping);
    check(
        'shipping: valid payload passes unchanged',
        shipping.status === 200 && deepEqual(shipping.body.body, validShipping),
        `status=${shipping.status} body=${JSON.stringify(shipping.body.body)}`,
    );

    const partialZone = await putJson(`${url}/settings/shipping`, {
        zones: { inside_dhaka: { charge: 99 } },
    });
    check(
        'shipping: a partial zone is accepted (the service merges each zone over its defaults)',
        partialZone.status === 200 &&
        deepEqual(partialZone.body.body, { zones: { inside_dhaka: { charge: 99 } } }),
        `status=${partialZone.status} body=${JSON.stringify(partialZone.body.body)}`,
    );

    const shippingNumerics: Array<[string, Record<string, unknown>]> = [
        ['inside_dhaka.charge -1', { zones: { inside_dhaka: { charge: -1 } } }],
        ['outside_dhaka.estimatedMinDays -1', { zones: { outside_dhaka: { estimatedMinDays: -1 } } }],
        ['freeDeliveryThreshold.minimumOrderValue -1', { freeDeliveryThreshold: { minimumOrderValue: -1 } }],
    ];
    for (const [label, patch] of shippingNumerics) {
        const response = await putJson(`${url}/settings/shipping`, { ...validShipping, ...patch });
        check(
            `shipping: ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }

    const unknownZone = await putJson(`${url}/settings/shipping`, {
        ...validShipping,
        zones: { ...validShipping.zones, bogus_zone: { charge: 0 } },
    });
    check(
        'shipping: an unknown delivery zone key is stripped (the zone set is fixed)',
        unknownZone.status === 200 &&
        !JSON.stringify(unknownZone.body.body).includes('bogus_zone'),
        `status=${unknownZone.status} body=${JSON.stringify(unknownZone.body.body)}`,
    );

    const stringLandmark = await putJson(`${url}/settings/shipping`, {
        ...validShipping,
        addressRequirements: { landmarkRequired: 'no' },
    });
    check(
        "shipping: landmarkRequired 'no' is rejected — Boolean('no') used to silently read as TRUE",
        stringLandmark.status === 400,
        `status=${stringLandmark.status} message=${String(stringLandmark.body.message)}`,
    );

    /* ── inventory settings ─────────────────────────────────────────────────── */

    const inventorySettings = await putJson(`${url}/settings/inventory`, {
        defaultLowStockThreshold: 5,
    });
    check(
        'inventory settings: valid payload passes unchanged',
        inventorySettings.status === 200 &&
        deepEqual(inventorySettings.body.body, { defaultLowStockThreshold: 5 }),
        `status=${inventorySettings.status} body=${JSON.stringify(inventorySettings.body.body)}`,
    );

    const coercedThreshold = await putJson(`${url}/settings/inventory`, {
        defaultLowStockThreshold: '7',
    });
    check(
        "inventory settings: numeric string '7' is still coerced (numericField preserves Number())",
        coercedThreshold.status === 200 &&
        (coercedThreshold.body.body as Record<string, unknown> | undefined)?.defaultLowStockThreshold === 7,
        `status=${coercedThreshold.status} body=${JSON.stringify(coercedThreshold.body.body)}`,
    );

    const missingThreshold = await putJson(`${url}/settings/inventory`, {});
    checkValidationEnvelope(
        'inventory settings: a missing defaultLowStockThreshold is rejected (it was already required by the service)',
        missingThreshold,
        VALIDATION_FAILURE_MESSAGE,
        'body.defaultLowStockThreshold',
    );

    const inventoryThresholdCases: Array<[string, unknown]> = [
        ['-1', -1],
        ['2.5', 2.5],
        ['"abc"', 'abc'],
    ];
    for (const [label, value] of inventoryThresholdCases) {
        const response = await putJson(`${url}/settings/inventory`, {
            defaultLowStockThreshold: value,
        });
        check(
            `inventory settings: defaultLowStockThreshold ${label} is rejected`,
            response.status === 400,
            `status=${response.status} message=${String(response.body.message)}`,
        );
    }
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
 * The four admin promotion mutations. Campaigns and coupons live on separate
 * routers, so `routerName` plus method+path is what disambiguates the POST '/' and
 * PUT '/:id' pairs.
 */
const PROMOTION_VALIDATED_ROUTES = [
    {
        routerName: 'adminCampaignRoutes',
        method: 'post',
        path: '/',
        controller: 'createCampaign',
        label: 'POST /api/admin/campaigns',
    },
    {
        routerName: 'adminCampaignRoutes',
        method: 'put',
        path: '/:id',
        controller: 'updateCampaign',
        label: 'PUT /api/admin/campaigns/:id',
    },
    {
        routerName: 'adminCouponRoutes',
        method: 'post',
        path: '/',
        controller: 'createCoupon',
        label: 'POST /api/admin/coupons',
    },
    {
        routerName: 'adminCouponRoutes',
        method: 'put',
        path: '/:id',
        controller: 'updateCoupon',
        label: 'PUT /api/admin/coupons/:id',
    },
].map((route) => ({ ...route, file: 'promotion/promotion.routes.ts', subject: 'promotion' }));

/**
 * The combo router is mixed (public GETs, admin mutations), so the guard and the
 * schema are per route. `validate()` sits AFTER `...adminGuard` on purpose: an
 * unauthenticated caller should get 401, not a 400 that leaks the body contract.
 */
const COMBO_VALIDATED_ROUTES = [
    {
        method: 'post',
        path: '/',
        controller: 'createCombo',
        label: 'POST /api/combos',
    },
    {
        method: 'put',
        path: '/:id',
        controller: 'updateCombo',
        label: 'PUT /api/combos/:id',
    },
].map((route) => ({ ...route, file: 'combo/combo.routes.ts', routerName: 'router', subject: 'combo' }));

/**
 * The three product mutations. The router is mixed (public GETs) so guard and
 * schema are per route, and `validate()` sits AFTER `...adminGuard`.
 * `PATCH /:id/pre-order/arrive` is included because the handler does read a body
 * (`actualReceivedQuantity`) — it is not a body-less action.
 */
const PRODUCT_VALIDATED_ROUTES = [
    {
        method: 'post',
        path: '/',
        controller: 'createProduct',
        label: 'POST /api/products',
    },
    {
        method: 'put',
        path: '/:id',
        controller: 'updateProduct',
        label: 'PUT /api/products/:id',
    },
    {
        method: 'patch',
        path: '/:id/pre-order/arrive',
        controller: 'markPreOrderArrived',
        label: 'PATCH /api/products/:id/pre-order/arrive',
    },
].map((route) => ({ ...route, file: 'product/product.routes.ts', routerName: 'router', subject: 'product' }));

/** The five settings singletons. Each is a PUT on its own admin router. */
const SETTINGS_VALIDATED_ROUTES = [
    {
        file: 'announcement/announcement.routes.ts',
        routerName: 'adminAnnouncementRoutes',
        method: 'put',
        path: '/',
        controller: 'updateAdminAnnouncementBar',
        label: 'PUT /api/admin/announcement',
    },
    {
        file: 'mega-menu/mega-menu.routes.ts',
        routerName: 'adminMegaMenuRoutes',
        method: 'put',
        path: '/',
        controller: 'updateAdminMegaMenu',
        label: 'PUT /api/admin/mega-menu',
    },
    {
        file: 'cross-sell/cross-sell.routes.ts',
        routerName: 'adminCrossSellSettingsRoutes',
        method: 'put',
        path: '/cross-sell',
        controller: 'updateAdminCrossSellSettings',
        label: 'PUT /api/admin/settings/cross-sell',
    },
    {
        file: 'shipping/shipping.routes.ts',
        routerName: 'adminShippingSettingsRoutes',
        method: 'put',
        path: '/shipping',
        controller: 'updateAdminShippingSettings',
        label: 'PUT /api/admin/settings/shipping',
    },
    {
        file: 'inventory/inventory.routes.ts',
        routerName: 'adminInventorySettingsRoutes',
        method: 'put',
        path: '/inventory',
        controller: 'updateAdminInventorySettings',
        label: 'PUT /api/admin/settings/inventory',
    },
].map((route) => ({ ...route, subject: 'settings' }));

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

    for (const spec of PROMOTION_VALIDATED_ROUTES) {
        assertValidateBeforeController(spec);
    }

    for (const spec of COMBO_VALIDATED_ROUTES) {
        assertValidateBeforeController(spec);
    }

    for (const spec of PRODUCT_VALIDATED_ROUTES) {
        assertValidateBeforeController(spec);
    }

    for (const spec of SETTINGS_VALIDATED_ROUTES) {
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
        await checkPromotionSchemas(url);
        await checkComboSchemas(url);
        await checkProductSchemas(url);
        await checkSettingsSchemas(url);
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
