import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import {
  createProduct,
  deleteProduct,
  getCartRecommendations,
  getProducts,
  getProductByIdOrSlug,
  markPreOrderArrived,
  updateProduct,
} from './product.controller';

const router = Router();

// Public routes
router.get('/', getProducts as RequestHandler);
router.post('/recommendations/cart', getCartRecommendations as RequestHandler);
router.get('/:idOrSlug', getProductByIdOrSlug as RequestHandler);

// Admin-only routes. This router also serves public GETs, so the guard is
// applied per route — a router-level `use` would lock out the storefront.
router.post('/', ...adminGuard, createProduct as RequestHandler);

router.put('/:id', ...adminGuard, updateProduct as RequestHandler);

router.patch('/:id/pre-order/arrive', ...adminGuard, markPreOrderArrived as RequestHandler);

router.delete('/:id', ...adminGuard, deleteProduct as RequestHandler);

export default router;
