import mongoose from 'mongoose';
import { Product } from '../product/product.model';
import { Order } from '../order/order.model';
import { UserModel } from '../auth/user.model';
import { OrderStatus } from '../enums/order-status.enum';
// Review images are temporarily disabled.
// import type { MediaAsset } from '../media/media.types';
import { Review, ReviewStatus } from './review.model';

type HttpError = Error & { statusCode?: number; code?: string };

export type ReviewSort = 'newest' | 'highest' | 'lowest' | 'verified';

export const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected'];
export const REVIEW_SORTS: ReviewSort[] = ['newest', 'highest', 'lowest', 'verified'];

// Review images are temporarily disabled.
// const REVIEW_IMAGE_LIMIT = 3;
// const REVIEW_IMAGE_FOLDER_PATH = '/mioralane/reviews/';
const MAX_REVIEW_LENGTH = 2000;
const MIN_REVIEW_LENGTH = 3;
const MAX_PAGE_SIZE = 50;

// Review images are temporarily disabled — restore this helper to re-enable review images.
// /**
//  * Review images must come from our own ImageKit review folder. This prevents a
//  * client from attaching arbitrary/unrelated media references to a review.
//  */
// const isReviewImageUrl = (url: string): boolean => {
//     const endpoint = (process.env.IMAGEKIT_URL_ENDPOINT ?? '').trim().replace(/\/$/, '');
//
//     if (!url.includes(REVIEW_IMAGE_FOLDER_PATH)) {
//         return false;
//     }
//
//     if (!endpoint) {
//         return true;
//     }
//
//     return url.startsWith(endpoint);
// };

export const createReviewError = (
    statusCode: number,
    message: string,
    code?: string
): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const isValidObjectId = (value: unknown): value is string =>
    typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toPositiveInt = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

const normalizeSort = (value: unknown): ReviewSort =>
    REVIEW_SORTS.includes(value as ReviewSort) ? (value as ReviewSort) : 'newest';

const resolveSortSpec = (sort: ReviewSort): Record<string, 1 | -1> => {
    switch (sort) {
        case 'highest':
            return { rating: -1, createdAt: -1 };
        case 'lowest':
            return { rating: 1, createdAt: -1 };
        case 'verified':
            return { verifiedPurchase: -1, createdAt: -1 };
        case 'newest':
        default:
            return { createdAt: -1 };
    }
};

// Review images are temporarily disabled — restore this normalizer to re-enable review images.
// /**
//  * Review images must come from the dedicated review media endpoint. Only the
//  * URL/fileId are trusted; anything else is normalised away.
//  */
// const normalizeReviewImages = (value: unknown): MediaAsset[] => {
//     if (value === undefined || value === null) {
//         return [];
//     }
//
//     if (!Array.isArray(value)) {
//         throw createReviewError(400, 'Review images must be an array', 'invalid_review_image');
//     }
//
//     if (value.length > REVIEW_IMAGE_LIMIT) {
//         throw createReviewError(
//             400,
//             `A review can include at most ${REVIEW_IMAGE_LIMIT} images`,
//             'invalid_review_image'
//         );
//     }
//
//     return value.map((row, index) => {
//         if (!row || typeof row !== 'object') {
//             throw createReviewError(400, 'Invalid review image', 'invalid_review_image');
//         }
//
//         const candidate = row as Record<string, unknown>;
//         const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
//         const fileId = typeof candidate.fileId === 'string' ? candidate.fileId.trim() : '';
//
//         if (!url || !/^https?:\/\//i.test(url)) {
//             throw createReviewError(400, 'Review image URL is invalid', 'invalid_review_image');
//         }
//
//         if (!isReviewImageUrl(url)) {
//             throw createReviewError(
//                 400,
//                 'Review images must be uploaded through the review media endpoint',
//                 'invalid_review_image'
//             );
//         }
//
//         return {
//             provider: 'imagekit' as const,
//             fileId: fileId || null,
//             url,
//             name: typeof candidate.name === 'string' ? candidate.name.trim() : '',
//             ...(typeof candidate.width === 'number' ? { width: candidate.width } : {}),
//             ...(typeof candidate.height === 'number' ? { height: candidate.height } : {}),
//             ...(typeof candidate.size === 'number' ? { size: candidate.size } : {}),
//             mimeType: typeof candidate.mimeType === 'string' ? candidate.mimeType.trim() : '',
//             alt: typeof candidate.alt === 'string' ? candidate.alt.trim() : '',
//             sortOrder: typeof candidate.sortOrder === 'number' ? candidate.sortOrder : index,
//         };
//     });
// };

