import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, ZodType } from 'zod';
import { replaceRequestPart, type RequestPart } from './request-part';

/** Which part of the request a schema applies to. */
export type ValidationTarget = RequestPart;

/**
 * A single validation failure.
 *
 * `path` is prefixed with the target it came from (for example `body.email`) so
 * one response can describe body, query and params failures unambiguously.
 */
export type ValidationIssue = {
    path: string;
    message: string;
};

/** Options accepted by {@link validate}. Every schema is optional. */
export type ValidateOptions = {
    body?: ZodType;
    query?: ZodType;
    params?: ZodType;
    /**
     * Replaces the default `"Validation failed"` message.
     *
     * Exists so routes whose clients render `message` verbatim, and whose 400
     * wording is already part of their contract, can keep their exact wording
     * while still returning the standard envelope.
     */
    message?: string;
};

/** Default `message` used when a request fails validation. */
export const VALIDATION_FAILURE_MESSAGE = 'Validation failed';

const toIssues = (error: ZodError, target: ValidationTarget): ValidationIssue[] =>
    error.issues.map((issue) => ({
        path: [target, ...issue.path.map((segment) => String(segment))].join('.'),
        message: issue.message,
    }));

/**
 * Builds a `RequestHandler` that validates, then REPLACES the selected request
 * parts with the parsed result.
 *
 * Replacement is the point, not the validation: schemas built with `z.object()`
 * drop unknown keys, so a request can no longer smuggle in fields the handler
 * never declared (mass assignment) or operator objects such as `{ $ne: null }`
 * into Mongoose (NoSQL injection).
 *
 * All-or-nothing: if any target fails, nothing is replaced and the request is
 * answered with
 * `400 { success: false, message: 'Validation failed', errors: [{ path, message }] }`
 * (the `message` text is overridable per route via {@link ValidateOptions.message}).
 */
export const validate = ({ body, query, params, message }: ValidateOptions): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const issues: ValidationIssue[] = [];
        const parsed = new Map<ValidationTarget, unknown>();

        if (body) {
            const result = body.safeParse(req.body ?? {});

            if (result.success) {
                parsed.set('body', result.data);
            } else {
                issues.push(...toIssues(result.error, 'body'));
            }
        }

        if (query) {
            const result = query.safeParse(req.query ?? {});

            if (result.success) {
                parsed.set('query', result.data);
            } else {
                issues.push(...toIssues(result.error, 'query'));
            }
        }

        if (params) {
            const result = params.safeParse(req.params ?? {});

            if (result.success) {
                parsed.set('params', result.data);
            } else {
                issues.push(...toIssues(result.error, 'params'));
            }
        }

        if (issues.length > 0) {
            res.status(400).json({
                success: false,
                message: message ?? VALIDATION_FAILURE_MESSAGE,
                errors: issues,
            });
            return;
        }

        // See `replaceRequestPart`: plain assignment is silently ignored for
        // `req.query` on Express 5.
        const targets: readonly ValidationTarget[] = ['body', 'query', 'params'];

        for (const target of targets) {
            if (parsed.has(target)) {
                replaceRequestPart(req, target, parsed.get(target));
            }
        }

        next();
    };
};
