import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
  getAdminShippingSettings,
  quoteShipping,
  updateAdminShippingSettings,
} from './shipping.controller';

export const shippingRoutes = Router();
export const adminShippingSettingsRoutes = Router();

shippingRoutes.post('/quote', protect as RequestHandler, quoteShipping as RequestHandler);

adminShippingSettingsRoutes.get('/shipping', protect as RequestHandler, adminOnly as RequestHandler, getAdminShippingSettings as RequestHandler);
adminShippingSettingsRoutes.put('/shipping', protect as RequestHandler, adminOnly as RequestHandler, updateAdminShippingSettings as RequestHandler);

