import { RequestHandler, Router } from 'express';
import { protect } from '../middleware/auth.middleware';
import {
    createMyAddress,
    deleteMyAddress,
    getMyAddress,
    listMyAddresses,
    setMyDefaultAddress,
    updateMyAddress,
} from './address.controller';

const router = Router();

// Every address route is customer-scoped — ownership is enforced in the service
// layer by always filtering on the authenticated user id.
router.get('/', protect as RequestHandler, listMyAddresses as RequestHandler);
router.post('/', protect as RequestHandler, createMyAddress as RequestHandler);
router.get('/:id', protect as RequestHandler, getMyAddress as RequestHandler);
router.patch('/:id', protect as RequestHandler, updateMyAddress as RequestHandler);
router.delete('/:id', protect as RequestHandler, deleteMyAddress as RequestHandler);
router.patch('/:id/default', protect as RequestHandler, setMyDefaultAddress as RequestHandler);

export default router;
