import { z } from 'zod';
import { OBJECT_ID_PATTERN } from '../utils/validation';

/**
 * Body for `POST /api/wishlist` and `POST /api/wishlist/toggle`.
 *
 * Both handlers read the identical target payload (`readWishlistTarget` in
 * `wishlist.controller.ts`), so they share this schema; only the handler differs.
 *
 * Deliberately absent, so Zod's strip behaviour removes them from `req.body`:
 *  - `user` / `userId` → always `req.user.id`; a client can never choose the owner
 *  - `priceAtAdd`      → read server-side from the catalog, and it is the baseline
 *                        for the price-drop feature, so accepting it from the client
 *                        would let a customer fake their own discount
 *  - `_id` / `id`      → Mongo-assigned
 */
export const addToWishlistSchema = z
    .object({
        /** Current field name. */
        itemId: z.string().regex(OBJECT_ID_PATTERN, 'A valid itemId is required').optional(),
        /** Legacy field name still accepted by `readWishlistTarget`. */
        productId: z.string().regex(OBJECT_ID_PATTERN, 'A valid itemId is required').optional(),
        /**
         * Mirrors the accepted set of `normalizeWishlistItemType` exactly: `'combo'`,
         * `'product'`, or the "absent" spellings `''` / `null` (which it maps to
         * `'product'`). Anything else is rejected — previously by the service with
         * `invalid_item_type`, now here. The accepted set is unchanged; only the
         * rejection payload moves from the service message to the standard envelope.
         *
         * Matches `z.enum(['product', 'combo'])` in `order.schemas.ts` so the same
         * catalog concept is not enforced differently per module.
         */
        itemType: z.union([z.enum(['product', 'combo']), z.literal(''), z.null()]).optional(),
        /**
         * Shape-only: `req.body.sort` is read by both handlers, and
         * `normalizeWishlistSort` owns the value semantics (including its
         * fall-back-to-`newest` behaviour for anything unrecognised). Turning this
         * into an enum would convert that graceful fallback into a 400 — a
         * behaviour change on a non-security field. This field exists here purely so
         * that Zod does not strip it.
         */
        sort: z.string().optional(),
    })
    .refine((payload) => payload.itemId !== undefined || payload.productId !== undefined, {
        message: 'A valid itemId is required',
        path: ['itemId'],
    });

export type AddToWishlistInput = z.infer<typeof addToWishlistSchema>;
