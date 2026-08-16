import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { getWishlist, toggleWishlist } from './wishlist.controller';

const router = Router();

router.get('/', protect as RequestHandler, getWishlist as RequestHandler);
router.post('/', protect as RequestHandler, toggleWishlist as RequestHandler);
router.post('/toggle', protect as RequestHandler, toggleWishlist as RequestHandler);

export default router;
