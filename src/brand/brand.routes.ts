import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
  createAdminBrand,
  deleteAdminBrand,
  getAdminBrand,
  listAdminBrands,
  listMarqueeBrandsHandler,
  listPublicBrands,
  reorderAdminBrands,
  updateAdminBrand,
} from './brand.controller';
import { createBrandSchema, reorderBrandsSchema, updateBrandSchema } from './brand.schemas';

export const brandPublicRoutes = Router();
export const adminBrandRoutes = Router();

// Public: consumed by the storefront navbar and the homepage marquee.
brandPublicRoutes.get('/', listPublicBrands as RequestHandler);
brandPublicRoutes.get('/marquee', listMarqueeBrandsHandler as RequestHandler);

// Admin: every route on this router is admin-only.
adminBrandRoutes.use(...adminGuard);

adminBrandRoutes.get('/', listAdminBrands as RequestHandler);

/**
 * ⚠️ ORDER MATTERS: `/reorder` is registered BEFORE `/:id`.
 *
 * Express matches in registration order, so with `/:id` first a PATCH to
 * `/reorder` binds `id = 'reorder'` — which the param schema then refuses with
 * "Invalid brand ID", making the route permanently unreachable rather than
 * obviously broken. `readonly` here is a `Router`, not an array, so this cannot
 * be enforced by types; the harness asserts the registration order instead.
 */
adminBrandRoutes.patch(
  '/reorder',
  validate({ body: reorderBrandsSchema }),
  reorderAdminBrands as RequestHandler
);

adminBrandRoutes.post(
  '/',
  validate({ body: createBrandSchema }),
  createAdminBrand as RequestHandler
);

adminBrandRoutes.get(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid brand ID' }),
  getAdminBrand as RequestHandler
);

adminBrandRoutes.patch(
  '/:id',
  validate({ body: updateBrandSchema }),
  validate({ params: objectIdParam('id'), message: 'Invalid brand ID' }),
  updateAdminBrand as RequestHandler
);

adminBrandRoutes.delete(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid brand ID' }),
  deleteAdminBrand as RequestHandler
);
