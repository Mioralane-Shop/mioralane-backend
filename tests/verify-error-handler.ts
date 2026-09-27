/**
 * P0-4 — global error handler verification.
 *
 * Run with: npm run verify:error-handler
 *
 * Proves the two terminal middlewares in `src/middleware/error.middleware.ts`
 * hold the contract every earlier P0 block assumed:
 *
 *   1. Every failure is answered with `{ success: false, message }` — never
 *      Express's default HTML page, never a bare stack.
 *   2. The status is *decided*, not inherited: a `CastError` is a 400 even
 *      though nothing in the request lifecycle produced a 4xx, a CORS refusal
 *      is a 403 rather than the 500 it used to be, and an unmapped error is a
 *      500 rather than whatever `err.status` happened to be.
 *   3. No internal shape reaches the client. The probes below throw errors whose
 *      messages really do contain a schema path, a collection name, a parser
 *      offset and a source path, then assert the response body contains none of
 *      them. Asserting only that the status is right would pass even if the body
 *      printed the stack.
 *
 * Two kinds of probe are used deliberately:
 *
 *   - Runtime probes drive a real Express app over HTTP with `fetch`, so the
 *     checks cover Express's own forwarding behaviour (a synchronous throw, a
 *     rejected promise, an async router-level handler) rather than the mapping
 *     table in isolation.
 *   - Static probes parse `src/app.module.ts`, because mount *order* is load
 *     bearing and cannot be observed from a request: a route registered after
 *     the terminal pair would be unreachable, which no response can reveal.
 *
 * Discrimination: the unmapped-error probe must stay a 500. If a future change
 * made every status a 400, the CastError checks would still pass — this one
 * would not. That is what keeps the success cases from being vacuous.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import { getAllowedOrigins } from '../src/config/allowed-origins';
import {
    CORS_DENIED_MESSAGE,
    CorsOriginDeniedError,
    INVALID_ID_MESSAGE,
    INTERNAL_ERROR_MESSAGE,
    NOT_FOUND_MESSAGE,
    REQUEST_ID_HEADER,
    describeCastError,
    errorHandler,
    notFoundHandler,
    requestId,
    sanitizeErrorMessage,
    sanitizeValidationMessages,
    statusMessageFor,
} from '../src/middleware/error.middleware';

const SRC_DIR = join(__dirname, '..', 'src');
const APP_MODULE_FILE = join(SRC_DIR, 'app.module.ts');
const ERROR_MIDDLEWARE_FILE = join(SRC_DIR, 'middleware', 'error.middleware.ts');

const PROBE_SECRET = 'probe-secret-not-a-real-key';
const UPLOAD_LIMIT_BYTES = 256;

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

/* ────────────────────────────── probes ────────────────────────────── */

const probeSchema = new mongoose.Schema({
    title: { type: String, required: true },
    // Custom message: must survive sanitisation, unlike the built-in
    // "Path `title` is required." the sibling field produces.
    price: { type: Number, min: [0, 'Price cannot be negative'] },
});

const ProbeModel = mongoose.model('ErrorHandlerProbe', probeSchema);

/** A real Mongoose `ValidationError`, built without a database connection. */
const buildValidationError = async (): Promise<unknown> => {
    try {
        await new ProbeModel({ price: -5 }).validate();
        return null;
    } catch (error) {
        return error;
    }
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMIT_BYTES },
});

