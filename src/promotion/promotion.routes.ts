import { Router, RequestHandler } from 'express';
import { adminGuard, protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
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
import {
  createCampaignSchema,
  createCouponSchema,
  updateCampaignSchema,
  updateCouponSchema,
} from './promotion.schemas';
import { objectIdParam } from '../utils/validation';

export const promotionPublicRoutes = Router();
export const adminCampaignRoutes = Router();
export const adminCouponRoutes = Router();

promotionPublicRoutes.get('/active', getActivePromotion as RequestHandler);
promotionPublicRoutes.post('/validate', protect as RequestHandler, validatePromotion as RequestHandler);

// Every route on these routers is admin-only.
adminCampaignRoutes.use(...adminGuard);
adminCouponRoutes.use(...adminGuard);

adminCampaignRoutes.get('/', listCampaigns as RequestHandler);
// Campaign and coupon `:id` params are ObjectIds. `getParamId` + `isObjectId` in
// the controller already refused a malformed one with these exact messages; the
// param schema does it a layer earlier and keeps the wording (P1.6.1).
adminCampaignRoutes.get(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid campaign ID' }),
  getCampaign as RequestHandler
);
adminCampaignRoutes.post(
  '/',
  validate({ body: createCampaignSchema }),
  createCampaign as RequestHandler
);
adminCampaignRoutes.put(
  '/:id',
  validate({ body: updateCampaignSchema }),
  validate({ params: objectIdParam('id'), message: 'Invalid campaign ID' }),
  updateCampaign as RequestHandler
);
adminCampaignRoutes.delete(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid campaign ID' }),
  deleteCampaign as RequestHandler
);

adminCouponRoutes.get('/', listCoupons as RequestHandler);
adminCouponRoutes.get(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid coupon ID' }),
  getCoupon as RequestHandler
);
adminCouponRoutes.post(
  '/',
  validate({ body: createCouponSchema }),
  createCoupon as RequestHandler
);
adminCouponRoutes.put(
  '/:id',
  validate({ body: updateCouponSchema }),
  validate({ params: objectIdParam('id'), message: 'Invalid coupon ID' }),
  updateCoupon as RequestHandler
);
adminCouponRoutes.delete(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid coupon ID' }),
  deleteCoupon as RequestHandler
);
