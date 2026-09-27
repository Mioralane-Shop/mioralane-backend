import { z } from 'zod';
import { numericField } from '../utils/validation';

/**
 * Body of `PUT /api/admin/settings/inventory` — the inventory-settings singleton.
 *
 * Kept separate from `inventory.schemas.ts`, which covers the six manual stock
 * operations on `/api/admin/inventory/*` (`inventoryOperationSchema`).
 *
 * `defaultLowStockThreshold` is **required**: `upsertInventorySettings` calls
 * `validateLowStockThreshold(candidate?.defaultLowStockThreshold)`, and `undefined`
 * fails its `typeof parsed !== 'number'` guard, so the endpoint has always answered
 * 400 when the field is absent. Requiring it here relocates that rule rather than
 * inventing one — `numericField` keeps the old `Number()` coercion, so a numeric
 * string still works exactly as before.
 *
 * The value drives the low-stock alerting on the dashboard and inventory pages, which
 * is why the service keeps `validateLowStockThreshold` as its own guard too.
 */
export const inventorySettingsSchema = z.object({
    defaultLowStockThreshold: numericField(z.coerce.number().int().min(0)),
});

export type InventorySettingsInput = z.infer<typeof inventorySettingsSchema>;
