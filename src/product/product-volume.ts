/**
 * The one definition of how a product volume is written.
 *
 * It lives in its own module rather than inside the controller so the harness can test it
 * directly. The controller is reachable only through `adminGuard`, whose `protect` hits
 * MongoDB, so a rule that lives in a controller is a rule that can only be checked against
 * a live database — and this one is pure string handling that deserves a cheaper test.
 */

/**
 * Write a volume the way the storefront expects it: no gap before the unit and the unit
 * in lower case, so `100 ml` and `100ML` both become `100ml`.
 *
 * Deliberately NOT a format check. Six of the nineteen stored values are not volumes at
 * all (`5-piece set`, `5-piece mini set`) and one is a bare `50`, so a digits-then-unit
 * pattern would make those products unsaveable the moment they were edited. This rewrites
 * the shape it recognises and leaves everything else as typed.
 *
 * The rewrite is anchored to the WHOLE value on purpose. A global space-strip would turn
 * `1.7 fl oz` into `1.7fl oz`, and `100 ml bottle` into `100mlbottle`. Requiring "a
 * number, then a single word" fixes the case the field is actually used for and touches
 * nothing else.
 *
 * The same rule, applied as the field is typed, is in the admin's
 * `lib/product-form.ts`. Change one and the other becomes a lie.
 */
export const normalizeVolume = (value: unknown): unknown => {
    if (typeof value !== 'string') {
        return value;
    }

    return value
        .trim()
        .replace(/^(\d+(?:[.,]\d+)?)\s+([a-zA-Z]+)$/, '$1$2')
        .toLowerCase();
};
