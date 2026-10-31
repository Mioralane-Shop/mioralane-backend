import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
  createAdminHeroSlide,
  deleteAdminHeroSlide,
  listAdminHeroSlides,
  listPublicHeroSlides,
  reorderAdminHeroSlides,
  updateAdminHeroSlide,
} from './hero-slide.controller';
import {
  createHeroSlideSchema,
  reorderHeroSlidesSchema,
  updateHeroSlideSchema,
} from './hero-slide.schemas';

export const heroSlidePublicRoutes = Router();
export const adminHeroSlideRoutes = Router();

// Public: consumed by the homepage hero slider.
heroSlidePublicRoutes.get('/', listPublicHeroSlides as RequestHandler);

// Admin: every route on this router is admin-only.
adminHeroSlideRoutes.use(...adminGuard);

adminHeroSlideRoutes.get('/', listAdminHeroSlides as RequestHandler);

/**
 * ⚠️ ORDER MATTERS: `/reorder` is registered BEFORE `/:id`.
 *
 * Express matches in registration order, so with `/:id` first a PATCH to
 * `/reorder` would bind `id = 'reorder'`, which the param schema then refuses —
 * making the route permanently unreachable rather than obviously broken.
 */
adminHeroSlideRoutes.patch(
  '/reorder',
  validate({ body: reorderHeroSlidesSchema }),
  reorderAdminHeroSlides as RequestHandler
);

adminHeroSlideRoutes.post(
  '/',
  validate({ body: createHeroSlideSchema }),
  createAdminHeroSlide as RequestHandler
);

adminHeroSlideRoutes.patch(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid hero slide ID' }),
  validate({ body: updateHeroSlideSchema }),
  updateAdminHeroSlide as RequestHandler
);

adminHeroSlideRoutes.delete(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid hero slide ID' }),
  deleteAdminHeroSlide as RequestHandler
);

export default adminHeroSlideRoutes;
