import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
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

export const adminInventorySettingsRoutes = Router();

// Every route on this router is admin-only.
adminInventorySettingsRoutes.use(...adminGuard);

adminInventorySettingsRoutes.get('/inventory', getAdminInventorySettings as RequestHandler);
adminInventorySettingsRoutes.put('/inventory', updateAdminInventorySettings as RequestHandler);

/** Inventory ledger + manual stock operations (mounted on /api/admin/inventory). */
export const adminInventoryRoutes = Router();

// Every route on this router is admin-only.
adminInventoryRoutes.use(...adminGuard);

adminInventoryRoutes.get('/transactions', listInventoryTransactionHistory as RequestHandler);
adminInventoryRoutes.get('/transactions/:id', getInventoryTransaction as RequestHandler);

adminInventoryRoutes.post('/stock-in', stockInInventoryItem as RequestHandler);
adminInventoryRoutes.post('/restock', restockInventoryItem as RequestHandler);
adminInventoryRoutes.post('/stock-out', stockOutInventoryItem as RequestHandler);
adminInventoryRoutes.post('/adjust', adjustInventoryItem as RequestHandler);
adminInventoryRoutes.post('/damaged', markInventoryDamaged as RequestHandler);
adminInventoryRoutes.post('/lost', markInventoryLost as RequestHandler);

adminInventoryRoutes.get('/:itemType/:itemId/history', getInventoryItemHistory as RequestHandler);