const buildProbeApp = (): Express => {
    const app = express();

    app.use(requestId);
    app.use(express.json());

    app.get('/probe/cast-id', () => {
        throw new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
    });

    app.get('/probe/cast-price', () => {
        throw new mongoose.Error.CastError('Number', 'abc', 'price');
    });

    app.get('/probe/cast-stock', () => {
        throw new mongoose.Error.CastError('Number', 'abc', 'stock');
    });

    app.get('/probe/validation', async () => {
        const document = new ProbeModel({ price: -5 });
        await document.validate();
    });

    app.get('/probe/duplicate', () => {
        throw Object.assign(
            new Error(
                'E11000 duplicate key error collection: mioralane.users index: email_1 dup key: { email: "a@b.c" }'
            ),
            { code: 11000 }
        );
    });

    app.get('/probe/jwt-invalid', () => {
        throw new jwt.JsonWebTokenError('invalid signature');
    });

    app.get('/probe/jwt-expired', () => {
        const expired = jwt.sign({ id: 'probe' }, PROBE_SECRET, { expiresIn: '-1s' });
        jwt.verify(expired, PROBE_SECRET);
    });

    // Carries a status we trust *and* a message we must not: the status must
    // survive while the message is replaced.
    app.get('/probe/status-with-leak', () => {
        throw Object.assign(
            new Error('Cast to ObjectId failed for value "x" at path "couponId"'),
            { statusCode: 409 }
        );
    });

    app.get('/probe/status-plain', () => {
        throw Object.assign(new Error('Delivery is unavailable for the selected address'), {
            statusCode: 400,
        });
    });

    app.get('/probe/unknown', () => {
        throw new Error('kaboom at /srv/app/src/secret.ts:42 (node_modules leaked)');
    });

    // Not an Error instance at all — the handler must not assume otherwise.
    app.get('/probe/throw-string', () => {
        throw 'a bare string';
    });

    const uploadHandler: RequestHandler = (_req, res) => {
        res.json({ success: true });
    };

    app.post('/probe/upload', upload.single('file'), uploadHandler);

    app.get('/probe/ok', (_req, res) => {
        res.json({ success: true });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

/** Reproduces the exact CORS configuration `createApp()` mounts. */
const buildCorsApp = (): Express => {
    const app = express();

    app.use(requestId);
    app.use(
        cors({
            origin: (origin, callback) => {
                if (!origin) {
                    callback(null, true);
                    return;
                }

                if (getAllowedOrigins().includes(origin)) {
                    callback(null, true);
                    return;
                }

                callback(new CorsOriginDeniedError(origin));
            },
            credentials: true,
        })
    );

    app.get('/probe/ok', (_req, res) => {
        res.json({ success: true });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
};

/* ──────────────────────────── http helpers ──────────────────────────── */

type ProbeResponse = {
    status: number;
    body: unknown;
    text: string;
    headers: Headers;
};

const listen = async (app: Express): Promise<Server> =>
    new Promise<Server>((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });

const portOf = (server: Server): number => {
    const address = server.address();

    return address !== null && typeof address === 'object' ? address.port : 0;
};

const call = async (
    port: number,
    path: string,
    init?: RequestInit
): Promise<ProbeResponse> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(5000),
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

const envelopeOf = (body: unknown): { success?: unknown; message?: unknown; errors?: unknown } =>
    typeof body === 'object' && body !== null
        ? (body as { success?: unknown; message?: unknown; errors?: unknown })
        : {};

/** True when the body is exactly `{ success: false, message }` — no extra keys. */
const isExactEnvelope = (body: unknown, message: string): boolean => {
    const envelope = envelopeOf(body);

    return (
        envelope.success === false &&
        envelope.message === message &&
        Object.keys(envelope).length === 2
    );
};

const hasNoInternalShape = (text: string): boolean =>
    !/Cast to |at path |Path `|E11000|MongoServerError|mioralane\.users|at \w+ \(|node_modules|\/srv\/|\.ts:\d+/i.test(
        text
    );

/**
 * Strips comment-ONLY lines so structural assertions see code, not prose.
 *
 * Necessary, not cosmetic: `error.middleware.ts` documents the behaviour it
 * replaces, so its own comments quote `err.stack` and the retired
 * `CORS origin denied: <origin>` message. A text check that a comment can
 * satisfy — in either direction — proves nothing.
 *
 * Line-based on purpose. A character-level stripper would have to understand
 * template literals and regex literals, and this module contains a regex
 * containing a backtick (`/Path \`/`), which a naive stripper mis-reads and
 * mangles the remainder of the file.
 *
 * Limitation: a trailing comment on a code line is not stripped. No assertion
 * below depends on such a line.
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

/* ───────────────────────────── checks ───────────────────────────── */

const main = async (): Promise<void> => {
    const app = buildProbeApp();
    const server = await listen(app);
    const port = portOf(server);

    try {
        /* ── 1. Unmatched route ─────────────────────────────────────────── */
        section('A. Unmatched route (notFoundHandler)');

        const missing = await call(port, '/definitely/not/a/route');

        check(
            'unmatched GET -> 404',
            missing.status === 404,
            `status ${missing.status}`
        );
        check(
            "unmatched GET -> exactly { success:false, message:'Not found' }",
            isExactEnvelope(missing.body, NOT_FOUND_MESSAGE),
            JSON.stringify(missing.body)
        );
        check(
            'unmatched GET is JSON, not the default HTML page',
            !missing.text.includes('<html') && !missing.text.includes('<!DOCTYPE'),
            missing.text.slice(0, 40)
        );

        // Method mismatch on an existing path must also land on the 404 handler.
        const wrongMethod = await call(port, '/probe/cast-id', { method: 'DELETE' });

        check(
            'unmatched method on an existing path -> 404',
            wrongMethod.status === 404,
            `status ${wrongMethod.status}`
        );
        check(
            'unmatched method -> same envelope',
            isExactEnvelope(wrongMethod.body, NOT_FOUND_MESSAGE),
            JSON.stringify(wrongMethod.body)
        );

        /* ── 2. Correlation id ──────────────────────────────────────────── */
        section('B. X-Request-Id correlation');

        check(
            'error response carries X-Request-Id',
            typeof missing.headers.get(REQUEST_ID_HEADER) === 'string' &&
                (missing.headers.get(REQUEST_ID_HEADER) ?? '').length > 0,
            String(missing.headers.get(REQUEST_ID_HEADER))
        );

        const ok = await call(port, '/probe/ok');

        check(
            'success response carries X-Request-Id',
            typeof ok.headers.get(REQUEST_ID_HEADER) === 'string' &&
                (ok.headers.get(REQUEST_ID_HEADER) ?? '').length > 0,
            String(ok.headers.get(REQUEST_ID_HEADER))
        );

        const inboundId = 'probe-request-id-0001';
        const echoed = await call(port, '/probe/ok', {
            headers: { 'X-Request-Id': inboundId },
        });

        check(
            'well-formed inbound X-Request-Id is echoed (traceable end to end)',
            echoed.headers.get(REQUEST_ID_HEADER) === inboundId,
            String(echoed.headers.get(REQUEST_ID_HEADER))
        );

        // Negative control for the allowlist: a short/injection-shaped inbound id
        // must be discarded, not echoed back into the response or the log line.
        const rejectedId = 'x';
        const notEchoed = await call(port, '/probe/ok', {
            headers: { 'X-Request-Id': rejectedId },
        });

        check(
            'malformed inbound X-Request-Id is replaced, never echoed',
            notEchoed.headers.get(REQUEST_ID_HEADER) !== rejectedId &&
                (notEchoed.headers.get(REQUEST_ID_HEADER) ?? '').length >= 8,
            String(notEchoed.headers.get(REQUEST_ID_HEADER))
        );

        /* ── 3. CastError ───────────────────────────────────────────────── */
        section('C. Mongoose CastError -> 400');

        const castId = await call(port, '/probe/cast-id');

        check('CastError on _id -> 400', castId.status === 400, `status ${castId.status}`);
        check(
            'CastError on _id -> message',
            envelopeOf(castId.body).message === INVALID_ID_MESSAGE,
            JSON.stringify(castId.body)
        );
        check(
            'CastError on _id -> no schema path, no cast text, no value',
            hasNoInternalShape(castId.text) &&
                !castId.text.includes('_id') &&
                !castId.text.includes('not-an-id'),
            castId.text.slice(0, 120)
        );

        const castPrice = await call(port, '/probe/cast-price');

        check('CastError on a non-id path -> 400', castPrice.status === 400, `status ${castPrice.status}`);
        check(
            'CastError on a non-id path -> generic wording, not "Invalid id format"',
            envelopeOf(castPrice.body).message === 'Invalid value format',
            JSON.stringify(castPrice.body)
        );
        check(
            'CastError on a non-id path -> no field name leaked',
            !castPrice.text.includes('price') && hasNoInternalShape(castPrice.text),
            castPrice.text.slice(0, 120)
        );

        const castStock = await call(port, '/probe/cast-stock');

        check('CastError on stock -> 400', castStock.status === 400, `status ${castStock.status}`);
        check(
            'CastError on stock keeps its existing wording',
            envelopeOf(castStock.body).message === 'Stock must be a non-negative integer',
            JSON.stringify(castStock.body)
        );
        check(
            'CastError on stock leaks nothing',
            !castStock.text.includes('stock') && hasNoInternalShape(castStock.text),
            castStock.text.slice(0, 120)
        );

        /* ── 4. ValidationError ─────────────────────────────────────────── */
        section('D. Mongoose ValidationError -> 400 with errors[]');

        const validation = await call(port, '/probe/validation');
        const validationEnvelope = envelopeOf(validation.body);
        const validationIssues = Array.isArray(validationEnvelope.errors)
            ? (validationEnvelope.errors as Array<{ path?: unknown; message?: unknown }>)
            : [];

        check('ValidationError -> 400', validation.status === 400, `status ${validation.status}`);
        check(
            "ValidationError -> message 'Validation failed'",
            validationEnvelope.message === 'Validation failed',
            String(validationEnvelope.message)
        );
        check(
            'ValidationError -> errors[] carries one entry per invalid field',
            validationIssues.length === 2,
            JSON.stringify(validationEnvelope.errors)
        );
        check(
            'ValidationError -> paths are present (the client needs them)',
            validationIssues.some((issue) => issue.path === 'title') &&
                validationIssues.some((issue) => issue.path === 'price'),
            JSON.stringify(validationIssues.map((issue) => issue.path))
        );
        check(
            'ValidationError -> built-in "required" text is replaced',
            validationIssues.some(
                (issue) => issue.path === 'title' && issue.message === 'This field is required.'
            ) && !validation.text.includes('Path `title`'),
            JSON.stringify(validationIssues)
        );
        check(
            'ValidationError -> our own validator message is preserved',
            validationIssues.some((issue) => issue.message === 'Price cannot be negative'),
            JSON.stringify(validationIssues)
        );
        check(
            'ValidationError -> no internal shape in body',
            hasNoInternalShape(validation.text),
            validation.text.slice(0, 160)
        );

        /* ── 5. Driver / auth / upload / parser ─────────────────────────── */
        section('E. Duplicate key, JWT, Multer, body-parser');

        const duplicate = await call(port, '/probe/duplicate');

        check('duplicate key -> 409', duplicate.status === 409, `status ${duplicate.status}`);
        check(
            "duplicate key -> message 'Duplicate entry'",
            envelopeOf(duplicate.body).message === 'Duplicate entry',
            JSON.stringify(duplicate.body)
        );
        check(
            'duplicate key -> collection name and index not leaked',
            hasNoInternalShape(duplicate.text),
            duplicate.text.slice(0, 160)
        );

        const jwtInvalid = await call(port, '/probe/jwt-invalid');

        check('JsonWebTokenError -> 401', jwtInvalid.status === 401, `status ${jwtInvalid.status}`);
        check(
            "JsonWebTokenError -> message 'Invalid token'",
            envelopeOf(jwtInvalid.body).message === 'Invalid token',
            JSON.stringify(jwtInvalid.body)
        );

        const jwtExpired = await call(port, '/probe/jwt-expired');

        check('TokenExpiredError -> 401', jwtExpired.status === 401, `status ${jwtExpired.status}`);
        // TokenExpiredError extends JsonWebTokenError: if the order in `classify`
        // regresses, this is the check that catches it.
        check(
            "TokenExpiredError -> 'Token expired', not 'Invalid token'",
            envelopeOf(jwtExpired.body).message === 'Token expired',
            JSON.stringify(jwtExpired.body)
        );

        const smallUpload = new FormData();
        smallUpload.append('file', new Blob([new Uint8Array(64)]), 'small.bin');

        const accepted = await call(port, '/probe/upload', {
            method: 'POST',
            body: smallUpload,
        });

        // Discrimination for the size check below: an in-limit upload must pass.
        check(
            'in-limit upload -> 200 (the 413 below is about size, not a blanket reject)',
            accepted.status === 200,
            `status ${accepted.status}`
        );

        const bigUpload = new FormData();
        bigUpload.append('file', new Blob([new Uint8Array(4096)]), 'big.bin');

        const oversized = await call(port, '/probe/upload', {
            method: 'POST',
            body: bigUpload,
        });

        check(
            'MulterError LIMIT_FILE_SIZE -> 413',
            oversized.status === 413,
            `status ${oversized.status} ${oversized.text.slice(0, 80)}`
        );
        check(
            "oversized upload -> message 'File too large'",
            envelopeOf(oversized.body).message === 'File too large',
            JSON.stringify(oversized.body)
        );
        check(
            'oversized upload -> no internal shape',
            hasNoInternalShape(oversized.text),
            oversized.text.slice(0, 120)
        );

        const badJson = await call(port, '/probe/unknown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{ "broken": ',
        });

        check('malformed JSON -> 400', badJson.status === 400, `status ${badJson.status}`);
        check(
            "malformed JSON -> message 'Invalid JSON body'",
            envelopeOf(badJson.body).message === 'Invalid JSON body',
            JSON.stringify(badJson.body)
        );
        // body-parser marks its error `expose: true`, so this text would reach a
        // client through the default handler.
        check(
            'malformed JSON -> parser internals not leaked',
            !/Unexpected|position|token/i.test(badJson.text),
            badJson.text.slice(0, 160)
        );

        const tooLarge = await call(port, '/probe/unknown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blob: 'x'.repeat(200_000) }),
        });

        check(
            'body over the parser limit -> 413 (status trusted, message replaced)',
            tooLarge.status === 413 && envelopeOf(tooLarge.body).message === 'Payload too large',
            `status ${tooLarge.status} ${tooLarge.text.slice(0, 80)}`
        );

        /* ── 6. Status-bearing and unmapped errors ──────────────────────── */
        section('F. statusCode errors and the unmapped fallback');

        const statusWithLeak = await call(port, '/probe/status-with-leak');

        check(
            'statusCode is honoured (409 survives)',
            statusWithLeak.status === 409,
            `status ${statusWithLeak.status}`
        );
        check(
            'statusCode error -> message replaced, not echoed',
            envelopeOf(statusWithLeak.body).message === 'Conflict' &&
                hasNoInternalShape(statusWithLeak.text),
            statusWithLeak.text.slice(0, 160)
        );

        const statusPlain = await call(port, '/probe/status-plain');

        check(
            'plain statusCode error -> canned wording for that status',
            statusPlain.status === 400 && envelopeOf(statusPlain.body).message === 'Bad request',
            JSON.stringify(statusPlain.body)
        );

        const unknown = await call(port, '/probe/unknown');

        check(
            'unmapped error -> 500',
            unknown.status === 500,
            `status ${unknown.status}`
        );
        check(
            "unmapped error -> exactly { success:false, message:'Internal server error' }",
            isExactEnvelope(unknown.body, INTERNAL_ERROR_MESSAGE),
            JSON.stringify(unknown.body)
        );
        check(
            'unmapped error -> no message, stack, source path or dependency path',
            hasNoInternalShape(unknown.text) && !unknown.text.includes('kaboom'),
            unknown.text.slice(0, 160)
        );
        check(
            'unmapped error -> no stack frames',
            !/\bat [A-Za-z_$][\w$.]* \(/.test(unknown.text) && !unknown.text.includes('\n    at '),
            unknown.text.slice(0, 160)
        );

        const bare = await call(port, '/probe/throw-string');

        check(
            'a non-Error throw still yields the 500 envelope',
            bare.status === 500 && isExactEnvelope(bare.body, INTERNAL_ERROR_MESSAGE),
            `${bare.status} ${bare.text.slice(0, 80)}`
        );

        /* ── 7. CORS denial ─────────────────────────────────────────────── */
        section('G. CORS denial -> 403 (was 500)');

        const corsApp = buildCorsApp();
        const corsServer = await listen(corsApp);
        const corsPort = portOf(corsServer);

        try {
            const denied = await call(corsPort, '/probe/ok', {
                headers: { Origin: 'https://evil.example' },
            });

            check(
                'denied origin -> 403, not 500',
                denied.status === 403,
                `status ${denied.status}`
            );
            check(
                'denied origin -> envelope message',
                isExactEnvelope(denied.body, CORS_DENIED_MESSAGE),
                JSON.stringify(denied.body)
            );
            // The pre-P0-4 code built `CORS origin denied: <origin>` and that
            // string was what reached the client.
            check(
                'denied origin -> the rejected origin is not echoed',
                !denied.text.includes('evil.example') && hasNoInternalShape(denied.text),
                denied.text.slice(0, 160)
            );

            const allowed = await call(corsPort, '/probe/ok', {
                headers: { Origin: 'http://localhost:3000' },
            });

            // Discrimination: a blanket 403 would also pass the check above.
            check(
                'allowlisted origin still succeeds',
                allowed.status === 200,
                `status ${allowed.status}`
            );
            check(
                'allowlisted origin gets the CORS credentials header',
                allowed.headers.get('access-control-allow-origin') === 'http://localhost:3000',
                String(allowed.headers.get('access-control-allow-origin'))
            );

            const noOrigin = await call(corsPort, '/probe/ok');

            check(
                'no Origin header (curl, server-to-server) still succeeds',
                noOrigin.status === 200,
                `status ${noOrigin.status}`
            );
        } finally {
            corsServer.close();
        }

        /* ── 8. Exported helpers ────────────────────────────────────────── */
        section('H. Sanitiser helpers');

        check(
            'describeCastError: id path -> id wording',
            describeCastError(new mongoose.Error.CastError('ObjectId', 'x', 'itemId')) ===
                INVALID_ID_MESSAGE
        );
        check(
            'describeCastError: _id -> id wording',
            describeCastError(new mongoose.Error.CastError('ObjectId', 'x', '_id')) ===
                INVALID_ID_MESSAGE
        );
        check(
            'describeCastError: numeric path -> value wording',
            describeCastError(new mongoose.Error.CastError('Number', 'x', 'price')) ===
                'Invalid value format'
        );
        check(
            'describeCastError output never contains the offending value or "at path"',
            !describeCastError(new mongoose.Error.CastError('ObjectId', 'leaky-value', '_id')).includes(
                'leaky-value'
            ) &&
                !describeCastError(
                    new mongoose.Error.CastError('ObjectId', 'leaky-value', '_id')
                ).includes('at path')
        );

        check(
            'sanitizeErrorMessage: business message preserved',
            sanitizeErrorMessage(
                new Error('Delivery is unavailable for the selected address'),
                'fallback'
            ) === 'Delivery is unavailable for the selected address'
        );
        check(
            'sanitizeErrorMessage: CastError -> fallback',
            sanitizeErrorMessage(
                new mongoose.Error.CastError('ObjectId', 'x', '_id'),
                'fallback'
            ) === 'fallback'
        );
        check(
            'sanitizeErrorMessage: cast text without the class -> fallback',
            sanitizeErrorMessage(
                new Error('Cast to ObjectId failed for value "x" at path "_id"'),
                'fallback'
            ) === 'fallback'
        );
        check(
            'sanitizeErrorMessage: driver duplicate-key -> fallback',
            sanitizeErrorMessage(new Error('E11000 duplicate key error collection: db'), 'fallback') ===
                'fallback'
        );
        check(
            'sanitizeErrorMessage: non-Error -> fallback',
            sanitizeErrorMessage('a bare string', 'fallback') === 'fallback' &&
                sanitizeErrorMessage(undefined, 'fallback') === 'fallback'
        );
        check(
            'sanitizeErrorMessage: blank message -> fallback',
            sanitizeErrorMessage(new Error('   '), 'fallback') === 'fallback'
        );
        check(
            'sanitizeErrorMessage: socket-level failure -> fallback',
            sanitizeErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:27017'), 'fallback') ===
                'fallback'
        );

        const validationError = await buildValidationError();
        const validationMessages = sanitizeValidationMessages(validationError);

        check(
            'sanitizeValidationMessages returns one string per field',
            validationMessages.length === 2,
            JSON.stringify(validationMessages)
        );
        check(
            'sanitizeValidationMessages drops the built-in Path `x` text',
            validationMessages.includes('This field is required.') &&
                !validationMessages.some((message) => message.includes('Path `')),
            JSON.stringify(validationMessages)
        );
        check(
            'sanitizeValidationMessages keeps the custom validator message',
            validationMessages.includes('Price cannot be negative'),
            JSON.stringify(validationMessages)
        );

        check(
            'statusMessageFor returns a non-empty message for every 4xx/5xx',
            [400, 401, 403, 404, 409, 413, 429, 500, 503, 599].every(
                (status) => statusMessageFor(status).length > 0
            )
        );
        check(
            'statusMessageFor never falls back to a raw message (unmapped status -> canned)',
            statusMessageFor(451) === 'Bad request' && statusMessageFor(507) === INTERNAL_ERROR_MESSAGE,
            `${statusMessageFor(451)} / ${statusMessageFor(507)}`
        );

        /* ── 9. Wiring in app.module.ts ─────────────────────────────────── */
        section('I. Mount order in app.module.ts');

        const appModule = stripCommentLines(readFileSync(APP_MODULE_FILE, 'utf8'));
        const errorMiddleware = stripCommentLines(readFileSync(ERROR_MIDDLEWARE_FILE, 'utf8'));

        const requestIdIndex = appModule.indexOf('app.use(requestId)');
        const corsIndex = appModule.indexOf('cors({');
        const notFoundIndex = appModule.indexOf('app.use(notFoundHandler)');
        const errorHandlerIndex = appModule.indexOf('app.use(errorHandler)');

        check(
            'requestId is mounted (found)',
            requestIdIndex !== -1,
            'app.use(requestId) missing'
        );
        check(
            'requestId is mounted before CORS (a denied request still gets an id)',
            requestIdIndex !== -1 && corsIndex !== -1 && requestIdIndex < corsIndex,
            `requestId@${requestIdIndex} cors@${corsIndex}`
        );
        check(
            'notFoundHandler and errorHandler are both mounted',
            notFoundIndex !== -1 && errorHandlerIndex !== -1,
            `notFound@${notFoundIndex} error@${errorHandlerIndex}`
        );
        check(
            'errorHandler is mounted after notFoundHandler',
            notFoundIndex !== -1 && errorHandlerIndex > notFoundIndex,
            `notFound@${notFoundIndex} error@${errorHandlerIndex}`
        );

        // Nothing that can respond may be registered after the terminal pair, or
        // it would be unreachable.
        const afterTerminal = appModule.slice(notFoundIndex + 'app.use(notFoundHandler)'.length);
        const routeAfterTerminal = /app\.(use|get|post|put|patch|delete)\('/.test(afterTerminal);

        check(
            'no route or middleware is registered after the terminal pair',
            notFoundIndex !== -1 && !routeAfterTerminal,
            'a registration follows notFoundHandler'
        );

        check(
            'CORS denial constructs the typed error, not a message-matching Error',
            appModule.includes('new CorsOriginDeniedError('),
            'CorsOriginDeniedError is not constructed in createApp()'
        );
        check(
            'the retired origin-bearing CORS message is gone from code',
            !/new Error\(\s*[`'"]CORS origin denied/.test(appModule),
            'a message-bearing CORS denial is still constructed'
        );
        check(
            'error middleware never touches a stack or writes a raw message',
            !/\.stack\b/.test(errorMiddleware) &&
                !/\.json\([^)]*error\.message/.test(errorMiddleware),
            'the error middleware references a stack or a raw message'
        );
    } finally {
        server.close();
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

    console.log('All error handler checks passed.');
};

void main();
