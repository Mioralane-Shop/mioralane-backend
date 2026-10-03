import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  adjustInventoryItem,
  getAdminInventorySettings,
  getInventoryItemHistory,
  getInventoryTransaction,
  listInventoryTransactionHistory,
  markInventoryDamaged,
  markInventoryLost,
  restockInventoryItem,
  stockInInventoryItem,
  stockOutInventoryItem,
  updateAdminInventorySettings,
} from './inventory.controller';
import { inventoryOperationSchema } from './inventory.schemas';
import { inventorySettingsSchema } from './inventory-settings.schemas';
import { objectIdParam } from '../utils/validation';

export const adminInventorySettingsRoutes = Router();

// Every route on this router is admin-only.
adminInventorySettingsRoutes.use(...adminGuard);

adminInventorySettingsRoutes.get('/inventory', getAdminInventorySettings as RequestHandler);
adminInventorySettingsRoutes.put(
  '/inventory',
  validate({ body: inventorySettingsSchema }),
  updateAdminInventorySettings as RequestHandler
);

/** Inventory ledger + manual stock operations (mounted on /api/admin/inventory). */
export const adminInventoryRoutes = Router();

// Every route on this router is admin-only.
adminInventoryRoutes.use(...adminGuard);

adminInventoryRoutes.get('/transactions', listInventoryTransactionHistory as RequestHandler);
// `:id` is a ledger-entry ObjectId; `getInventoryTransactionById` refuses a
// malformed one with 'A valid transactionId is required', reproduced verbatim.
adminInventoryRoutes.get(
  '/transactions/:id',
  validate({ params: objectIdParam('id'), message: 'A valid transactionId is required' }),
  getInventoryTransaction as RequestHandler
);

adminInventoryRoutes.post(
  '/stock-in',
  validate({ body: inventoryOperationSchema }),
  stockInInventoryItem as RequestHandler
);
adminInventoryRoutes.post(
  '/restock',
  validate({ body: inventoryOperationSchema }),
  restockInventoryItem as RequestHandler
);
adminInventoryRoutes.post(
  '/stock-out',
  validate({ body: inventoryOperationSchema }),
  stockOutInventoryItem as RequestHandler
);
adminInventoryRoutes.post(
  '/adjust',
  validate({ body: inventoryOperationSchema }),
  adjustInventoryItem as RequestHandler
);
adminInventoryRoutes.post(
  '/damaged',
  validate({ body: inventoryOperationSchema }),
  markInventoryDamaged as RequestHandler
);
adminInventoryRoutes.post(
  '/lost',
  validate({ body: inventoryOperationSchema }),
  markInventoryLost as RequestHandler
);

// `:itemType` is declared alongside `:itemId` because `validate()` REPLACES
// `req.params` — leaving it out would drop it and silently turn every request into
// a lookup for the default item type. It is a plain string on purpose: the
// controller normalises it (`normalizeInventoryItemType`).
adminInventoryRoutes.get(
  '/:itemType/:itemId/history',
  validate({
    params: objectIdParam('itemId', ['itemType']),
    message: 'A valid itemId is required',
  }),
  getInventoryItemHistory as RequestHandler
);