type LeanReview = Record<string, unknown> & {
    _id: mongoose.Types.ObjectId;
    product?: mongoose.Types.ObjectId | { _id: mongoose.Types.ObjectId; title?: string; slug?: string; images?: string[] };
    user?: mongoose.Types.ObjectId | { _id: mongoose.Types.ObjectId; username?: string; email?: string };
    order?: mongoose.Types.ObjectId;
};

const serializeReview = (review: LeanReview) => ({
    id: review._id.toString(),
    productId:
        review.product && typeof review.product === 'object' && '_id' in review.product
            ? review.product._id.toString()
            : (review.product as mongoose.Types.ObjectId | undefined)?.toString?.() ?? null,
    userId:
        review.user && typeof review.user === 'object' && '_id' in review.user
            ? review.user._id.toString()
            : (review.user as mongoose.Types.ObjectId | undefined)?.toString?.() ?? null,
    orderId: review.order?.toString?.() ?? null,
    rating: review.rating,
    comment: review.comment,
    images: review.images ?? [],
    status: review.status,
    verifiedPurchase: review.verifiedPurchase,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    moderatedAt: review.moderatedAt ?? null,
});

const serializePublicReview = (review: LeanReview) => {
    const author =
        review.user && typeof review.user === 'object' && 'username' in review.user
            ? (review.user.username as string | undefined)
            : undefined;

    return {
        id: review._id.toString(),
        rating: review.rating,
        comment: review.comment,
        images: review.images ?? [],
        verifiedPurchase: review.verifiedPurchase,
        authorName: author || 'Mioralane customer',
        createdAt: review.createdAt,
    };
};

const serializeCustomerReview = (review: LeanReview) => {
    const product = review.product as
        | { _id: mongoose.Types.ObjectId; title?: string; slug?: string; images?: string[] }
        | undefined;

    return {
        ...serializeReview(review),
        product: product && typeof product === 'object' && '_id' in product
            ? {
                id: product._id.toString(),
                title: product.title ?? '',
                slug: product.slug ?? '',
                image: Array.isArray(product.images) ? product.images[0] ?? '' : '',
            }
            : null,
    };
};

const serializeAdminReview = (review: LeanReview) => {
    const product = review.product as
        | { _id: mongoose.Types.ObjectId; title?: string; slug?: string; images?: string[] }
        | undefined;
    const user = review.user as
        | { _id: mongoose.Types.ObjectId; username?: string; email?: string }
        | undefined;

    return {
        ...serializeReview(review),
        product:
            product && typeof product === 'object' && '_id' in product
                ? {
                    id: product._id.toString(),
                    title: product.title ?? '',
                    slug: product.slug ?? '',
                    image: Array.isArray(product.images) ? product.images[0] ?? '' : '',
                }
                : null,
        customer:
            user && typeof user === 'object' && '_id' in user
                ? {
                    id: user._id.toString(),
                    username: user.username ?? '',
                    email: user.email ?? '',
                }
                : null,
    };
};

/**
 * Finds the most recent delivered order owned by the customer that contains the
 * purchased product. The order document is the authoritative purchase record —
 * the client can never influence this.
 */
const findEligiblePurchase = async (
    userId: string,
    productId: string
): Promise<{ orderId: string; purchasedAt?: Date } | null> => {
    const order = await Order.findOne({
        user: new mongoose.Types.ObjectId(userId),
        orderStatus: OrderStatus.DELIVERED,
        items: {
            $elemMatch: {
                itemType: 'product',
                product: new mongoose.Types.ObjectId(productId),
            },
        },
    })
        .sort({ createdAt: -1 })
        .select('_id createdAt')
        .lean()
        .exec();

    if (!order?._id) {
        return null;
    }

    return {
        orderId: order._id.toString(),
        purchasedAt: (order as { createdAt?: Date }).createdAt,
    };
};

