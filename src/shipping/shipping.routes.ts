import { Router, RequestHandler } from 'express';
import { adminGuard, protect } from '../middleware/auth.middleware';
import {
  getAdminShippingSettings,
  quoteShipping,
  updateAdminShippingSettings,
} from './shipping.controller';

export const shippingRoutes = Router();
export const adminShippingSettingsRoutes = Router();

shippingRoutes.post('/quote', protect as RequestHandler, quoteShipping as RequestHandler);

// Every route on this router is admin-only.
adminShippingSettingsRoutes.use(...adminGuard);

adminShippingSettingsRoutes.get('/shipping', getAdminShippingSettings as RequestHandler);
adminShippingSettingsRoutes.put('/shipping', updateAdminShippingSettings as RequestHandler);

