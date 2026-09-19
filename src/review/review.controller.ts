import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
    getCustomerReviews,
    getProductReviews,
    getReviewEligibility,
    submitReview,
} from './review.service';

const respondWithError = (
    res: Response,
    error: unknown,
    fallbackMessage: string,
    fallbackCode: string
): void => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
        success: false,
        message: err.message ?? fallbackMessage,
        code: err.code ?? fallbackCode,
    });
};

export const createReview = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const review = await submitReview(req.user.id, req.body);
        res.status(201).json({ success: true, review });
    } catch (error) {
        respondWithError(res, error, 'Unable to submit review', 'review_submit_failed');
    }
};

export const getMyReviews = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const reviews = await getCustomerReviews(req.user.id);
        res.status(200).json({ success: true, reviews });
    } catch (error) {
        respondWithError(res, error, 'Unable to load your reviews', 'review_history_failed');
    }
};

export const getMyReviewEligibility = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const eligibility = await getReviewEligibility(req.user.id, req.params.productId);
        res.status(200).json({ success: true, eligibility });
    } catch (error) {
        respondWithError(res, error, 'Unable to check review eligibility', 'review_eligibility_failed');
    }
};

export const getProductReviewList = async (req: Request, res: Response): Promise<void> => {
    try {
        const result = await getProductReviews(req.params.productId, {
            sort: req.query.sort,
            page: req.query.page,
            limit: req.query.limit,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        respondWithError(res, error, 'Unable to load reviews', 'review_list_failed');
    }
};