export const getReviewEligibility = async (userId: string, productIdRaw: unknown) => {
    if (!isValidObjectId(productIdRaw)) {
        throw createReviewError(400, 'Invalid product ID', 'invalid_product');
    }

    const product = await Product.findById(productIdRaw).select('_id').lean().exec();
    if (!product) {
        throw createReviewError(404, 'Product not found', 'product_not_found');
    }

    const existing = await Review.findOne({ user: userId, product: productIdRaw })
        .select('_id status rating comment verifiedPurchase createdAt order')
        .lean()
        .exec();

    const purchase = existing
        ? { orderId: (existing as { order?: mongoose.Types.ObjectId }).order?.toString() ?? null }
        : await findEligiblePurchase(userId, productIdRaw);

    return {
        productId: productIdRaw,
        eligible: !existing && Boolean(purchase?.orderId),
        purchased: Boolean(purchase?.orderId),
        hasReviewed: Boolean(existing),
        orderId: purchase?.orderId ?? null,
        review: existing
            ? {
                id: existing._id.toString(),
                status: existing.status,
                rating: existing.rating,
                comment: existing.comment,
                verifiedPurchase: existing.verifiedPurchase,
                createdAt: existing.createdAt,
            }
            : null,
    };
};

/**
 * Creates a pending review. `verifiedPurchase`, `status`, `user` and the linked
 * order are all derived on the server from the order collection.
 */
export const submitReview = async (userId: string, payload: unknown) => {
    const body = (payload ?? {}) as Record<string, unknown>;

    const productIdRaw = typeof body.productId === 'string' ? body.productId.trim() : '';
    if (!isValidObjectId(productIdRaw)) {
        throw createReviewError(400, 'Invalid product ID', 'invalid_product');
    }

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw createReviewError(400, 'Rating must be a whole number between 1 and 5', 'invalid_rating');
    }

    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (comment.length < MIN_REVIEW_LENGTH) {
        throw createReviewError(
            400,
            `Review text must be at least ${MIN_REVIEW_LENGTH} characters`,
            'invalid_comment'
        );
    }

    if (comment.length > MAX_REVIEW_LENGTH) {
        throw createReviewError(
            400,
            `Review text cannot exceed ${MAX_REVIEW_LENGTH} characters`,
            'invalid_comment'
        );
    }

    // Review images are temporarily disabled.
    // const images = normalizeReviewImages(body.images);

    const product = await Product.findById(productIdRaw).select('_id').lean().exec();
    if (!product) {
        throw createReviewError(404, 'Product not found', 'product_not_found');
    }

    const existing = await Review.findOne({ user: userId, product: productIdRaw })
        .select('_id')
        .lean()
        .exec();
    if (existing) {
        throw createReviewError(
            409,
            'You have already reviewed this product',
            'duplicate_review'
        );
    }

    const purchase = await findEligiblePurchase(userId, productIdRaw);
    if (!purchase) {
        throw createReviewError(
            403,
            'You can only review products you have purchased and received',
            'not_eligible_purchase'
        );
    }

    const review = await Review.create({
        product: productIdRaw,
        user: userId,
        order: purchase.orderId,
        rating,
        comment,
        // Review images are temporarily disabled.
        // images,
        status: 'pending',
        verifiedPurchase: true,
    });

    return serializeReview(review.toObject() as LeanReview);
};

/**
 * Recomputes Product.rating/numReviews from approved reviews so the existing
 * product fields stay consistent with the public review aggregation.
 */
export const syncProductRating = async (productId: string): Promise<void> => {
    if (!isValidObjectId(productId)) {
        return;
    }

    const rows = await Review.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(productId), status: 'approved' } },
        {
            $group: {
                _id: null,
                averageRating: { $avg: '$rating' },
                reviewCount: { $sum: 1 },
            },
        },
    ]);

    const stats = rows[0] as { averageRating: number; reviewCount: number } | undefined;
    const averageRating = stats ? Math.round(stats.averageRating * 10) / 10 : 0;
    const reviewCount = stats ? stats.reviewCount : 0;

    await Product.findByIdAndUpdate(productId, {
        rating: averageRating,
        numReviews: reviewCount,
    }).exec();
};

export const getProductReviews = async (
    productIdRaw: unknown,
    options: { sort?: unknown; page?: unknown; limit?: unknown } = {}
) => {
    if (!isValidObjectId(productIdRaw)) {
        throw createReviewError(400, 'Invalid product ID', 'invalid_product');
    }

    const product = await Product.findById(productIdRaw).select('_id').lean().exec();
    if (!product) {
        throw createReviewError(404, 'Product not found', 'product_not_found');
    }

    const sort = normalizeSort(options.sort);
    const page = toPositiveInt(options.page, 1);
    const limit = Math.min(toPositiveInt(options.limit, 5), MAX_PAGE_SIZE);

    const distributionRows = await Review.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(productIdRaw as string), status: 'approved' } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);

    const ratingDistribution: Record<'1' | '2' | '3' | '4' | '5', number> = {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
    };
    let reviewCount = 0;
    let ratingSum = 0;

    for (const row of distributionRows as Array<{ _id: number; count: number }>) {
        const stars = Number(row._id);
        const count = Number(row.count);
        if (stars >= 1 && stars <= 5) {
            ratingDistribution[String(stars) as '1'] = count;
            reviewCount += count;
            ratingSum += stars * count;
        }
    }

    const averageRating = reviewCount ? Math.round((ratingSum / reviewCount) * 10) / 10 : 0;

    const filter = { product: productIdRaw as string, status: 'approved' as const };

    const [reviews, total] = await Promise.all([
        Review.find(filter)
            .sort(resolveSortSpec(sort))
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('user', 'username')
            .lean()
            .exec(),
        Review.countDocuments(filter),
    ]);

    return {
        summary: { averageRating, reviewCount, ratingDistribution },
        reviews: (reviews as unknown as LeanReview[]).map(serializePublicReview),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(Math.ceil(total / limit), 1),
        },
    };
};

