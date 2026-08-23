import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import { getAdminCustomerById, getAdminCustomers } from './admin-customer.controller';

const router = Router();

router.get(
  '/',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  getAdminCustomers as RequestHandler
);
router.get(
  '/:id',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  getAdminCustomerById as RequestHandler
);

export default router;
