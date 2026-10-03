import { z } from 'zod';

/**
 * Converts the empty string and `null` to `undefined` before coercion.
 *
 * Cleared HTML number inputs submit `''`, and `Number('')` is `0` — which for a
 * price would mean "free" rather than "absent". Bare `z.coerce.number()` is
 * therefore banned across these schemas; always go through {@link numericField}.
 */
export const emptyStringToUndefined = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

/**
 * A number that also accepts a numeric string (`'2'`), matching what the
 * controllers accepted before validation existed (`Number(value)`). `''`,
 * `null`, `NaN` and non-numeric strings are rejected.
 *
 * Pass constraints to add per-field rules, for example
 * `numericField(z.coerce.number().int().positive().max(999))`.
 */
export const numericField = (
  constraints: z.ZodType<number> = z.coerce.number()
): z.ZodType<number> => z.preprocess(emptyStringToUndefined, constraints);

/**
 * Like {@link numericField}, but the field itself may be absent.
 *
 * `.optional()` must be applied to the CONSTRAINTS, inside the preprocess:
 * `numericField(...).optional()` does not work, because the preprocess runs first
 * and `z.coerce.number()` turns `undefined` into `NaN`, which the outer optional
 * wrapper then rejects anyway. `''` counts as absent, matching the controllers
 * that already read a cleared input as "not supplied".
 */
export const optionalNumericField = (
  constraints: z.ZodType<number> = z.coerce.number()
): z.ZodType<number | undefined> =>
  z.preprocess(emptyStringToUndefined, constraints.optional());

/**
 * Exactly 24 hex characters — the only string form Mongoose accepts for an
 * ObjectId. Single source of truth for every schema that turns a client-supplied
 * id into a database query, so no schema can drift to a subtly weaker pattern
 * (that drift is how `{$ne: ...}` injection gets back in).
 *
 * Intentionally has NO `g` / `y` flag: those make `RegExp.test()` stateful via
 * `lastIndex`, which would make a shared instance alternate between pass and
 * fail across calls.
 */
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** Exact wording returned when {@link safeUrlSchema} rejects a value. */
export const SAFE_URL_MESSAGE = 'URL must be an https:// URL or a site-relative path';

/**
 * A site-relative path, and only a site-relative path.
 *
 * Split out from {@link safeUrlSchema} so the single subtle condition — that
 * position 1 must not be `/` — is greppable and tested on its own.
 */
const isSiteRelativePath = (url: string): boolean =>
    url.startsWith('/') && url[1] !== '/' && url[1] !== '\\';

/**
 * A URL an admin may store that a client will later bind to an `href`
 * (P1.4, decisions ①/②).
 *
 * Only two shapes pass: an absolute `https://` URL, or a site-relative path
 * beginning with `/`. Everything else is refused — in particular `javascript:`
 * and `data:`, the two schemes that turn a *stored string* into script execution
 * as soon as a client writes it into an anchor. The storefront had exactly that
 * binding for the campaign CTA and the announcement bar, with no validation on
 * either side of the wire.
 *
 * A prefix test rather than `new URL()` is deliberate: `new URL('javascript:alert(1)')`
 * **succeeds** (it is a well-formed URL with a `javascript:` protocol), so a
 * parsed-protocol check would be needed anyway — and the allowlist form keeps
 * `JaVaScRiPt:` out, which a naive protocol comparison would have to lower-case.
 *
 * `//evil.example` is refused explicitly, and that is a **tightening** of the
 * agreed rule: `startsWith('/')` alone accepts it, but a browser reads a leading
 * `//` as a protocol-relative *absolute* URL to another host — off-site navigation
 * wearing a path's costume, which is exactly what a stored CTA must not be able to
 * do. `/\` is refused for the same reason (browsers normalise the backslash). The
 * harness caught this: its first run failed on precisely the protocol-relative
 * cases, and the helper's own note had claimed they were impossible.
 *
 * `''` is accepted as "not supplied". These are all optional fields and a cleared
 * form input submits the empty string, so rejecting it would turn clearing a
 * field into a validation failure unrelated to the injection this closes. It
 * still cannot be an attack: an empty href does nothing.
 *
 * Trade-off worth knowing: the scheme comparison is case-sensitive, so
 * `HTTPS://…` is refused. That is stricter than the URL spec and easy to relax
 * (compare a lower-cased copy) — it was left strict to match the agreed rule.
 */
export const safeUrlSchema = () =>
    z
        .string()
        .trim()
        .refine((url) => url === '' || url.startsWith('https://') || isSiteRelativePath(url), {
            message: SAFE_URL_MESSAGE,
        });

/** Exact wording returned when {@link objectIdParam} rejects a value. */
export const OBJECT_ID_PARAM_MESSAGE = 'Must be a 24-character hexadecimal id';

/**
 * A route parameter (`:id`, `:itemId`, `:productId`, …) that must be an ObjectId,
 * for use as `validate({ params: objectIdParam('id') })` (P1.6.1).
 *
 * Why this exists on top of the hand-written `isValidObjectId` guards the
 * controllers already had:
 *
 *  1. **One definition.** Every place that asked "is this an ObjectId?" now asks it
 *     the same way. `mongoose.Types.ObjectId.isValid` and {@link OBJECT_ID_PATTERN}
 *     happen to agree for strings in the mongoose version this project pins
 *     (measured: both refuse a 12-character string, `isValid('abcdefghijkl')` is
 *     `false`), but `isValid` is a different question — it also accepts an
 *     `ObjectId` instance and an `{_id}`-shaped object, and its answer is a
 *     property of the installed mongoose rather than of this project. The harness
 *     asserts the two still agree, so a future major that widens `isValid` fails
 *     there instead of silently widening what these routes accept.
 *  2. **Refusal happens in the declared layer**, before any handler code runs,
 *     which is where every other input contract on these routes already lives.
 *
 * The controllers keep their own checks. They are not redundant noise: they make
 * the 400 a property of the handler that needs the id, so a route added without
 * this middleware still refuses — dropping one layer cannot open a hole. Nothing
 * here turns a malformed id into a query; it turns it into a 400 with the route's
 * existing wording, passed by the caller as `validate({ message })` so no client
 * sees a changed string.
 *
 * `passthroughNames` declares sibling params on the same path. They are read as
 * plain strings because `validate()` REPLACES `req.params` with the parsed object
 * — an undeclared sibling would be silently dropped, which on
 * `/:itemType/:itemId/history` would have turned every request into a lookup for
 * the default item type.
 *
 * No `.trim()`: whitespace around an id is not an id, and trimming would widen
 * what the API accepts relative to the guards above.
 */
export const objectIdParam = (
    name: string,
    passthroughNames: readonly string[] = []
): z.ZodType<Record<string, string>> => {
    const shape: Record<string, z.ZodType<string>> = {
        [name]: z.string().regex(OBJECT_ID_PATTERN, OBJECT_ID_PARAM_MESSAGE),
    };

    for (const passthroughName of passthroughNames) {
        shape[passthroughName] = z.string();
    }

    return z.object(shape);
};
