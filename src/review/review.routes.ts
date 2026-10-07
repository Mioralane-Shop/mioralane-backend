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
import { requireTurnstile } from '../turnstile/turnstile.middleware';
import { objectIdParam } from '../utils/validation';

const router = Router();

// Public — approved reviews only. `:productId` is an ObjectId; the service refuses
// a malformed one with 'Invalid product ID', which `message` reproduces (P1.6.1).
router.get(
    '/product/:productId',
    validate({ params: objectIdParam('productId'), message: 'Invalid product ID' }),
    getProductReviewList as RequestHandler
);

// Authenticated customer flow
router.post(
    '/',
    protect as RequestHandler,
    validate({ body: createReviewSchema }),
    requireTurnstile,
    createReview as RequestHandler
);
router.get('/me', protect as RequestHandler, getMyReviews as RequestHandler);
router.get(
    '/eligibility/:productId',
    protect as RequestHandler,
    validate({ params: objectIdParam('productId'), message: 'Invalid product ID' }),
    getMyReviewEligibility as RequestHandler
);

export default router;
