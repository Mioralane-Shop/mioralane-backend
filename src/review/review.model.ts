import mongoose, { Document, Schema } from 'mongoose';
// Review images are temporarily disabled — restore these imports to re-enable review images.
// import { MediaAssetSchema } from '../media/media.schema';
// import type { MediaAsset } from '../media/media.types';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface IReview {
    product: mongoose.Types.ObjectId;
    user: mongoose.Types.ObjectId;
    order: mongoose.Types.ObjectId;
    rating: number;
    comment: string;
    // Review images are temporarily disabled.
    // images: MediaAsset[];
    status: ReviewStatus;
    verifiedPurchase: boolean;
    moderatedAt?: Date;
}

export interface IReviewDocument extends IReview, Document {
    createdAt: Date;
    updatedAt: Date;
}

const ReviewSchema = new Schema<IReviewDocument>(
    {
        product: {
            type: Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product reference is required'],
            index: true,
        },
        user: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Customer reference is required'],
            index: true,
        },
        order: {
            type: Schema.Types.ObjectId,
            ref: 'Order',
            required: [true, 'Order reference is required'],
        },
        rating: {
            type: Number,
            required: [true, 'Rating is required'],
            min: [1, 'Rating must be at least 1'],
            max: [5, 'Rating cannot exceed 5'],
            validate: {
                validator: Number.isInteger,
                message: 'Rating must be a whole number between 1 and 5',
            },
        },
        comment: {
            type: String,
            required: [true, 'Review text is required'],
            trim: true,
            minlength: [3, 'Review text must be at least 3 characters'],
            maxlength: [2000, 'Review text cannot exceed 2000 characters'],
        },
        // Review images are temporarily disabled.
        // images: {
        //     type: [MediaAssetSchema],
        //     default: [],
        // },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending',
            required: true,
            index: true,
        },
        verifiedPurchase: {
            type: Boolean,
            default: false,
            required: true,
        },
        moderatedAt: {
            type: Date,
            default: undefined,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                const r = ret as unknown as Record<string, unknown> & {
                    _id?: { toString: () => string };
                    product?: { toString: () => string };
                    user?: { toString: () => string };
                    order?: { toString: () => string };
                };

                if (r._id) {
                    r.id = r._id.toString();
                    delete r._id;
                }

                delete r.__v;

                if (r.product) {
                    r.productId = r.product.toString();
                }

                if (r.user) {
                    r.userId = r.user.toString();
                }

                if (r.order) {
                    r.orderId = r.order.toString();
                }
            },
        },
    }
);

// A customer can review a given product only once (duplicate-review protection).
ReviewSchema.index({ user: 1, product: 1 }, { unique: true });

export const Review =
    mongoose.models.Review || mongoose.model<IReviewDocument>('Review', ReviewSchema);
