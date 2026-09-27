import { NextFunction, Request, RequestHandler, Response } from 'express';
import { replaceRequestPart } from './request-part';

/**
 * Mongo treats a key as an operator when it starts with `$`, and dotted keys are
 * read as paths into nested documents. Neither is legitimate in client input.
 */
const isOperatorKey = (key: string): boolean => key.startsWith('$') || key.includes('.');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Maximum nesting depth that is walked. Anything deeper is dropped rather than
 * passed through, so an operator cannot hide below the cap.
 *
 * The cap exists because this walk is recursive: `JSON.parse` will happily build
 * a deeply nested object, and unwinding it recursively could exhaust the call
 * stack (a 500, and a cheap denial of service). `express.json()` accepts 100 KB
 * by default, which is room for tens of thousands of nesting levels — orders of
 * magnitude past any legitimate payload, which are 3-4 levels deep.
 */
export const MAX_STRIP_DEPTH = 20;

/** Sentinel for "this value was dropped because it exceeded MAX_STRIP_DEPTH". */
const REMOVED_OVER_DEPTH = Symbol('removed-over-depth');

const isRemoved = (value: unknown): value is typeof REMOVED_OVER_DEPTH =>
    value === REMOVED_OVER_DEPTH;

const walk = (current: unknown, depth: number): unknown => {
    const isContainer = Array.isArray(current) || isPlainObject(current);

    // Primitives cannot nest, so they are always kept. Only containers are
    // dropped past the cap, which is what actually bounds the recursion — and
    // checking the cap first would silently empty the leaves of a container
    // sitting exactly at the limit (caught by the boundary test).
    if (!isContainer) {
        return current;
    }

    if (depth > MAX_STRIP_DEPTH) {
        return REMOVED_OVER_DEPTH;
    }

    if (Array.isArray(current)) {
        const entries: unknown[] = [];

        for (const entry of current) {
            const cleanedEntry = walk(entry, depth + 1);

            if (!isRemoved(cleanedEntry)) {
                entries.push(cleanedEntry);
            }
        }

        return entries;
    }

    if (!isPlainObject(current)) {
        return current;
    }

    const cleaned: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(current)) {
        if (isOperatorKey(key)) {
            continue;
        }

        const cleanedEntry = walk(entry, depth + 1);

        if (!isRemoved(cleanedEntry)) {
            cleaned[key] = cleanedEntry;
        }
    }

    return cleaned;
};

/**
 * Recursively rebuilds `value`, dropping every operator-shaped key.
 *
 * Returns a new structure instead of mutating the input, and leaves every other
 * value — including legitimate nested objects and arrays — untouched.
 */
export const stripMongoOperatorsFrom = (value: unknown): unknown => walk(value, 0);

/**
 * Defence-in-depth against NoSQL operator injection.
 *
 * The Zod schemas are the primary control — they drop unknown keys outright —
 * but this runs globally before any route, so `$`-prefixed or dotted keys never
 * reach Mongoose even on a route that has no schema yet.
 *
 * Mounted immediately after `express.json()`, which means:
 *  - it only sees JSON-parsed bodies. Multipart bodies are populated later by
 *    multer, so those are covered by their route's schema instead;
 *  - it replaces `req.query` / `req.params` wholesale, which is safe because
 *    server-built Mongoose filters are never sourced from these objects.
 */
export const stripMongoOperators: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction
): void => {
    if (req.body !== undefined) {
        replaceRequestPart(req, 'body', stripMongoOperatorsFrom(req.body));
    }

    replaceRequestPart(req, 'query', stripMongoOperatorsFrom(req.query));
    replaceRequestPart(req, 'params', stripMongoOperatorsFrom(req.params));

    next();
};
