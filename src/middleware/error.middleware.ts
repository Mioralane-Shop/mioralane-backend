import { randomUUID } from 'node:crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';

/**
 * P0-4 — global error handler.
 *
 * Before this file the app had no terminal error middleware, so anything a
 * controller did not catch reached Express's *default* handler. That handler
 * answers with an HTML error page, chooses a status from `err.status`/
 * `err.statusCode` and — in non-production — prints the message. Two
 * consequences, both fixed here:
 *
 *   1. The `{ success, message }` envelope was not maintained, so a client
 *      parsing JSON saw HTML.
 *   2. Error text was decided by whatever object happened to be thrown. A
 *      Mongoose `CastError` quotes the offending value and the *schema path*
 *      (for example: `Cast to ObjectId failed for value "abc" at path "_id"`),
 *      which is internal shape the client must never learn. A `body-parser`
 *      `SyntaxError` is likewise marked `expose: true`, so the default handler
 *      forwarded the raw parser message.
 *
 * Every response produced by {@link errorHandler} and {@link notFoundHandler} is
 * `{ success: false, message }` plus, for schema validation failures,
 * `errors: [{ path, message }]`. No handler here ever puts `err.stack`,
 * `err.message` verbatim, a Mongo collection name or a Mongoose path into the
 * response body.
 *
 * Wording lives in constants and one status table so the mapping is auditable in
 * one place instead of being spread across ~30 controllers.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * Correlation id assigned by {@link requestId}.
             *
             * Required, not optional: `requestId` is mounted as the very first
             * middleware in `createApp()`, so any request that can reach a handler
             * or this error path already has one. Typing it optional would push a
             * `??` fallback into every consumer for a case that cannot occur in
             * the app.
             */
            id: string;
        }
    }
}

/** Response header carrying the correlation id. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Message used for any unmatched route. */
export const NOT_FOUND_MESSAGE = 'Not found';

/** Message used for a `CastError` on an id-shaped path. Deliberately names no field. */
export const INVALID_ID_MESSAGE = 'Invalid id format';

/** Message used for every unmapped failure. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/** Name/`instanceof` tag of {@link CorsOriginDeniedError}. */
export const CORS_DENIED_NAME = 'CorsOriginDeniedError';

/** Message used when the request came from an origin outside the allowlist. */
export const CORS_DENIED_MESSAGE = 'Origin not allowed';

/** Mongo's duplicate-key error code. */
const DUPLICATE_KEY_CODE = 11000;

/**
 * Accepts an inbound correlation id only if it is a short, boring token.
 *
 * Echoing an unvalidated header would let a caller inject newlines into the log
 * line and forge entries; requiring this shape also keeps ids short enough to be
 * useless as a log-flooding vector.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** One field-level failure, matching the shape `validate()` already returns. */
export type ErrorIssue = {
    path: string;
    message: string;
};

/** The only two shapes this module ever writes to a client. */
export type ErrorEnvelope = {
    success: false;
    message: string;
    errors?: ErrorIssue[];
};

/**
 * Error carrying the fact that CORS refused an origin.
 *
 * A dedicated class rather than a sentinel string: the CORS callback runs deep
 * inside the `cors` package, so matching on message text would silently stop
 * working the day the wording changes, and would also fire on any unrelated
 * error that happened to contain the same words.
 *
 * `origin` is kept as a *property*, never concatenated into `message`, so the
 * rejected origin reaches the server log but not the response body. (The old
 * implementation built the message as `CORS origin denied: <origin>`, and that
 * message was exactly what leaked.)
 */
export class CorsOriginDeniedError extends Error {
    public readonly origin: string | undefined;

    public constructor(origin?: string) {
        super(CORS_DENIED_MESSAGE);
        this.name = CORS_DENIED_NAME;
        this.origin = origin;
    }
}

/** Canonical wording per status, used for errors that carry a status we trust but a message we do not. */
const STATUS_MESSAGES: ReadonlyMap<number, string> = new Map([
    [400, 'Bad request'],
    [401, 'Not authorized'],
    [403, 'Forbidden'],
    [404, NOT_FOUND_MESSAGE],
    [405, 'Method not allowed'],
    [409, 'Conflict'],
    [413, 'Payload too large'],
    [415, 'Unsupported media type'],
    [422, 'Unprocessable entity'],
    [429, 'Too many requests'],
    [500, INTERNAL_ERROR_MESSAGE],
    [502, 'Bad gateway'],
    [503, 'Service unavailable'],
    [504, 'Gateway timeout'],
]);

