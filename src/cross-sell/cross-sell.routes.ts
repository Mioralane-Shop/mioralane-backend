import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
  getAdminCrossSellSettings,
  updateAdminCrossSellSettings,
} from './cross-sell.controller';

export const adminCrossSellSettingsRoutes = Router();

adminCrossSellSettingsRoutes.get(
  '/cross-sell',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  getAdminCrossSellSettings as RequestHandler
);

adminCrossSellSettingsRoutes.put(
  '/cross-sell',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  updateAdminCrossSellSettings as RequestHandler
);
