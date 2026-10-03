import { z } from 'zod';
import { mediaAssetSchema } from '../media/media-upload.schemas';
import { safeUrlSchema } from '../utils/validation';

/**
 * Body schemas for the two admin combo mutations (`POST /api/combos`,
 * `PUT /api/combos/:id`). The router also serves public GETs, so the guard — and
 * therefore `validate()` — is applied per route, never with `router.use()`.
 *
 * SERVER-DERIVED FIELDS, all stripped here:
 *  - `slug`      → regenerated from `title` by the model's `pre('save')` hook
 *                  (`combo.model.ts`), and overwritten by `slugify(body.title)` in
 *                  the controller. The admin payload does send a `slug`; it has
 *                  always been ignored, so stripping changes nothing.
 *  - `rating` / `numReviews` → owned by the review aggregation; `createCombo`
 *                  hard-codes 0/0.
 *  - `savings`   → always recomputed from `compareAtPrice - price` in both handlers.
 *  - `_id` / `__v` / `createdAt` / `updatedAt` → Mongoose-owned.
 *
 * NO ENUMS EXIST for this model. `badge`, `routineTag`, `size`, `volume`,
 * `skinType`, `category` and `brand` are all free-form strings in
 * `combo.model.ts`, and `includedItems` / `concerns` are free-form `[String]`
 * arrays (e.g. `["Cleanser", "Toner"]` — *labels*, not `{ itemId, quantity }`
 * pairs). There is therefore nothing to enumerate; inventing an enum here would
 * reject data that is valid today.
 */

const comboFields = {
    title: z.string().trim().min(1, 'Combo title is required').max(200),
    description: z.string().max(2000).optional(),
    badge: z.string().trim().optional(),
    routineTag: z.string().trim().optional(),
    price: z.number().min(0, 'Price cannot be negative'),
    compareAtPrice: z.number().min(0, 'Compare-at price cannot be negative').optional(),
    /** Labels such as "Cleanser", "Toner" — not id/quantity pairs. */
    includedItems: z.array(z.string()).optional(),
    concerns: z.array(z.string()).optional(),
    /** ImageKit URLs. Derived from `media` when `media` is non-empty. */
    images: z.array(safeUrlSchema()).optional(),
    media: z.array(mediaAssetSchema).optional(),
    hoverImage: safeUrlSchema().optional(),
    size: z.string().trim().optional(),
    volume: z.string().trim().optional(),
    /** Routed through the inventory ledger on update, never `set()` directly. */
    stock: z.number().int().min(0, 'Stock cannot be negative').optional(),
    skinType: z.string().trim().optional(),
    isBestSeller: z.boolean().optional(),
    isNewArrival: z.boolean().optional(),
};

/**
 * `POST /api/combos`.
 *
 * `title` and `price` are required because the model marks them required and
 * `createCombo` used to answer "Missing required fields: title, price" by hand.
 * `images` is NOT required here: a payload may supply `media` only, and the
 * controller derives `images` from it (and still returns its own 400 when neither
 * is usable).
 *
 * `category` and `brand` are accepted on create only, matching
 * `body.category || 'combo'` / `body.brand || 'Mioralane Bundle'`. They are absent
 * from the update schema because the controller's existing `allowed` allowlist
 * never permitted them there.
 */
export const createComboSchema = z.object({
    ...comboFields,
    category: z.string().trim().optional(),
    brand: z.string().trim().optional(),
});

/**
 * `PUT /api/combos/:id` — a partial patch (the handler does `combo.set(...)`).
 *
 * The field set is exactly the controller's previous 14-key `allowed` allowlist,
 * minus `savings`: that entry could set the value but the handler overwrote it a
 * few lines later, so it was never effective. Keeping the same set here means the
 * schema *is* the allowlist — which is why removing `validate()` from this route
 * is caught by the harness in `verify-validation.ts`.
 */
export const updateComboSchema = z.object({
    title: comboFields.title.optional(),
    description: comboFields.description,
    badge: comboFields.badge,
    routineTag: comboFields.routineTag,
    price: comboFields.price.optional(),
    compareAtPrice: comboFields.compareAtPrice,
    includedItems: comboFields.includedItems,
    concerns: comboFields.concerns,
    images: comboFields.images,
    media: comboFields.media,
    hoverImage: comboFields.hoverImage,
    size: comboFields.size,
    volume: comboFields.volume,
    stock: comboFields.stock,
    skinType: comboFields.skinType,
    isBestSeller: comboFields.isBestSeller,
    isNewArrival: comboFields.isNewArrival,
});

export type CreateComboInput = z.infer<typeof createComboSchema>;
export type UpdateComboInput = z.infer<typeof updateComboSchema>;