/**
 * Returns the canned message for a status code.
 *
 * Never falls back to the thrown message: an unrecognised status means an
 * unrecognised error, and an unrecognised error is precisely the case where the
 * message must not be trusted.
 */
export const statusMessageFor = (status: number): string => {
    const known = STATUS_MESSAGES.get(status);

    if (known !== undefined) {
        return known;
    }

    return status >= 500 ? INTERNAL_ERROR_MESSAGE : 'Bad request';
};

/**
 * Substrings that only appear in messages leaking internals — Mongoose
 * validation text, cast failures, driver errors and socket-level failures.
 *
 * Matched case-sensitively where the casing is fixed by the library
 * (`Cast to`, `E11000`) and case-insensitively for host/socket errors, so a
 * legitimate business sentence containing e.g. "not found" is not mistaken for
 * one of these.
 */
const INTERNAL_MESSAGE_PATTERN =
    /Cast to |CastError| at path |Path `|MongoServerError|MongoError|MongooseError|E11000|Buffering timed out|ECONNREFUSED|ENOTFOUND|getaddrinfo/i;

/** Duck-typed view of an unknown thrown value. No `any`: every field stays `unknown`. */
type ErrorLike = {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    path?: unknown;
    type?: unknown;
    errors?: unknown;
    body?: unknown;
    origin?: unknown;
    kind?: unknown;
};

const asErrorLike = (value: unknown): ErrorLike =>
    typeof value === 'object' && value !== null ? (value as ErrorLike) : {};

const readString = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
};

const readPath = (error: unknown): string | null => readString(asErrorLike(error).path);

/** Reads an HTTP status from `statusCode` or `status`, accepting only a real 4xx/5xx code. */
const readStatus = (error: unknown): number | null => {
    const source = asErrorLike(error);
    const candidate = typeof source.statusCode === 'number' ? source.statusCode : source.status;

    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
        return null;
    }

    return candidate >= 400 && candidate <= 599 ? candidate : null;
};

const isMongooseFailure = (error: unknown): boolean => {
    if (
        error instanceof mongoose.Error.CastError ||
        error instanceof mongoose.Error.ValidationError
    ) {
        return true;
    }

    const name = asErrorLike(error).name;

    return name === 'CastError' || name === 'ValidationError' || name === 'MongoServerError';
};

const isCorsOriginDenied = (error: unknown): boolean =>
    error instanceof CorsOriginDeniedError || asErrorLike(error).name === CORS_DENIED_NAME;

/**
 * Decides the wording for a Mongoose `CastError`.
 *
 * The path is used to *classify* the failure and is never echoed — that is the
 * whole point. Id-shaped paths (`_id`, `id`, `itemId`, `productId`, …) get the
 * id wording; anything else (a numeric field such as `stock`) gets a generic
 * one, because answering `Invalid id format` for `{ "stock": "abc" }` would be
 * actively misleading. The `stock` case keeps the exact wording the product and
 * combo handlers already returned, so this consolidation changes no client-visible
 * string.
 */
export const describeCastError = (error: unknown): string => {
    const path = readPath(error);

    if (path === null) {
        return INVALID_ID_MESSAGE;
    }

    if (path === 'stock') {
        return 'Stock must be a non-negative integer';
    }

    return path === 'id' || path === '_id' || /[Ii]d$/.test(path)
        ? INVALID_ID_MESSAGE
        : 'Invalid value format';
};

/**
 * Returns a client-safe message for a caught error, or `fallback`.
 *
 * Controller catch blocks used to answer with `err.message` directly. For the
 * errors our own services author (a stock conflict, an unavailable delivery
 * zone) that text *is* the client contract and must survive. For anything
 * Mongoose or the driver produced it is internal shape and must not. This keeps
 * the former and replaces the latter, so the call sites stay one line and no
 * business wording changes.
 */
export const sanitizeErrorMessage = (error: unknown, fallback: string): string => {
    if (!(error instanceof Error)) {
        return fallback;
    }

    const message = readString(error.message);

    if (message === null) {
        return fallback;
    }

    if (isMongooseFailure(error) || INTERNAL_MESSAGE_PATTERN.test(message)) {
        return fallback;
    }

    return message;
};

/**
 * Replaces each Mongoose `ValidatorError` message with a field-safe one.
 *
 * Mongoose's built-in validators build their message from the schema
 * (`Path \`title\` is required.`), so passing `entry.message` through would
 * reintroduce the leak the rest of this file removes. Custom messages authored
 * in our schemas are kept, because those are written for the client.
 */
