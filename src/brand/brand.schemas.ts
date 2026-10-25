import { z } from 'zod';
import { OBJECT_ID_PATTERN, optionalNumericField, safeUrlSchema } from '../utils/validation';
import { MAX_BRAND_LOGO_ALT_LENGTH, MAX_BRAND_NAME_LENGTH, MAX_BRAND_SLUG_LENGTH } from './brand.model';

/**
 * Request-body schemas for the admin brand mutations.
 *
 * Two things these are responsible for, and one they are deliberately not.
 *
 * 1. **`logoUrl` goes through `safeUrlSchema()`.** The value is stored and later
 *    bound to an image `src` by the storefront, which is the same class of risk
 *    the campaign CTA and the announcement bar already had closed: a stored
 *    string that becomes script execution the moment a client renders it, or
 *    `//evil.example` — off-site navigation wearing a path's costume. An
 *    `https://` URL or a site-relative path, nothing else.
 * 2. **Server-owned fields cannot be injected.** Zod's default object behaviour
 *    strips unknown keys, so `createdAt`, `updatedAt`, `_id`/`id` and `__v` in a
 *    request body never reach the model.
 *
 * NOT here: the uniqueness of `slug`. That is a property of the *collection*, not
 * of the value, so it belongs to the unique index and surfaces as 409 — a schema
 * cannot answer it without a race, and a `refine` that queried the database would
 * put I/O inside validation.
 */

const nameField = z
  .string()
  .trim()
  .min(1, 'Brand name is required')
  .max(MAX_BRAND_NAME_LENGTH, `Brand name cannot exceed ${MAX_BRAND_NAME_LENGTH} characters`);

/**
 * Optional on create — the service derives it from `name` via `slugify()` when
 * this is absent or blank.
 */
const slugField = z
  .string()
  .trim()
  .max(MAX_BRAND_SLUG_LENGTH, `Brand slug cannot exceed ${MAX_BRAND_SLUG_LENGTH} characters`);

const logoUrlField = safeUrlSchema().optional();
const logoAltField = z.string().trim().max(MAX_BRAND_LOGO_ALT_LENGTH).optional();

/**
 * `optionalNumericField` rather than `z.coerce.number().optional()`: a cleared
 * HTML number input submits `''`, and `Number('')` is `0` — so a bare coercion
 * would turn "no size recorded" into a real `0` and make the storefront reserve
 * a zero-height box. It also rejects `NaN` instead of storing it.
 */
const dimensionField = optionalNumericField(z.coerce.number().int().positive());

export const createBrandSchema = z.object({
  name: nameField,
  slug: slugField.optional(),
  logoUrl: logoUrlField,
  logoAlt: logoAltField,
  logoWidth: dimensionField,
  logoHeight: dimensionField,
  showInNavbar: z.boolean().optional(),
  showInMarquee: z.boolean().optional(),
  visible: z.boolean().optional(),
  order: z.number().int().optional(),
});

/**
 * Every field optional, and `.strict()` is NOT used: `partial()` keeps the same
 * strip-unknown-keys behaviour, so an update can carry the whole fetched document
 * (which is what the admin forms submit) without any of it being written.
 */
export const updateBrandSchema = createBrandSchema.partial();

/**
 * Bulk reorder. The body IS the array — `[{ id, order }, …]` — as specified,
 * not an object wrapping one, so the admin can send the list it just dragged
 * without reshaping it.
 *
 * `min(1)` because an empty reorder is a no-op that still reports success; a
 * duplicate `id` is rejected here rather than silently letting the last write
 * win, which would make the result depend on array order.
 *
 * The `:id` params on the other routes use `objectIdParam('id')` from
 * `utils/validation.ts` rather than a schema of their own, so the "is this an
 * ObjectId?" question has exactly one definition. `OBJECT_ID_PATTERN` is reused
 * here because these ids arrive inside a body, which `objectIdParam` does not
 * cover.
 */
export const reorderBrandsSchema = z
  .array(
    z.object({
      id: z.string().regex(OBJECT_ID_PATTERN, 'Invalid brand ID'),
      order: z.number().int(),
    })
  )
  .min(1, 'At least one brand is required')
  .refine(
    (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    { message: 'Each brand may appear only once' }
  );

export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type ReorderBrandsInput = z.infer<typeof reorderBrandsSchema>;
