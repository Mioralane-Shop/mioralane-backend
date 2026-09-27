import { z } from 'zod';

/**
 * NOTE: review image upload is disabled across the stack.
 *
 * Runtime payload is `{ productId, rating, comment }` — the frontend's
 * `images` field in `SubmitReviewPayload` is a stale type (commented out in
 * `review-form.tsx:135-136`) and is NOT sent on the wire.
 *
 * The schema therefore omits `images` entirely: an unknown key gets stripped
 * by Zod's default object behaviour, which is the correct outcome while the
 * feature is disabled.
 *
 * Do NOT add an `images` field here until BOTH conditions are true:
 *   1. The media pipeline route for review images is re-enabled
 *      (currently commented out in `media.routes.ts`).
 *   2. That route has been reviewed for security (upload validation, MIME
 *      allowlist, size cap, storage key hygiene) as part of a deliberate
 *      re-enablement.
 *
 * Adding `images` silently would re-expose a disabled attack surface
 * (unauthenticated file upload path) without the security review it needs.
 */

/**
 * Single source of truth for review input bounds. These were previously private
 * constants in `review.service.ts`; the shape checks that used them became
 * unreachable once `validate()` ran first, so the bounds moved here to the layer
 * that actually enforces them.
 *
 * `review.model.ts` still declares `3` / `2000` / `1` / `5` in its own validator
 * messages. That duplication is deliberate: the model is the database-level
 * backstop and must stay correct even if a future caller bypasses HTTP.
 */
export const MIN_REVIEW_RATING = 1;
export const MAX_REVIEW_RATING = 5;
export const MIN_REVIEW_LENGTH = 3;
export const MAX_REVIEW_LENGTH = 2000;

/**
 * Exactly 24 hex characters — the only string form Mongoose accepts for an
 * ObjectId. Mirrors `OBJECT_ID_PATTERN` in `order.schemas.ts`; consolidating
 * both into `src/utils/validation.ts` is proposed as a follow-up so this
 * security-relevant pattern exists in exactly one place.
 */
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Body for `POST /api/reviews`.
 *
 * Deliberately absent:
 *  - `images`            → feature disabled (see the NOTE above)
 *  - `status`            → server derives `'pending'` (`review.service.ts`)
 *  - `verifiedPurchase`  → server derives it from the matched delivered order
 *  - `userId` / `order`  → server derives both from `req.user.id` and the order
 *                          lookup; a client can never influence them.
 *
 * `rating` is a real number, not coerced: the only client
 * (`review-form.tsx`) already sends a number, and coercing would silently
 * accept `"5"` / `true`. `comment` is trimmed before the length bounds are
 * applied, matching the exact semantics of the checks this schema replaced.
 */
export const createReviewSchema = z.object({
    productId: z.string().regex(OBJECT_ID_PATTERN, 'Invalid product ID'),
    rating: z
        .number()
        .int('Rating must be a whole number between 1 and 5')
        .min(MIN_REVIEW_RATING, 'Rating must be a whole number between 1 and 5')
        .max(MAX_REVIEW_RATING, 'Rating must be a whole number between 1 and 5'),
    comment: z
        .string()
        .trim()
        .min(MIN_REVIEW_LENGTH, `Review text must be at least ${MIN_REVIEW_LENGTH} characters`)
        .max(MAX_REVIEW_LENGTH, `Review text cannot exceed ${MAX_REVIEW_LENGTH} characters`),
});

export type CreateReviewInput = z.infer<typeof createReviewSchema>;
