import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createOrderSchema } from './order.schemas';
import { createOrder, getMyOrders, getOrderById } from './order.controller';

const router = Router();

// `protect` runs first so the controller has req.user; validation runs before the
// controller, which casts req.body to the schema's inferred type.
router.post(
  '/',
  protect as RequestHandler,
  validate({ body: createOrderSchema }),
  createOrder as RequestHandler
);
router.get('/', protect as RequestHandler, getMyOrders as RequestHandler);
router.get('/:id', protect as RequestHandler, getOrderById as RequestHandler);

export default router;
