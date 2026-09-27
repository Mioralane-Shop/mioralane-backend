import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createProduct,
  deleteProduct,
  getCartRecommendations,
  getProducts,
  getProductByIdOrSlug,
  markPreOrderArrived,
  updateProduct,
} from './product.controller';
import {
  createProductSchema,
  productArrivalSchema,
  updateProductSchema,
} from './product.schemas';

const router = Router();

// Public routes
router.get('/', getProducts as RequestHandler);
router.post('/recommendations/cart', getCartRecommendations as RequestHandler);
router.get('/:idOrSlug', getProductByIdOrSlug as RequestHandler);

// Admin-only routes. This router also serves public GETs, so the guard is
// applied per route — a router-level `use` would lock out the storefront.
// `validate()` runs AFTER the guard on purpose: an unauthenticated caller should
// get 401 from the guard, not a 400 that reveals the body contract.
router.post('/', ...adminGuard, validate({ body: createProductSchema }), createProduct as RequestHandler);

router.put('/:id', ...adminGuard, validate({ body: updateProductSchema }), updateProduct as RequestHandler);

router.patch(
  '/:id/pre-order/arrive',
  ...adminGuard,
  validate({ body: productArrivalSchema }),
  markPreOrderArrived as RequestHandler
);

router.delete('/:id', ...adminGuard, deleteProduct as RequestHandler);

export default router;
