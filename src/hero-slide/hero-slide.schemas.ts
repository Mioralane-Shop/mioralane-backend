import { z } from 'zod';
import { OBJECT_ID_PATTERN, optionalNumericField, safeUrlSchema } from '../utils/validation';
import {
    MAX_HERO_SLIDE_ALT_LENGTH,
    MAX_HERO_SLIDE_ORDER,
    MAX_HERO_SLIDE_URL_LENGTH,
} from './hero-slide.model';

/**
 * Request-body schemas for the admin hero-slide mutations.
 *
 * Both URLs go through `safeUrlSchema()`: they are stored strings that a client
 * later binds to an `href` and an image `src`, which is exactly the class of risk
 * the campaign CTA, the announcement bar and the brand logo already have closed.
 * An `https://` URL or a site-relative path (`/slider/slider1.png`) is accepted;
 * `javascript:`, `data:` and protocol-relative `//evil.example` are not.
 *
 * Server-owned fields (`_id`, `createdAt`, `updatedAt`, `__v`) cannot be injected:
 * Zod strips unknown keys, so they never reach the model.
 */

const imageUrlField = safeUrlSchema()
    .min(1, 'Image URL is required')
    .max(MAX_HERO_SLIDE_URL_LENGTH, `Image URL cannot exceed ${MAX_HERO_SLIDE_URL_LENGTH} characters`);

const targetUrlField = safeUrlSchema()
    .min(1, 'Target URL is required')
    .max(MAX_HERO_SLIDE_URL_LENGTH, `Target URL cannot exceed ${MAX_HERO_SLIDE_URL_LENGTH} characters`);

const altTextField = z
    .string()
    .trim()
    .max(MAX_HERO_SLIDE_ALT_LENGTH, `Alt text cannot exceed ${MAX_HERO_SLIDE_ALT_LENGTH} characters`);

/**
 * `optionalNumericField` rather than `numericField(...).optional()`: a cleared
 * number input submits `''`, and the inner `z.coerce.number()` runs after the
 * preprocess, so `.optional()` applied OUTSIDE it would still see `''` → `NaN` and
 * refuse. `optionalNumericField` keeps the "empty means absent" rule inside.
 *
 * That distinction matters here: absent means "append to the end of the list",
 * whereas a coerced `0` would silently move the slide to the top.
 */
const orderField = optionalNumericField(z.coerce.number().int().min(0).max(MAX_HERO_SLIDE_ORDER));

export const createHeroSlideSchema = z.object({
    imageUrl: imageUrlField,
    targetUrl: targetUrlField,
    altText: altTextField.optional(),
    order: orderField,
    isActive: z.boolean().optional(),
});

/**
 * Every field optional; `partial()` keeps the strip-unknown-keys behaviour, so the
 * admin form can submit the whole fetched row without writing fields it did not
 * mean to change.
 */
export const updateHeroSlideSchema = createHeroSlideSchema.partial();

/**
 * Bulk reorder. The body IS the array — `[{ id, order }, …]` — so the admin can
 * send the list it just moved without reshaping it.
 *
 * `min(1)` because an empty reorder is a no-op that still reports success, and a
 * duplicate `id` is rejected here rather than letting the result depend on array
 * order.
 */
export const reorderHeroSlidesSchema = z
    .array(
        z.object({
            id: z.string().regex(OBJECT_ID_PATTERN, 'Invalid hero slide ID'),
            order: z.number().int().min(0).max(MAX_HERO_SLIDE_ORDER),
        })
    )
    .min(1, 'At least one hero slide is required')
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
        message: 'Each hero slide may appear only once',
    });

export type CreateHeroSlideInput = z.infer<typeof createHeroSlideSchema>;
export type UpdateHeroSlideInput = z.infer<typeof updateHeroSlideSchema>;
export type ReorderHeroSlidesInput = z.infer<typeof reorderHeroSlidesSchema>;
