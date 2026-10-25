import { RequestHandler, Router } from 'express';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
    createMyAddress,
    deleteMyAddress,
    getMyAddress,
    listMyAddresses,
    setMyDefaultAddress,
    updateMyAddress,
} from './address.controller';
import { createAddressSchema, updateAddressSchema } from './address.schemas';
import { requireTurnstile } from '../turnstile/turnstile.middleware';
import { objectIdParam } from '../utils/validation';

const router = Router();

// Every address route is customer-scoped — ownership is enforced in the service
// layer by always filtering on the authenticated user id.
router.get('/', protect as RequestHandler, listMyAddresses as RequestHandler);
router.post(
    '/',
    protect as RequestHandler,
    validate({ body: createAddressSchema }),
    requireTurnstile,
    createMyAddress as RequestHandler
);
/*
 * Every `:id` on this router is an ObjectId. The param schema refuses a malformed
 * one before the handler runs (P1.6.1), and `message` reproduces the wording the
 * service already returned (`invalidAddressIdError`), so no client sees a changed
 * string. It stays AFTER the body schema so that a request wrong in both ways
 * still answers about the body, which is what it did before. The service's own
 * check remains — dropping either layer still refuses; see `objectIdParam`.
 */
router.get(
    '/:id',
    protect as RequestHandler,
    validate({ params: objectIdParam('id'), message: 'Invalid address ID' }),
    getMyAddress as RequestHandler
);
router.patch(
    '/:id',
    protect as RequestHandler,
    validate({ body: updateAddressSchema }),
    validate({ params: objectIdParam('id'), message: 'Invalid address ID' }),
    updateMyAddress as RequestHandler
);
router.delete(
    '/:id',
    protect as RequestHandler,
    validate({ params: objectIdParam('id'), message: 'Invalid address ID' }),
    deleteMyAddress as RequestHandler
);
router.patch(
    '/:id/default',
    protect as RequestHandler,
    validate({ params: objectIdParam('id'), message: 'Invalid address ID' }),
    setMyDefaultAddress as RequestHandler
);

export default router;
