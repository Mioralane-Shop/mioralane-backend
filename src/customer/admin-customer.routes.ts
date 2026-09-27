import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { getAdminCustomerById, getAdminCustomers } from './admin-customer.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminCustomers as RequestHandler);
router.get('/:id', getAdminCustomerById as RequestHandler);

export default router;