const sanitizeValidatorMessage = (entry: unknown): string => {
    const source = asErrorLike(entry);
    const kind = readString(source.kind);

    if (kind === 'required') {
        return 'This field is required.';
    }

    const message = readString(source.message);

    if (message !== null && !INTERNAL_MESSAGE_PATTERN.test(message)) {
        return message;
    }

    return 'Invalid value.';
};

/**
 * Sanitised messages for a Mongoose `ValidationError`, as a plain string list.
 *
 * Exists as a string list — rather than reusing the `errors: [{ path, message }]`
 * shape below — because the product and combo controllers already answer these
 * branches with `errors: string[]`, and changing that to objects would be a
 * response-shape change for live clients. This closes the wording leak while
 * leaving the shape exactly as it was.
 */
export const sanitizeValidationMessages = (error: unknown): string[] => {
    const raw = asErrorLike(error).errors;

    if (typeof raw !== 'object' || raw === null) {
        return [];
    }

    return Object.values(raw as Record<string, unknown>).map((entry) =>
        sanitizeValidatorMessage(entry)
    );
};

/** Field-level issues for a Mongoose `ValidationError`, matching `validate()`'s shape. */
const toValidationIssues = (error: unknown): ErrorIssue[] => {
    const raw = asErrorLike(error).errors;

    if (typeof raw !== 'object' || raw === null) {
        return [];
    }

    return Object.entries(raw as Record<string, unknown>).map(([path, entry]) => ({
        path,
        message: sanitizeValidatorMessage(entry),
    }));
};

/** `true` for a `body-parser` JSON parse failure (`entity.parse.failed`). */
const isJsonParseFailure = (error: unknown): boolean => {
    const type = readString(asErrorLike(error).type);

    if (type === 'entity.parse.failed') {
        return true;
    }

    // `body-parser` augments the original `SyntaxError` from `JSON.parse` and
    // attaches the raw body as `err.body`; both halves are needed, because a
    // `SyntaxError` from anywhere else is a bug in our code, not bad input.
    return error instanceof SyntaxError && 'body' in (error as object);
};

type ClassifiedError = {
    status: number;
    message: string;
    issues?: ErrorIssue[];
    /** Whether the full error (stack included) should reach the server log. */
    log: boolean;
};

/** Maps a thrown value to a status, a safe message and whether it is worth logging. */
const classify = (error: unknown): ClassifiedError => {
    if (isCorsOriginDenied(error)) {
        return { status: 403, message: CORS_DENIED_MESSAGE, log: true };
    }

    // `TokenExpiredError` extends `JsonWebTokenError`, so it must be tested first
    // or every expired token would be reported as merely invalid.
    if (error instanceof jwt.TokenExpiredError) {
        return { status: 401, message: 'Token expired', log: false };
    }

    if (error instanceof jwt.JsonWebTokenError) {
        return { status: 401, message: 'Invalid token', log: false };
    }

    if (asErrorLike(error).code === DUPLICATE_KEY_CODE) {
        return { status: 409, message: 'Duplicate entry', log: false };
    }

    if (error instanceof mongoose.Error.ValidationError || asErrorLike(error).name === 'ValidationError') {
        return {
            status: 400,
            message: 'Validation failed',
            issues: toValidationIssues(error),
            log: false,
        };
    }

    if (error instanceof mongoose.Error.CastError || asErrorLike(error).name === 'CastError') {
        return { status: 400, message: describeCastError(error), log: false };
    }

    // Before the status branch below: a `MulterError` carries no status of its
    // own, so this ordering is cosmetic, but the size case must stay ahead of the
    // generic upload case.
    if (error instanceof multer.MulterError) {
        return error.code === 'LIMIT_FILE_SIZE'
            ? { status: 413, message: 'File too large', log: false }
            : { status: 400, message: 'Invalid upload', log: false };
    }

    // Must precede the status branch: `body-parser` sets `status`/`statusCode` to
    // 400 on these, and the message it exposes quotes the payload.
    if (isJsonParseFailure(error)) {
        return { status: 400, message: 'Invalid JSON body', log: false };
    }

    // Errors our own code threw with an explicit status (see the local
    // `createHttpError` helpers in the order controllers). The status is trusted
    // because it is always a literal in our source; the message is not, so it is
    // replaced with the canned wording for that status.
    const status = readStatus(error);

    if (status !== null) {
        return { status, message: statusMessageFor(status), log: status >= 500 };
    }

    return { status: 500, message: INTERNAL_ERROR_MESSAGE, log: true };
};

