import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import { getAdminCustomerById, getAdminCustomers } from './admin-customer.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminCustomers as RequestHandler);
// A malformed `:id` is refused before the handler runs; 'Invalid customer ID' is
// the wording the handler's own guard returns, kept verbatim (P1.6.1).
router.get(
  '/:id',
  validate({ params: objectIdParam('id'), message: 'Invalid customer ID' }),
  getAdminCustomerById as RequestHandler
);

export default router;
