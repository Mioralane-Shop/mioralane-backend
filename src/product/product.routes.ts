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
import { objectIdParam } from '../utils/validation';

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

router.put(
  '/:id',
  ...adminGuard,
  validate({ body: updateProductSchema }),
  validate({ params: objectIdParam('id'), message: 'Invalid product ID' }),
  updateProduct as RequestHandler
);

router.patch(
  '/:id/pre-order/arrive',
  ...adminGuard,
  validate({ body: productArrivalSchema }),
  validate({ params: objectIdParam('id'), message: 'Invalid product ID' }),
  markPreOrderArrived as RequestHandler
);

// Every admin route here takes an ObjectId `:id`. The param schema refuses a
// malformed one before the handler, with the wording the handler already used, and
// it is listed AFTER the body schema so a request wrong in both ways still answers
// about the body, as before (P1.6.1). `:idOrSlug` above is deliberately excluded —
// a slug is a valid value for that param, so it cannot use this schema.
router.delete(
  '/:id',
  ...adminGuard,
  validate({ params: objectIdParam('id'), message: 'Invalid product ID' }),
  deleteProduct as RequestHandler
);

export default router;
