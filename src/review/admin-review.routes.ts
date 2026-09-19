import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
    getAdminReviewDetail,
    getAdminReviewList,
    updateAdminReviewStatus,
} from './admin-review.controller';

const router = Router();

router.get('/', protect as RequestHandler, adminOnly as RequestHandler, getAdminReviewList as RequestHandler);
router.get(
    '/:id',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    getAdminReviewDetail as RequestHandler
);
router.patch(
    '/:id/status',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    updateAdminReviewStatus as RequestHandler
);

export default router;
