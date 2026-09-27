import { z } from 'zod';

/**
 * Every field is shape-only and optional.
 *
 * Presence, phone format and the `deliveryZone` derivation are deliberately NOT
 * re-implemented here. `address.service.ts` merges the payload over the stored
 * document and then runs `validateAndNormalizeShippingAddress` — the validator
 * shared with checkout — so the address book and checkout can never disagree.
 * Duplicating "these six fields are required" here would create a second, weaker
 * source of truth for a rule that already has an owner, and would replace the
 * existing informative 400 ("Shipping name, phone, division, district,
 * area/thana, and detailed address are required") with a generic one.
 *
 * Deliberately absent, so Zod's strip behaviour removes them from `req.body`:
 *  - `userId`       → always taken from `req.user.id`; a client can never choose it
 *  - `deliveryZone` → derived server-side by `resolveDeliveryZone()`
 *  - `_id` / `id`   → Mongo-assigned
 */
const addressFields = {
    name: z.string().optional(),
    phone: z.string().optional(),
    division: z.string().optional(),
    district: z.string().optional(),
    area: z.string().optional(),
    /** Accepted alias for `area`; see `normalizeAddressPayload`. */
    thana: z.string().optional(),
    fullAddress: z.string().optional(),
    /** Accepted alias for `fullAddress`. */
    address: z.string().optional(),
    /** Accepted alias for `fullAddress`. */
    detailedAddress: z.string().optional(),
    landmark: z.string().optional(),
    /**
     * `'true'` / `'false'` remain accepted because `readBoolean()` /
     * `readExplicitFalse()` in the service accept them today, so narrowing to
     * `z.boolean()` would newly 400 any form-encoded client. The only known client
     * (`SavedAddressPayload`) sends a real boolean; tightening is left as a
     * deliberate decision rather than a silent behaviour change.
     */
    isDefault: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
};

/**
 * Body for `POST /api/addresses`.
 *
 * The service treats this as a full payload, but enforces the semantic
 * requirements itself (see the note above), so the shape is identical to the
 * update shape today.
 */
export const createAddressSchema = z.object(addressFields);

/**
 * Body for `PATCH /api/addresses/:id` — the frontend sends
 * `Partial<SavedAddressPayload>`, and the service merges it over the stored
 * document. Kept as its own export so each route carries its own contract and so
 * the two can diverge without touching the other route.
 */
export const updateAddressSchema = z.object(addressFields);

export type CreateAddressInput = z.infer<typeof createAddressSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;
