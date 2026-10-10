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

/**
 * The `shortName` budget: 60 characters is a hard maximum.
 *
 * Enforced here rather than as a model `maxlength` because Mongoose validates on every
 * `save()`, including paths that never touch this field, so a model-level cap would make
 * any longer legacy value fail to save everywhere. This is where the field is written, so
 * this is where the limit belongs.
 *
 * Spaces are ordinary characters: the count is `value.length`, the same number the admin's
 * input `maxLength` and its counter use. There is no word budget.
 */
export const SHORT_NAME_MAX_CHARS = 60;

/** The full product name's ceiling, measured the same way. */
export const PRODUCT_TITLE_MAX_CHARS = 150;

/** The four long-text ceilings. Spaces count, as they do in every limit in this file. */
/**
 * Every limit on this model is a CHARACTER count, so a caller has one kind of number to reason
 * about.
 *
 * 300-word budgets were tried here on the two prose fields and removed. A word count is not
 * comparable with the character ceilings around it, so with both rules in place they disagreed
 * about which one was going to stop the caller, and at a 500-character ceiling a 300-word rule
 * could not be reached at all. Do not reintroduce them.
 */
export const SKIN_TYPE_MAX_CHARS = 150;
export const SKIN_CONCERN_MAX_CHARS = 300;
export const INGREDIENTS_MAX_CHARS = 1000;
export const DESCRIPTION_MAX_CHARS = 500;
export const HOW_TO_USE_MAX_CHARS = 300;

const titleField = z
    .string()
    .trim()
    .min(1, 'Product title is required')
    .max(PRODUCT_TITLE_MAX_CHARS, `Product title cannot exceed ${PRODUCT_TITLE_MAX_CHARS} characters`);

/**
 * The `shortName` shape, without saying whether it is required.
 *
 * OPTIONAL. An absent or empty value means "use the title": the serializers resolve that,
 * so a product whose card name matches its full name needs nothing here. No `min(1)` for
 * the same reason — `''` is a valid instruction to clear it.
 */
const shortNameShape = z
    .string()
    .trim()
    .max(SHORT_NAME_MAX_CHARS, `Short name cannot exceed ${SHORT_NAME_MAX_CHARS} characters`);

const descriptionField = z
    .string()
    .trim()
    .min(1, 'Description is required')
    .max(DESCRIPTION_MAX_CHARS, `Description cannot exceed ${DESCRIPTION_MAX_CHARS} characters`);

const ingredientsField = z
    .string()
    .trim()
    .min(1, 'Ingredients are required')
    .max(INGREDIENTS_MAX_CHARS, `Ingredients cannot exceed ${INGREDIENTS_MAX_CHARS} characters`);

const howToUseField = z
    .string()
    .trim()
    .min(1, 'How to use is required')
    .max(HOW_TO_USE_MAX_CHARS, `How to use cannot exceed ${HOW_TO_USE_MAX_CHARS} characters`);

/**
 * The two Skin Information lists.
 *
 * Measured on `join('\n')`, and that is deliberately the conservative direction. The
 * client splits the textarea on newlines and commas and trims every entry, so the joined
 * length is always less than or equal to the text the user typed. Measuring anything
 * shorter here would reject a payload whose own counter was inside the limit — a false
 * failure exactly at the boundary, which is the worst place for one.
 */
const skinTypeField = z
    .array(z.string().trim().min(1, 'Skin type entries cannot be empty'))
    .min(1, 'Skin type is required')
    .refine(
        (value) => value.join('\n').length <= SKIN_TYPE_MAX_CHARS,
        `Skin type cannot exceed ${SKIN_TYPE_MAX_CHARS} characters`
    );

const skinConcernField = z
    .array(z.string().trim().min(1, 'Skin concern entries cannot be empty'))
    .min(1, 'Skin concern is required')
    .refine(
        (value) => value.join('\n').length <= SKIN_CONCERN_MAX_CHARS,
        `Skin concern cannot exceed ${SKIN_CONCERN_MAX_CHARS} characters`
    );

/** Required on create, and the value the inventory ledger starts from. */
const stockField = z.number().int().min(0, 'Stock cannot be negative');

/**
 * Required, and not a format check — see `normalizeVolume` in the controller for why.
 * The ceiling is a sanity bound only; real values are four characters.
 */
const volumeField = z.string().trim().min(1, 'Volume is required').max(100, 'Volume cannot exceed 100 characters');

const productFields = {
    title: titleField,
    /**
     * OPTIONAL. An absent or empty value means "use the title": the serializers resolve
     * that, so a product whose card name matches its full name needs nothing here.
     */
    shortName: shortNameShape.optional(),
    slug: z.string().trim().max(200).optional(),
    brand: z.string().trim().min(1, 'Brand is required'),
    category: z.string().trim().min(1, 'Category is required'),
    /** Optional in a patch, but a supplied value must be non-empty: see `descriptionField`. */
    description: descriptionField.optional(),
    ingredients: ingredientsField.optional(),
    howToUse: howToUseField.optional(),
    keyIngredients: keyIngredientField.optional(),
    /** Free-form arrays — `[String]` in the model, no enum. Required on create. */
    skinType: skinTypeField.optional(),
    skinConcern: skinConcernField.optional(),
    price: z.number().min(0, 'Price cannot be negative'),
    salePrice: z.number().min(0, 'Sale price cannot be negative').optional(),
    /** Free-form in the model; the admin UI narrows it to Sale/Best/New. */
    badge: z.string().optional(),
    images: z.array(safeUrlSchema()).optional(),
    media: z.array(mediaAssetSchema).optional(),
    hoverImage: safeUrlSchema().optional(),
    /** Required on create. Not a format check — see `normalizeVolume`. */
    volume: volumeField.optional(),
    /**
     * Required on create. Routed through the inventory ledger on update, never `set()`
     * directly, which is why it stays optional here: a partial patch must be able to
     * change one field without restating the stock it is not touching.
     */
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
 * The required set, and why each member is in it: `title`, `brand`, `category` and
 * `price` were always required. `description`, `ingredients`, `howToUse`, `skinType`,
 * `skinConcern`, `stock` and `volume` joined them, because a product without them renders
 * an empty section on the storefront rather than an incomplete-looking one — a details page
 * with no description, a table with no volume.
 *
 * `shortName` is deliberately NOT in that list. It is optional and blank means "use the
 * full title", which the serializers resolve on read.
 *
 * Neither is `lowStockThreshold`, despite being inventory: its empty state means "use the
 * global threshold", which is a real instruction rather than a gap. `salePrice` is an
 * optional discount. `images` stays optional because a payload may supply `media` only,
 * and the controller derives `images` from it, refusing the request when both are empty.
 *
 * These strict shapes are applied HERE rather than to `productFields`, so that
 * `updateProductSchema` keeps its permissive entries and a partial patch still works.
 */
export const createProductSchema = z.object({
    ...productFields,
    description: descriptionField,
    ingredients: ingredientsField,
    howToUse: howToUseField,
    skinType: skinTypeField,
    skinConcern: skinConcernField,
    stock: stockField,
    volume: volumeField,
});

/** `PUT /api/products/:id` — a partial patch. */
export const updateProductSchema = z.object({
    title: productFields.title.optional(),
    // Optional here too, and `''` clears it back to "use the title".
    shortName: productFields.shortName,
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
