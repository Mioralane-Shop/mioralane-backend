import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { createOrder, getMyOrders, getOrderById } from './order.controller';

const router = Router();

router.post('/', protect as RequestHandler, createOrder as RequestHandler);
router.get('/', protect as RequestHandler, getMyOrders as RequestHandler);
router.get('/:id', protect as RequestHandler, getOrderById as RequestHandler);

export default router;
