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
adminInventoryRoutes.get('/transactions/:id', getInventoryTransaction as RequestHandler);

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

adminInventoryRoutes.get('/:itemType/:itemId/history', getInventoryItemHistory as RequestHandler);
