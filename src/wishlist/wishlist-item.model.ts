import mongoose, { Document, Schema } from 'mongoose';

export type WishlistItemType = 'product' | 'combo';

/**
 * A single saved wishlist entry.
 *
 * The legacy `User.wishlist` / `User.comboWishlist` ObjectId arrays could only
 * express membership, so per-item data (the price when it was saved, when it
 * was saved) had nowhere to live. A dedicated collection keeps one document per
 * customer + catalog item, which also lets Mongo sort the list when it grows.
 */
export interface IWishlistItem {
    user: mongoose.Types.ObjectId;
    itemId: mongoose.Types.ObjectId;
    itemType: WishlistItemType;
    /** Selling price when the customer saved the item — used for price-drop. */
    priceAtAdd: number;
}

export interface IWishlistItemDocument extends IWishlistItem, Document {
    createdAt: Date;
    updatedAt: Date;
}

const WishlistItemSchema = new Schema<IWishlistItemDocument>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Customer reference is required'],
            index: true,
        },
        itemId: {
            type: Schema.Types.ObjectId,
            required: [true, 'Wishlist item reference is required'],
            index: true,
        },
        itemType: {
            type: String,
            enum: ['product', 'combo'],
            required: [true, 'Wishlist item type is required'],
        },
        priceAtAdd: {
            type: Number,
            required: true,
            min: [0, 'Price cannot be negative'],
            default: 0,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                const r = ret as unknown as Record<string, unknown> & {
                    _id?: { toString: () => string };
                    user?: { toString: () => string };
                    itemId?: { toString: () => string };
                };

                if (r._id) {
                    r.id = r._id.toString();
                    delete r._id;
                }

                delete r.__v;

                if (r.user) {
                    r.userId = r.user.toString();
                }

                if (r.itemId) {
                    r.itemId = r.itemId.toString();
                }

                return r;
            },
        },
    }
);

// One entry per customer + catalog item (duplicate prevention at the DB level).
WishlistItemSchema.index({ user: 1, itemId: 1, itemType: 1 }, { unique: true });

// Default listing order.
WishlistItemSchema.index({ user: 1, createdAt: -1 });

export const WishlistItem =
    mongoose.models.WishlistItem ||
    mongoose.model<IWishlistItemDocument>('WishlistItem', WishlistItemSchema);

export default WishlistItem;