export const getCustomerReviews = async (userId: string) => {
    const reviews = await Review.find({ user: userId })
        .sort({ createdAt: -1 })
        .populate('product', 'title slug images')
        .lean()
        .exec();

    return (reviews as unknown as LeanReview[]).map(serializeCustomerReview);
};

export const listAdminReviews = async (
    options: {
        search?: unknown;
        status?: unknown;
        productId?: unknown;
        rating?: unknown;
        verified?: unknown;
        page?: unknown;
        limit?: unknown;
    } = {}
) => {
    const page = toPositiveInt(options.page, 1);
    const limit = Math.min(toPositiveInt(options.limit, 10), MAX_PAGE_SIZE);

    const filter: Record<string, unknown> = {};

    if (REVIEW_STATUSES.includes(options.status as ReviewStatus)) {
        filter.status = options.status;
    }

    if (isValidObjectId(options.productId)) {
        filter.product = options.productId;
    }

    const rating = Number(options.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
        filter.rating = rating;
    }

    if (options.verified === 'true' || options.verified === true) {
        filter.verifiedPurchase = true;
    } else if (options.verified === 'false' || options.verified === false) {
        filter.verifiedPurchase = false;
    }

    const search = typeof options.search === 'string' ? options.search.trim() : '';
    if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        const [productIds, userIds] = await Promise.all([
            Product.find({ title: regex }).select('_id').limit(50).lean().exec(),
            UserModel.find({ $or: [{ username: regex }, { email: regex }] })
                .select('_id')
                .limit(50)
                .lean()
                .exec(),
        ]);

        filter.$or = [
            { comment: regex },
            { product: { $in: productIds.map((doc) => doc._id) } },
            { user: { $in: userIds.map((doc) => doc._id) } },
        ];
    }

    const [reviews, total, pendingCount] = await Promise.all([
        Review.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('product', 'title slug images')
            .populate('user', 'username email')
            .lean()
            .exec(),
        Review.countDocuments(filter),
        Review.countDocuments({ status: 'pending' }),
    ]);

    return {
        reviews: (reviews as unknown as LeanReview[]).map(serializeAdminReview),
        pendingCount,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(Math.ceil(total / limit), 1),
        },
    };
};

export const getAdminReview = async (reviewId: unknown) => {
    if (!isValidObjectId(reviewId)) {
        throw createReviewError(400, 'Invalid review ID', 'invalid_review');
    }

    const review = await Review.findById(reviewId)
        .populate('product', 'title slug images')
        .populate('user', 'username email')
        .lean()
        .exec();

    if (!review) {
        throw createReviewError(404, 'Review not found', 'review_not_found');
    }

    return serializeAdminReview(review as unknown as LeanReview);
};

export const moderateReview = async (reviewId: unknown, statusRaw: unknown) => {
    if (!isValidObjectId(reviewId)) {
        throw createReviewError(400, 'Invalid review ID', 'invalid_review');
    }

    if (statusRaw !== 'approved' && statusRaw !== 'rejected' && statusRaw !== 'pending') {
        throw createReviewError(
            400,
            'Status must be pending, approved, or rejected',
            'invalid_review_status'
        );
    }

    const review = await Review.findById(reviewId).exec();
    if (!review) {
        throw createReviewError(404, 'Review not found', 'review_not_found');
    }

    review.status = statusRaw;
    review.moderatedAt = new Date();
    await review.save();

    await syncProductRating(review.product.toString());

    const updated = await Review.findById(reviewId)
        .populate('product', 'title slug images')
        .populate('user', 'username email')
        .lean()
        .exec();

    return serializeAdminReview(updated as unknown as LeanReview);
};
