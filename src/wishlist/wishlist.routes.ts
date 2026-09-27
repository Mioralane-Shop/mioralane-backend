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
// DELETE `/:itemId` is intentionally not body-validated. Its `:itemId` param and
// `?itemType` query still go through `readItemId` / `normalizeWishlistItemType`;
// param validation is deferred to the dedicated sweep (see P0-3.5 §3.5).
router.delete('/:itemId', protect as RequestHandler, removeFromWishlist as RequestHandler);

export default router;
