import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
  getAdminInventorySettings,
  updateAdminInventorySettings,
} from './inventory.controller';

export const adminInventorySettingsRoutes = Router();

adminInventorySettingsRoutes.get('/inventory', protect as RequestHandler, adminOnly as RequestHandler, getAdminInventorySettings as RequestHandler);
adminInventorySettingsRoutes.put('/inventory', protect as RequestHandler, adminOnly as RequestHandler, updateAdminInventorySettings as RequestHandler);
