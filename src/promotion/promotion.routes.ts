import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
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

adminCampaignRoutes.get('/', protect as RequestHandler, adminOnly as RequestHandler, listCampaigns as RequestHandler);
adminCampaignRoutes.get('/:id', protect as RequestHandler, adminOnly as RequestHandler, getCampaign as RequestHandler);
adminCampaignRoutes.post('/', protect as RequestHandler, adminOnly as RequestHandler, createCampaign as RequestHandler);
adminCampaignRoutes.put('/:id', protect as RequestHandler, adminOnly as RequestHandler, updateCampaign as RequestHandler);
adminCampaignRoutes.delete('/:id', protect as RequestHandler, adminOnly as RequestHandler, deleteCampaign as RequestHandler);

adminCouponRoutes.get('/', protect as RequestHandler, adminOnly as RequestHandler, listCoupons as RequestHandler);
adminCouponRoutes.get('/:id', protect as RequestHandler, adminOnly as RequestHandler, getCoupon as RequestHandler);
adminCouponRoutes.post('/', protect as RequestHandler, adminOnly as RequestHandler, createCoupon as RequestHandler);
adminCouponRoutes.put('/:id', protect as RequestHandler, adminOnly as RequestHandler, updateCoupon as RequestHandler);
adminCouponRoutes.delete('/:id', protect as RequestHandler, adminOnly as RequestHandler, deleteCoupon as RequestHandler);
