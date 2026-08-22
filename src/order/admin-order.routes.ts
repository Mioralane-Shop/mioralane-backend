import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
  getAdminOrderById,
  getAdminOrders,
  updateAdminOrderStatus,
} from './admin-order.controller';

const router = Router();

router.get('/', protect as RequestHandler, adminOnly as RequestHandler, getAdminOrders as RequestHandler);
router.get(
  '/:id',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  getAdminOrderById as RequestHandler
);
router.patch(
  '/:id/status',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  updateAdminOrderStatus as RequestHandler
);

export default router;
