import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
    getAdminReviewDetail,
    getAdminReviewList,
    updateAdminReviewStatus,
} from './admin-review.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminReviewList as RequestHandler);
// `getAdminReview` / `moderateReview` refuse a malformed id with 'Invalid review
// ID'; the param schema does it one layer earlier with that same wording (P1.6.1).
router.get(
    '/:id',
    validate({ params: objectIdParam('id'), message: 'Invalid review ID' }),
    getAdminReviewDetail as RequestHandler
);
router.patch(
    '/:id/status',
    validate({ params: objectIdParam('id'), message: 'Invalid review ID' }),
    updateAdminReviewStatus as RequestHandler
);

export default router;
