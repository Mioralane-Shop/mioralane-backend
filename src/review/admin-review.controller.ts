import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getAdminReview, listAdminReviews, moderateReview } from './review.service';
import { recordActivity } from '../activity-log/activity-log.service';

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

export const getAdminReviewList = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const result = await listAdminReviews({
            search: req.query.search,
            status: req.query.status,
            productId: req.query.productId,
            rating: req.query.rating,
            verified: req.query.verified,
            page: req.query.page,
            limit: req.query.limit,
        });
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        respondWithError(res, error, 'Unable to load reviews', 'admin_review_list_failed');
    }
};

export const getAdminReviewDetail = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const review = await getAdminReview(req.params.id);
        res.status(200).json({ success: true, review });
    } catch (error) {
        respondWithError(res, error, 'Unable to load review', 'admin_review_detail_failed');
    }
};

export const updateAdminReviewStatus = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const existing = await getAdminReview(req.params.id);
        const review = await moderateReview(req.params.id, (req.body ?? {}).status);

        await recordActivity(req, {
            action: 'STATUS_CHANGE',
            entityType: 'REVIEW',
            entityId: String(req.params.id),
            entityName: (existing as { product?: { title?: string } } | null)?.product?.title,
            description: `Changed review status from ${(existing as { status?: string } | null)?.status ?? 'unknown'} to ${(req.body ?? {}).status ?? 'unknown'}`,
            before: { status: (existing as { status?: string } | null)?.status ?? null },
            after: { status: (req.body ?? {}).status ?? null },
        });

        res.status(200).json({ success: true, review });
    } catch (error) {
        respondWithError(res, error, 'Unable to update review status', 'admin_review_update_failed');
    }
};
