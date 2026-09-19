import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import {
    addToWishlist,
    getWishlist,
    removeFromWishlist,
    toggleWishlist,
} from './wishlist.controller';

const router = Router();

router.get('/', protect as RequestHandler, getWishlist as RequestHandler);
router.post('/', protect as RequestHandler, addToWishlist as RequestHandler);
router.post('/toggle', protect as RequestHandler, toggleWishlist as RequestHandler);
router.delete('/:itemId', protect as RequestHandler, removeFromWishlist as RequestHandler);

export default router;
