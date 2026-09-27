import { z } from 'zod';
import { numericField } from '../utils/validation';

/**
 * Body of `PUT /api/admin/settings/shipping` (the shipping singleton).
 *
 * SHAPE: three FIXED delivery zones (not an array) plus two nested groups. Each zone
 * carries `{ enabled, charge, estimatedMinDays, estimatedMaxDays }`. `charge` is the
 * money the storefront charges for delivery, so a bad write here mis-prices every
 * order — hence the ranges below sit at the edge *and* remain in the validator.
 *
 * EVERY FIELD IS OPTIONAL, including inside each zone: `normalizeZoneSettingsPayload`
 * merges each zone over `DEFAULT_SHIPPING_SETTINGS`, so
 * `{ zones: { inside_dhaka: { charge: 100 } } }` is a valid partial today and must
 * stay valid.
 *
 * WHAT STAYS IN THE SERVICE: all three cross-field rules —
 *  - `estimatedMinDays <= estimatedMaxDays` per zone,
 *  - `minimumOrderValue >= 0` when free delivery is enabled,
 *  - the `Number(...)`-produced finite check.
 * They are evaluated **after** the per-zone fallbacks are applied, so for a partial
 * payload Zod does not know the values being compared and cannot evaluate them.
 */
const zoneField = z.object({
    enabled: z.boolean().optional(),
    charge: numericField(z.coerce.number().min(0)).optional(),
    estimatedMinDays: numericField(z.coerce.number().min(0)).optional(),
    estimatedMaxDays: numericField(z.coerce.number().min(0)).optional(),
});

export const shippingSettingsSchema = z.object({
    zones: z
        .object({
            inside_dhaka: zoneField.optional(),
            dhaka_suburban: zoneField.optional(),
            outside_dhaka: zoneField.optional(),
        })
        .optional(),
    freeDeliveryThreshold: z
        .object({
            enabled: z.boolean().optional(),
            minimumOrderValue: numericField(z.coerce.number().min(0)).optional(),
        })
        .optional(),
    addressRequirements: z
        .object({
            landmarkRequired: z.boolean().optional(),
        })
        .optional(),
});

export type ShippingSettingsInput = z.infer<typeof shippingSettingsSchema>;
