import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
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

adminInventorySettingsRoutes.get('/inventory', protect as RequestHandler, adminOnly as RequestHandler, getAdminInventorySettings as RequestHandler);
adminInventorySettingsRoutes.put('/inventory', protect as RequestHandler, adminOnly as RequestHandler, updateAdminInventorySettings as RequestHandler);

/** Inventory ledger + manual stock operations (mounted on /api/admin/inventory). */
export const adminInventoryRoutes = Router();

const guard = [protect as RequestHandler, adminOnly as RequestHandler];

adminInventoryRoutes.get('/transactions', ...guard, listInventoryTransactionHistory as RequestHandler);
adminInventoryRoutes.get('/transactions/:id', ...guard, getInventoryTransaction as RequestHandler);

adminInventoryRoutes.post('/stock-in', ...guard, stockInInventoryItem as RequestHandler);
adminInventoryRoutes.post('/restock', ...guard, restockInventoryItem as RequestHandler);
adminInventoryRoutes.post('/stock-out', ...guard, stockOutInventoryItem as RequestHandler);
adminInventoryRoutes.post('/adjust', ...guard, adjustInventoryItem as RequestHandler);
adminInventoryRoutes.post('/damaged', ...guard, markInventoryDamaged as RequestHandler);
adminInventoryRoutes.post('/lost', ...guard, markInventoryLost as RequestHandler);

adminInventoryRoutes.get('/:itemType/:itemId/history', ...guard, getInventoryItemHistory as RequestHandler);
