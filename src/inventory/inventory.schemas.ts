import { z } from 'zod';
import { OBJECT_ID_PATTERN, optionalNumericField } from '../utils/validation';

/**
 * Sanity bound, not a business rule. The inventory service has no upper limit
 * today; this exists only so an absurd value (e.g. 1e308) can never reach a stock
 * `$inc`. It is orders of magnitude above any realistic movement, so a legitimate
 * restock should never hit it.
 */
export const MAX_STOCK_LEVEL = 1_000_000;

/** Same caps the service applies via `readOptionalString(input.reason, 300)`. */
export const MAX_INVENTORY_REASON_LENGTH = 300;
/** Same cap the service applies via `readOptionalString(input.note, 1000)`. */
export const MAX_INVENTORY_NOTE_LENGTH = 1000;

/**
 * Body shared by all six manual stock operations:
 * `/stock-in`, `/restock`, `/stock-out`, `/adjust`, `/damaged`, `/lost`.
 *
 * One schema rather than six near-identical ones: the client
 * (`inventory-action-dialog.tsx`) sends exactly this shape for every action, only
 * ever filling in `quantity` (delta actions) or `targetStock` (`adjust`). The two
 * numeric fields are therefore both optional here.
 *
 * Which of the two is REQUIRED is deliberately left to the service, because that
 * is a property of the transaction type, not of the payload shape:
 * `applyManualInventoryOperation` knows `MANUAL_ADJUSTMENT` needs `targetStock`
 * and everything else needs `quantity`, and it already answers with
 * "quantity is required" / "targetStock is required for a manual adjustment".
 * Encoding that here would duplicate the rule in a second place (and would turn
 * those two messages into the generic envelope for no security gain).
 *
 * Deliberately absent, so Zod's strip behaviour removes them from `req.body`:
 *  - `performedBy` / `actorId` / `actorRole`
 *      → always derived from `req.user`; a client must never be able to attribute
 *        a stock movement to another admin
 *  - `transactionType` / `direction` / `quantityChange` / `previousQuantity`
 *      → derived from the route (`INVENTORY_ACTION_TYPES`) and the ledger
 *  - `referenceType` / `referenceId`
 *      → reserved for the order-deduction and cancellation flows
 *  - `_id` / `id` / `createdAt`
 */
export const inventoryOperationSchema = z.object({
    itemType: z.enum(['product', 'combo']),
    // `.trim()` preserves the controller's existing `body.itemId.trim()` behaviour;
    // a padded id is accepted today, so rejecting it here would be a silent
    // tightening unrelated to this block.
    itemId: z.string().trim().regex(OBJECT_ID_PATTERN, 'A valid itemId is required'),
    quantity: optionalNumericField(
        z.coerce.number().int().positive().max(MAX_STOCK_LEVEL)
    ),
    targetStock: optionalNumericField(
        z.coerce.number().int().nonnegative().max(MAX_STOCK_LEVEL)
    ),
    // `.trim()` first so the length bound is measured the same way the service
    // measures it (it trims before slicing).
    reason: z.string().trim().max(MAX_INVENTORY_REASON_LENGTH).optional(),
    note: z.string().trim().max(MAX_INVENTORY_NOTE_LENGTH).optional(),
});

export type InventoryOperationInput = z.infer<typeof inventoryOperationSchema>;
