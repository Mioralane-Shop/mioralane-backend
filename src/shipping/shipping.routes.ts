import { Router, RequestHandler } from 'express';
import { adminGuard, protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  getAdminShippingSettings,
  quoteShipping,
  updateAdminShippingSettings,
} from './shipping.controller';
import { shippingSettingsSchema } from './shipping.schemas';

export const shippingRoutes = Router();
export const adminShippingSettingsRoutes = Router();

shippingRoutes.post('/quote', protect as RequestHandler, quoteShipping as RequestHandler);

// Every route on this router is admin-only.
adminShippingSettingsRoutes.use(...adminGuard);

adminShippingSettingsRoutes.get('/shipping', getAdminShippingSettings as RequestHandler);
adminShippingSettingsRoutes.put(
  '/shipping',
  validate({ body: shippingSettingsSchema }),
  updateAdminShippingSettings as RequestHandler
);

