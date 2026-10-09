import { z } from 'zod';
import { numericField } from '../utils/validation';
import {
    MAX_MEGA_MENU_GROUP_LENGTH,
    MAX_MEGA_MENU_ITEMS_PER_TAB,
    MAX_MEGA_MENU_ITEM_LABEL_LENGTH,
    MAX_MEGA_MENU_MAX_ITEMS,
    MAX_MEGA_MENU_TARGET_VALUE_LENGTH,
    MEGA_MENU_TAB_IDS,
    MEGA_MENU_TARGET_KINDS,
} from './mega-menu-settings.model';

/**
 * Body of `PUT /api/admin/mega-menu` (the mega menu singleton).
 *
 * EVERY FIELD IS OPTIONAL and `normalizeMegaMenuPayload` falls back to the seeded
 * defaults for anything absent, so a partial payload is a supported upsert — the
 * same contract as the announcement bar and cross-sell singletons. Nothing here
 * is `.min(1)` on the item list: an empty catalog-of-links is a valid edit, and a
 * blank item row is dropped by the service rather than rejected at the edge.
 *
 * WHAT STAYS IN THE SERVICE, and why Zod cannot take it:
 *  - dropping item rows whose `label` is blank (they are valid input, not errors);
 *  - filling in a missing `id` by slugifying the label, de-duplicated per tab;
 *  - merging with the seeded tabs so a payload that omits a tab cannot empty the
 *    storefront menu.
 *
 * The enums and the length bounds are imported from the model, which is the
 * source of truth, so the two cannot drift.
 */

const targetSchema = z.object({
    kind: z.enum(MEGA_MENU_TARGET_KINDS),
    value: z
        .string()
        .trim()
        .min(1, 'Item destination is required')
        .max(
            MAX_MEGA_MENU_TARGET_VALUE_LENGTH,
            `Item destination must be ${MAX_MEGA_MENU_TARGET_VALUE_LENGTH} characters or fewer`
        ),
});

const itemSchema = z.object({
    /** Optional: the service derives one from the label when absent. */
    id: z.string().trim().max(MAX_MEGA_MENU_ITEM_LABEL_LENGTH).optional(),
    /** Deliberately not `min(1)` — blank rows are dropped by the service. */
    label: z
        .string()
        .trim()
        .max(
            MAX_MEGA_MENU_ITEM_LABEL_LENGTH,
            `Item label must be ${MAX_MEGA_MENU_ITEM_LABEL_LENGTH} characters or fewer`
        )
        .optional(),
    target: targetSchema.optional(),
    group: z
        .string()
        .trim()
        .max(MAX_MEGA_MENU_GROUP_LENGTH, `Group label must be ${MAX_MEGA_MENU_GROUP_LENGTH} characters or fewer`)
        .optional(),
    visible: z.boolean().optional(),
});

const tabSchema = z.object({
    id: z.enum(MEGA_MENU_TAB_IDS),
    label: z
        .string()
        .trim()
        .max(MAX_MEGA_MENU_ITEM_LABEL_LENGTH, `Tab label must be ${MAX_MEGA_MENU_ITEM_LABEL_LENGTH} characters or fewer`)
        .optional(),
    maxItems: numericField(z.coerce.number().int().min(1).max(MAX_MEGA_MENU_MAX_ITEMS)).optional(),
    grouped: z.boolean().optional(),
    items: z
        .array(itemSchema)
        .max(
            MAX_MEGA_MENU_ITEMS_PER_TAB,
            `A tab can hold at most ${MAX_MEGA_MENU_ITEMS_PER_TAB} items`
        )
        .optional(),
});

export const megaMenuSettingsSchema = z.object({
    tabs: z.array(tabSchema).max(MEGA_MENU_TAB_IDS.length).optional(),
});

export type MegaMenuSettingsInput = z.infer<typeof megaMenuSettingsSchema>;
