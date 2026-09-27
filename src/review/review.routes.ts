import { Router, RequestHandler } from 'express';
import { protect } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
    createReview,
    getMyReviewEligibility,
    getMyReviews,
    getProductReviewList,
} from './review.controller';
import { createReviewSchema } from './review.schemas';

const router = Router();

// Public — approved reviews only
router.get('/product/:productId', getProductReviewList as RequestHandler);

// Authenticated customer flow
router.post(
    '/',
    protect as RequestHandler,
    validate({ body: createReviewSchema }),
    createReview as RequestHandler
);
router.get('/me', protect as RequestHandler, getMyReviews as RequestHandler);
router.get(
    '/eligibility/:productId',
    protect as RequestHandler,
    getMyReviewEligibility as RequestHandler
);

export default router;
