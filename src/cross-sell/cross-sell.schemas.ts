import { z } from 'zod';
import { numericField } from '../utils/validation';

/**
 * Body of `PUT /api/admin/settings/cross-sell` (the cross-sell singleton).
 *
 * NOTE: this singleton has **four scalar fields and no `recommendations` array**.
 * The recommendation list lives on each *product*
 * (`normalizeCrossSellRecommendations`, keyed by `productId`) and is already covered
 * by `product.schemas.ts` from P0-3.11. There is nothing array-shaped to validate here.
 *
 * EVERY FIELD IS OPTIONAL: `normalizeCrossSellSettingsPayload` coerces each one and
 * the serializer falls back to `DEFAULT_CROSS_SELL_SETTINGS`, so a partial payload is
 * supported. Making `maximumRecommendations` required here would break that.
 *
 * WHAT STAYS IN THE SERVICE: the **price-range** rule
 * (`maximum >= minimum`), because it is evaluated against the `?? 0` default of the
 * minimum — a partially-defaulted value Zod cannot see. `maximumRecommendations` is
 * used as a query `.limit()`, so keeping the service's positive-integer guard is
 * deliberate defence in depth.
 */
export const crossSellSettingsSchema = z.object({
    /** `Boolean(body.enabled)` in the service — a real boolean only. */
    enabled: z.boolean().optional(),
    maximumRecommendations: numericField(z.coerce.number().int().positive()).optional(),
    minimumRecommendedProductPrice: numericField(z.coerce.number().min(0)).optional(),
    /**
     * `number | null`; `null` means "no upper limit". The `''` → null mapping mirrors
     * `normalizeOptionalPrice`.
     *
     * `z.null()` must come FIRST in the union: `z.coerce.number()` happily accepts
     * `null` (via `Number(null) === 0`), so the other order silently turns "no upper
     * limit" into "maximum 0" — caught by the harness while writing this block.
     */
    maximumRecommendedProductPrice: z
        .preprocess(
            (value) => (value === '' ? null : value),
            z.union([z.null(), z.coerce.number().min(0)])
        )
        .optional(),
});

export type CrossSellSettingsInput = z.infer<typeof crossSellSettingsSchema>;
