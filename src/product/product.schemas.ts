import { z } from 'zod';
import { numericField, OBJECT_ID_PATTERN, safeUrlSchema } from '../utils/validation';
import { mediaAssetSchema } from '../media/media-upload.schemas';

/**
 * Body schemas for the three product mutations:
 * `POST /api/products`, `PUT /api/products/:id`,
 * `PATCH /api/products/:id/pre-order/arrive`. The router also serves public GETs,
 * so the guard — and therefore `validate()` — is applied per route.
 *
 * RELATIONSHIP TO `sanitizeMutationBody()`. That helper is an **allowlist filter**,
 * not a shape check, and it is preserved unchanged: it copies the 25 keys of
 * `mutationFields` off the raw body and drops everything else. Zod runs *before*
 * the controller and does two things the filter cannot:
 *   1. strips the same unwanted keys at the edge, so they never even reach the
 *      handler (`rating`, `numReviews`, `_id`, `__v`, `createdAt`, `updatedAt`);
 *   2. enforces types, enums and numeric ranges on the keys that do survive.
 * Both layers stay — the filter still runs last, immediately before the
 * `Product.create` / `product.set` calls.
 *
 * `slug` IS intentionally settable, despite being described as server-derived.
 * `resolveSlug()` in the controller prefers a non-empty `body.slug` over the title,
 * and the admin sends one on every save (`lib/product-form.ts:305` →
 * `slug: slug || slugify(title) || undefined`). Stripping it would make
 * `resolveSlug` fall back to `slugify(product.title)`, which silently rewrites the
 * slug of any product whose stored slug is not exactly that (de-duplicated
 * `title-1`, legacy slugs, renamed titles) — breaking every existing URL. The value
 * is slugified server-side before use, so it cannot inject anything; the schema
 * bounds its length and nothing more.
 *
 * Fields that DO NOT EXIST on this model, and therefore have no schema entry:
 * `sku`, `barcode`, `soldCount`, and any SEO/meta fields.
 */

/**
 * `lowStockThreshold` is `number | null` (null clears it — `normalizeOptionalLowStockThreshold`
 * maps `null` and `''` to null). The `''` → null mapping is preserved so a hand-rolled
 * client that clears the field that way still works; a *numeric string* is no longer
 * coerced to a number, which no first-party client sends (`number | null` in the
 * admin payload type).
 */
const lowStockThresholdField = z
    .preprocess(
        (value) => (value === '' ? null : value),
        z.union([z.number().int().min(0, 'Low stock threshold cannot be negative'), z.null()])
    )
    .optional();

const preOrderField = z
    .object({
        expectedArrivalDate: z.coerce.date().optional(),
        quantityLimit: z.number().int().min(0, 'Pre-order quantity limit cannot be negative').optional(),
        customerMessage: z.string().trim().max(500, 'Pre-order customer message cannot exceed 500 characters').optional(),
        status: z.enum(['accepting', 'closed', 'arrived']).optional(),
        reservedQuantity: z.number().int().min(0).optional(),
    })
    .optional();

const keyIngredientField = z.array(
    z.object({
        name: z.string().trim().min(1, 'Key ingredient name is required'),
        benefit: z.string().trim().optional(),
    })
);

/**
 * `productId` is a 24-hex string only. The admin's `ProductCrossSellRecommendation`
 * type also permits a *populated* object, but the server has never accepted that
 * (`normalizeCrossSellRecommendations` runs `isValidObjectId(row.productId)` and a
 * plain object fails it), and the form normalises to a string before submitting
 * (`lib/product-form.ts:155-168`). The shape here matches the server's real
 * behaviour, not the looser client type.
 */
const crossSellRecommendationField = z.object({
    productId: z.string().regex(OBJECT_ID_PATTERN, 'Recommended product ID is invalid'),
    priority: z.number().min(0, 'Recommendation priority cannot be negative').optional(),
    enabled: z.boolean().optional(),
});

const productFields = {
    title: z.string().trim().min(1, 'Product title is required').max(200),
    slug: z.string().trim().max(200).optional(),
    brand: z.string().trim().min(1, 'Brand is required'),
    category: z.string().trim().min(1, 'Category is required'),
    description: z.string().max(2000).optional(),
    ingredients: z.string().optional(),
    howToUse: z.string().optional(),
    keyIngredients: keyIngredientField.optional(),
    /** Free-form arrays — `[String]` in the model, no enum. */
    skinType: z.array(z.string()).optional(),
    skinConcern: z.array(z.string()).optional(),
    price: z.number().min(0, 'Price cannot be negative'),
    salePrice: z.number().min(0, 'Sale price cannot be negative').optional(),
    /** Free-form in the model; the admin UI narrows it to Sale/Best/New. */
    badge: z.string().optional(),
    images: z.array(safeUrlSchema()).optional(),
    media: z.array(mediaAssetSchema).optional(),
    hoverImage: safeUrlSchema().optional(),
    volume: z.string().optional(),
    /** Routed through the inventory ledger on update, never `set()` directly. */
    stock: z.number().int().min(0, 'Stock cannot be non-negative').optional(),
    lowStockThreshold: lowStockThresholdField,
    availabilityMode: z.enum(['in_stock', 'pre_order']).optional(),
    preOrder: preOrderField,
    isBestSeller: z.boolean().optional(),
    isNewArrival: z.boolean().optional(),
    isTrending: z.boolean().optional(),
    crossSellRecommendations: z.array(crossSellRecommendationField).optional(),
};

/**
 * `POST /api/products`.
 *
 * `title`, `brand`, `category` and `price` are required because the model marks
 * them required and `createProduct` answered "Missing required fields: title,
 * brand, category, price" by hand. `images` stays optional — a payload may supply
 * `media` only, and the controller derives `images` from it.
 */
export const createProductSchema = z.object(productFields);

/** `PUT /api/products/:id` — a partial patch. */
export const updateProductSchema = z.object({
    title: productFields.title.optional(),
    slug: productFields.slug,
    brand: productFields.brand.optional(),
    category: productFields.category.optional(),
    description: productFields.description,
    ingredients: productFields.ingredients,
    howToUse: productFields.howToUse,
    keyIngredients: productFields.keyIngredients,
    skinType: productFields.skinType,
    skinConcern: productFields.skinConcern,
    price: productFields.price.optional(),
    salePrice: productFields.salePrice,
    badge: productFields.badge,
    images: productFields.images,
    media: productFields.media,
    hoverImage: productFields.hoverImage,
    volume: productFields.volume,
    stock: productFields.stock,
    lowStockThreshold: productFields.lowStockThreshold,
    availabilityMode: productFields.availabilityMode,
    preOrder: productFields.preOrder,
    isBestSeller: productFields.isBestSeller,
    isNewArrival: productFields.isNewArrival,
    isTrending: productFields.isTrending,
    crossSellRecommendations: productFields.crossSellRecommendations,
});

/**
 * `PATCH /api/products/:id/pre-order/arrive`.
 *
 * The handler does have a body: `actualReceivedQuantity`. `numericField` keeps the
 * existing `Number()` coercion, so a numeric string still works exactly as before.
 */
export const productArrivalSchema = z.object({
    actualReceivedQuantity: numericField(z.coerce.number().int().min(0)),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductArrivalInput = z.infer<typeof productArrivalSchema>;
