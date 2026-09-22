import { Router, RequestHandler } from 'express';
import { adminGuard, protect } from '../middleware/auth.middleware';
import {
  createCampaign,
  createCoupon,
  deleteCampaign,
  deleteCoupon,
  getCampaign,
  getCoupon,
  listCampaigns,
  listCoupons,
  updateCampaign,
  updateCoupon,
} from './promotion-admin.controller';
import { getActivePromotion, validatePromotion } from './promotion-public.controller';

export const promotionPublicRoutes = Router();
export const adminCampaignRoutes = Router();
export const adminCouponRoutes = Router();

promotionPublicRoutes.get('/active', getActivePromotion as RequestHandler);
promotionPublicRoutes.post('/validate', protect as RequestHandler, validatePromotion as RequestHandler);

// Every route on these routers is admin-only.
adminCampaignRoutes.use(...adminGuard);
adminCouponRoutes.use(...adminGuard);

adminCampaignRoutes.get('/', listCampaigns as RequestHandler);
adminCampaignRoutes.get('/:id', getCampaign as RequestHandler);
adminCampaignRoutes.post('/', createCampaign as RequestHandler);
adminCampaignRoutes.put('/:id', updateCampaign as RequestHandler);
adminCampaignRoutes.delete('/:id', deleteCampaign as RequestHandler);

adminCouponRoutes.get('/', listCoupons as RequestHandler);
adminCouponRoutes.get('/:id', getCoupon as RequestHandler);
adminCouponRoutes.post('/', createCoupon as RequestHandler);
adminCouponRoutes.put('/:id', updateCoupon as RequestHandler);
adminCouponRoutes.delete('/:id', deleteCoupon as RequestHandler);
