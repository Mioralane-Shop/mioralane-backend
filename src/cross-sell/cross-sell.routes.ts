import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  getAdminCrossSellSettings,
  updateAdminCrossSellSettings,
} from './cross-sell.controller';
import { crossSellSettingsSchema } from './cross-sell.schemas';

export const adminCrossSellSettingsRoutes = Router();

// Every route on this router is admin-only.
adminCrossSellSettingsRoutes.use(...adminGuard);

adminCrossSellSettingsRoutes.get('/cross-sell', getAdminCrossSellSettings as RequestHandler);
adminCrossSellSettingsRoutes.put(
  '/cross-sell',
  validate({ body: crossSellSettingsSchema }),
  updateAdminCrossSellSettings as RequestHandler
);
