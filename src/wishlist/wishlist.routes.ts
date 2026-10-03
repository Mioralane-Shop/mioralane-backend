import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
    addToWishlist,
    getWishlist,
    removeFromWishlist,
    toggleWishlist,
} from './wishlist.controller';
import { addToWishlistSchema } from './wishlist.schemas';
import { objectIdParam } from '../utils/validation';

const router = Router();

router.get('/', protect as RequestHandler, getWishlist as RequestHandler);
router.post(
    '/',
    protect as RequestHandler,
    validate({ body: addToWishlistSchema }),
    addToWishlist as RequestHandler
);
// Toggle reads the same target payload as add, so it reuses the schema.
router.post(
    '/toggle',
    protect as RequestHandler,
    validate({ body: addToWishlistSchema }),
    toggleWishlist as RequestHandler
);
// DELETE `/:itemId` carries no body. Its param is an ObjectId and is now refused a
// layer earlier (P1.6.1, closing the P0-3.5 §3.5 deferral); `?itemType` still goes
// through `normalizeWishlistItemType` in the handler, and `readItemId` keeps its own
// check, so the wording 'A valid itemId is required' is unchanged.
router.delete(
    '/:itemId',
    protect as RequestHandler,
    validate({ params: objectIdParam('itemId'), message: 'A valid itemId is required' }),
    removeFromWishlist as RequestHandler
);

export default router;
