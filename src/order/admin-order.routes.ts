import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import {
  getAdminOrderById,
  getAdminOrders,
  updateAdminOrderStatus,
} from './admin-order.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminOrders as RequestHandler);
router.get('/:id', getAdminOrderById as RequestHandler);
router.patch('/:id/status', updateAdminOrderStatus as RequestHandler);

export default router;
