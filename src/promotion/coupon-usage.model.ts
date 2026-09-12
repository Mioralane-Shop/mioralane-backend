import mongoose, { Document, Model, Schema } from 'mongoose';

export interface ICouponUsage {
  couponId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  orderId: mongoose.Types.ObjectId;
  discountAmount: number;
  usedAt: Date;
}

export interface ICouponUsageDocument extends ICouponUsage, Document {}

const CouponUsageSchema = new Schema<ICouponUsageDocument>({
  couponId: {
    type: Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  orderId: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true,
  },
  discountAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  usedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

CouponUsageSchema.index({ couponId: 1, userId: 1 });
CouponUsageSchema.index({ couponId: 1, orderId: 1 }, { unique: true });

CouponUsageSchema.set('toJSON', {
  transform(_doc, ret) {
    const r = ret as unknown as Record<string, unknown> & { _id?: { toString: () => string }; __v?: unknown };
    r.id = r._id?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const CouponUsage: Model<ICouponUsageDocument> =
  mongoose.models.CouponUsage ||
  mongoose.model<ICouponUsageDocument>('CouponUsage', CouponUsageSchema);

export default CouponUsage;
