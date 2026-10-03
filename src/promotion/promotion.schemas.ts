import { z } from 'zod';
import { OBJECT_ID_PATTERN, safeUrlSchema } from '../utils/validation';

/**
 * Request-body schemas for the four admin promotion mutations.
 *
 * WHY THIS BLOCK MATTERS: both controllers currently hand `req.body` straight to
 * the model (`PromotionCampaign.create(req.body)` / `campaign.set(req.body)`, and
 * the same pair for coupons). Combined with the admin forms — which seed their
 * state with the whole fetched document and submit `{ ...form }` — that means the
 * update bodies really do carry `usageCount`, `createdAt`, `updatedAt`,
 * `publishedAt` and `id` today. Every one of those is server-owned:
 *
 *   - `usageCount`   → wiping it resets a coupon's redemption counter
 *   - `createdAt`    → can be forged (Mongoose timestamps only rewrite `updatedAt`)
 *   - `publishedAt`  → can be back/forward-dated, defeating "published at" ordering
 *   - `_id` / `id`   → identity
 *
 * Zod's default object behaviour strips all of them, which is the fix.
 *
 * WHAT ZOD DELIBERATELY DOES NOT OWN. Both models validate themselves far more
 * strictly than the shape does, in `pre('validate')` hooks:
 *   - `promotion-campaign.model.ts`: `endDate > startDate`, discount required per
 *     campaign type, `percentage` 1..100, eligibility requires products/categories,
 *     popup CTA fields, `couponId` required for coupon actions, `floatingTab.title`
 *     required when enabled, and `publishedAt` stamping.
 *   - `coupon.model.ts`: `expiryDate > startDate`, `percentage` 1..100 / `fixed` > 0,
 *     product/category existence, and `code` normalisation.
 * Those stay there on purpose. They are cross-field and data-dependent (they query
 * the Product collection), and `sendMutationError()` already maps a Mongoose
 * `ValidationError` to `400 { message: 'Validation failed', errors: [string] }` —
 * duplicating them here would return a *second* `errors` shape for the same route.
 *
 * KNOWN FOLLOW-UP (not fixed here): both admin forms render errors with
 * `response.data.errors?.join(', ')`, which prints `[object Object]` for the
 * `{ path, message }` entries that `validate()` returns. That affects every module
 * hardened in P0-3.3+ and needs a small frontend fix.
 */

/** `CampaignType` — `promotion-campaign.model.ts`. */
export const CAMPAIGN_TYPES = [
    'automatic_discount',
    'coupon_discount',
    'announcement',
    'free_delivery',
    'free_gift',
] as const;

/** `CampaignAdminStatus` — the only statuses an admin may set directly. */
export const CAMPAIGN_STATUSES = ['draft', 'published', 'paused'] as const;

/** `PopupActionType` — `promotion-campaign.model.ts`. */
export const POPUP_ACTION_TYPES = ['none', 'link', 'coupon', 'coupon_link'] as const;

/** Shared by campaigns and coupons. */
export const DISCOUNT_TYPES = ['percentage', 'fixed'] as const;

/** `EligibilityAppliesTo` — shared by campaigns and coupons. */
export const ELIGIBILITY_APPLIES_TO = ['all', 'products', 'categories'] as const;

const objectIdField = z.string().regex(OBJECT_ID_PATTERN, 'Invalid id');
const positiveIntegerField = z.number().int().positive();
const nonNegativeNumberField = z.number().min(0);
/**
 * `z.coerce.date()` rather than `z.string()`: it rejects `'garbage'` at the edge
 * with a clean 400 instead of letting a Mongoose `CastError` surface later.
 */
const dateField = z.coerce.date();

/**
 * Campaign fields an admin may set. Note what is absent: `publishedAt` is stamped
 * by the model's `pre('validate')` hook when `status` becomes `published`, and
 * `_id` / `__v` / `createdAt` / `updatedAt` are Mongoose-owned.
 */
