import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
  getAdminOrderById,
  getAdminOrders,
  updateAdminOrderStatus,
} from './admin-order.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminOrders as RequestHandler);
// Both handlers check `mongoose.Types.ObjectId.isValid(id)` and answer 'Invalid
// order ID'; the param schema refuses first, with that same wording (P1.6.1).
// It runs before the handler's own `orderStatus` check, so a request with a
// malformed id still answers about the id exactly as it did before.
router.get(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid order ID' }),
  getAdminOrderById as RequestHandler
);
router.patch(
  '/:id/status',
  validate({ params: objectIdParam('id'), message: 'Invalid order ID' }),
  updateAdminOrderStatus as RequestHandler
);

export default router;
