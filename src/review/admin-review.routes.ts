import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import {
    getAdminReviewDetail,
    getAdminReviewList,
    updateAdminReviewStatus,
} from './admin-review.controller';

const router = Router();

// Every route on this router is admin-only.
router.use(...adminGuard);

router.get('/', getAdminReviewList as RequestHandler);
router.get('/:id', getAdminReviewDetail as RequestHandler);
router.patch('/:id/status', updateAdminReviewStatus as RequestHandler);

export default router;
