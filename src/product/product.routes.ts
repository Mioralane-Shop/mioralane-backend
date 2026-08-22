import { Router, RequestHandler } from 'express';
import { protect, adminOnly } from '../middleware/auth.middleware';
import {
  createProduct,
  deleteProduct,
  getProducts,
  getProductByIdOrSlug,
  updateProduct,
} from './product.controller';

const router = Router();

// Public routes
router.get('/', getProducts as RequestHandler);
router.get('/:idOrSlug', getProductByIdOrSlug as RequestHandler);

// Admin-only routes
router.post(
  '/',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  createProduct as RequestHandler
);

router.put(
  '/:id',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  updateProduct as RequestHandler
);

router.delete(
  '/:id',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  deleteProduct as RequestHandler
);

export default router;
