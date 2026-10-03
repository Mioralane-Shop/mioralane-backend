import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
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
// The handler refuses a malformed id with 'Invalid order ID'; the param schema
// does it first, with that same wording, so the response is unchanged (P1.6.1).
router.get(
  '/:id',
  protect as RequestHandler,
  validate({ params: objectIdParam('id'), message: 'Invalid order ID' }),
  getOrderById as RequestHandler
);

export default router;