const campaignFields = {
    name: z.string().trim().min(1, 'Campaign name is required').max(160),
    internalDescription: z.string().trim().max(2000).optional(),
    campaignType: z.enum(CAMPAIGN_TYPES),
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    priority: nonNegativeNumberField.optional(),
    floatingTab: z
        .object({
            enabled: z.boolean().optional(),
            title: z.string().trim().optional(),
            subtitle: z.string().trim().optional(),
        })
        .optional(),
    popup: z
        .object({
            enabled: z.boolean().optional(),
            // Block D: the poster reaches `<Image src>` in the storefront popup, so
            // it is held to the same allowlist as every other stored URL rather than
            // trusted to the renderer's own image-host check.
            posterUrl: safeUrlSchema().optional(),
            posterFileId: z.string().trim().optional(),
            posterAlt: z.string().trim().optional(),
            actionType: z.enum(POPUP_ACTION_TYPES).optional(),
            ctaLabel: z.string().trim().optional(),
            ctaUrl: safeUrlSchema().optional(),
            couponId: objectIdField.optional(),
        })
        .optional(),
    discount: z
        .object({
            type: z.enum(DISCOUNT_TYPES),
            value: nonNegativeNumberField,
            minimumOrderValue: nonNegativeNumberField.optional(),
            maximumDiscount: nonNegativeNumberField.optional(),
        })
        .optional(),
    eligibility: z
        .object({
            appliesTo: z.enum(ELIGIBILITY_APPLIES_TO).optional(),
            productIds: z.array(objectIdField).optional(),
            categories: z.array(z.string()).optional(),
        })
        .optional(),
    usageLimits: z
        .object({
            totalUsageLimit: positiveIntegerField.optional(),
            perCustomerUsageLimit: positiveIntegerField.optional(),
        })
        .optional(),
    schedule: z.object({
        startDate: dateField,
        endDate: dateField,
    }),
};

/** `POST /api/admin/campaigns`. */
export const createCampaignSchema = z.object(campaignFields);

/**
 * `PUT /api/admin/campaigns/:id`. The handler does `campaign.set(body)`, so this
 * is a partial patch — `{ status: 'published' }` alone is valid. Turning `status`
 * into `published` is how the admin UI publishes a campaign.
 */
export const updateCampaignSchema = z.object({
    ...campaignFields,
    name: campaignFields.name.optional(),
    campaignType: campaignFields.campaignType.optional(),
    schedule: z
        .object({
            startDate: dateField.optional(),
            endDate: dateField.optional(),
        })
        .optional(),
});

/**
 * Coupon code charset (P1.6.7), applied after normalisation.
 *
 * Exported so the harness asserts the rule that ships rather than a copy of it.
 */
export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{2,40}$/;

/** Exact wording returned when a code fails {@link COUPON_CODE_PATTERN}. */
export const COUPON_CODE_MESSAGE =
    'Coupon code must be 2-40 characters of A-Z, 0-9, hyphen or underscore';

/**
 * Coupon code. Normalised here exactly as `normalizeCouponCode()` does (trim,
 * upper-case, strip whitespace) so the rule is measured on the value that will
 * actually be stored — a lower-case code typed by an admin still passes, and the
 * admin form already upper-cases as you type.
 *
 * Charset is an allowlist, added in P1.6.7. The note that used to live here said a
 * stricter pattern would make existing coupons impossible to save on edit, because
 * the form round-trips `code`, and that a charset rule belonged with a migration.
 * That precondition was then measured rather than assumed: a read-only audit of the
 * `coupons` collection found **1** document and it satisfies the pattern, so the
 * rule is safe to add now. The reason it could not be added earlier is kept here,
 * because it is still the reason to re-audit before ever tightening it further.
 *
 * The ceiling moves 60 -> 40 with the rule. Nothing in the collection exceeds 40
 * characters, and a coupon code is something a customer types, so the shorter
 * bound is the one that belongs in the contract.
 */
const couponCodeField = z
    .string()
    .transform((value) => value.trim().toUpperCase().replace(/\s+/g, ''))
    .pipe(
        z
            .string()
            .min(1, 'Coupon code is required')
            .regex(COUPON_CODE_PATTERN, COUPON_CODE_MESSAGE)
    );

/**
 * Coupon fields an admin may set. `usageCount` is absent on purpose — it is the
 * redemption counter, incremented by the redemption flow, never by a form.
 */
const couponFields = {
    code: couponCodeField,
    discountType: z.enum(DISCOUNT_TYPES),
    discountValue: nonNegativeNumberField,
    minimumOrderValue: nonNegativeNumberField.optional(),
    maximumDiscount: nonNegativeNumberField.optional(),
    appliesTo: z.enum(ELIGIBILITY_APPLIES_TO).optional(),
    productIds: z.array(objectIdField).optional(),
    categories: z.array(z.string()).optional(),
    startDate: dateField,
    expiryDate: dateField,
    totalUsageLimit: positiveIntegerField.optional(),
    perCustomerUsageLimit: positiveIntegerField.optional(),
    isActive: z.boolean().optional(),
};

/** `POST /api/admin/coupons`. */
export const createCouponSchema = z.object(couponFields);

/** `PUT /api/admin/coupons/:id` — partial patch, same reasoning as campaigns. */
export const updateCouponSchema = z.object({
    ...couponFields,
    code: couponCodeField.optional(),
    discountType: couponFields.discountType.optional(),
    discountValue: couponFields.discountValue.optional(),
    startDate: dateField.optional(),
    expiryDate: dateField.optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