/** Keeps the response body free of everything except the id, for the log line. */
const readOrigin = (error: unknown): string | null => readString(asErrorLike(error).origin);

/**
 * Assigns `req.id` and echoes it as `X-Request-Id`.
 *
 * Defined with `Object.defineProperty` for the same reason as
 * `request-part.ts`: plain assignment on an Express 5 request property is not
 * guaranteed to take, and a correlation id that silently fails to attach is
 * worse than none — the log line and the response header would disagree.
 */
export const requestId: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.headers['x-request-id'];
    const candidate = typeof inbound === 'string' ? inbound.trim() : '';
    const id = REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();

    Object.defineProperty(req, 'id', {
        value: id,
        writable: true,
        enumerable: true,
        configurable: true,
    });

    res.setHeader(REQUEST_ID_HEADER, id);
    next();
};

/** Returns the request id, generating and setting one if `requestId` never ran. */
const ensureRequestId = (req: Request, res: Response): string => {
    const existing = readString((req as Partial<Request>).id);

    if (existing !== null) {
        if (!res.hasHeader(REQUEST_ID_HEADER)) {
            res.setHeader(REQUEST_ID_HEADER, existing);
        }

        return existing;
    }

    const generated = randomUUID();

    if (!res.hasHeader(REQUEST_ID_HEADER)) {
        res.setHeader(REQUEST_ID_HEADER, generated);
    }

    return generated;
};

/**
 * Terminal middleware for unmatched routes.
 *
 * Mounted after every route. Without it an unknown path falls to the default
 * handler's HTML page, so a client parsing JSON breaks instead of reading a
 * clean 404.
 */
export const notFoundHandler: RequestHandler = (_req: Request, res: Response): void => {
    res.status(404).json({ success: false, message: NOT_FOUND_MESSAGE });
};

/**
 * Terminal error middleware.
 *
 * The four-argument signature is what makes Express treat this as an error
 * handler; `next` must stay declared even though it is only used on the
 * already-sent branch.
 *
 * Only the status, the canned message and (for validation) the field list reach
 * the client. The full error — stack included — goes to `console.error` together
 * with the request id, so a 500 in the logs can be tied back to the exact
 * response a user saw.
 */
export const errorHandler = (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    if (res.headersSent) {
        // The response is already streaming, so no envelope can be written.
        // Handing the error back to Express is the only remaining option; it
        // destroys the socket rather than leaving the client waiting.
        next(error);
        return;
    }

    const id = ensureRequestId(req, res);
    const { status, message, issues, log } = classify(error);

    if (log) {
        const origin = readOrigin(error);
        const suffix = origin !== null ? ` (origin: ${origin})` : '';
        // `originalUrl` minus the query string: enough to locate the handler
        // without writing query values into the log.
        console.error(
            `[error] ${id} ${req.method} ${req.originalUrl.split('?')[0]} -> ${status}${suffix}`,
            error
        );
    }

    const envelope: ErrorEnvelope = { success: false, message };

    if (issues !== undefined && issues.length > 0) {
        envelope.errors = issues;
    }

    res.status(status).json(envelope);
};
