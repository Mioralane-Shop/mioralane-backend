import type { Request } from 'express';

/** The request parts a schema or sanitiser can target. */
export type RequestPart = 'body' | 'query' | 'params';

/**
 * Replaces a request part with an already-parsed value.
 *
 * `Object.defineProperty` is required, not stylistic: Express 5 exposes
 * `req.query` as a prototype accessor, so a plain assignment is **silently
 * ignored** — the getter re-parses the URL on every read and the parsed value is
 * never observed. (`req.params` happens to be writable, and `req.body` is an own
 * data property, but all three go through this one path so the behaviour cannot
 * drift apart.)
 *
 * This was caught by `tests/verify-validation.ts`: an earlier assignment-based
 * implementation left `req.query` untouched while still returning 200.
 */
export const replaceRequestPart = (req: Request, part: RequestPart, value: unknown): void => {
    Object.defineProperty(req, part, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
    });
};
