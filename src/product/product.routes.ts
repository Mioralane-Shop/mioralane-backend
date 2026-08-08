import { Router, RequestHandler } from 'express';
import { protect, adminOnly, AuthenticatedRequest } from '../middleware/auth.middleware';
import { createProduct, getProducts, getProductByIdOrSlug } from './product.controller';

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

export default router;
