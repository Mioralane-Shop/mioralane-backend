import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * Per-customer coupon usage counter (P1.3, R3).
 *
 * ## Why a counter and not a count
 *
 * `validateCouponForOrder` enforced `perCustomerUsageLimit` with
 * `CouponUsage.countDocuments(...)` — a plain read, taken before the row for the
 * current order exists. Sequentially that is correct. Concurrently it is not:
 * two transactions for the same customer each read the pre-state, each see room,
 * and each proceed. Nothing at the database level stopped them either, because
 * `CouponUsage`'s `{ couponId, userId }` index is deliberately **not** unique
 * (a coupon may legitimately allow more than one use per customer).
 *
 * The global limit never had this problem: `reserveCouponUsage` increments a
 * counter with a single `$inc` guarded by `$expr`. This collection gives the
 * per-customer limit the same property — one document per `(couponId, userId)`,
 * incremented under a guard, inside the order's transaction.
 *
 * The `countDocuments` read stays in place as the fast, friendly pre-check; this
 * is the authority.
 */
export interface ICouponUsageCounter {
  couponId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICouponUsageCounterDocument extends ICouponUsageCounter, Document {}

const CouponUsageCounterSchema = new Schema<ICouponUsageCounterDocument>(
  {
    couponId: {
      type: Schema.Types.ObjectId,
      ref: 'Coupon',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    count: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * One counter per customer per coupon, and the index is what makes the guarded
 * increment safe: a concurrent insert of the same pair cannot both exist.
 */
CouponUsageCounterSchema.index({ couponId: 1, userId: 1 }, { unique: true });

export const CouponUsageCounter: Model<ICouponUsageCounterDocument> =
  mongoose.models.CouponUsageCounter ||
  mongoose.model<ICouponUsageCounterDocument>('CouponUsageCounter', CouponUsageCounterSchema);

export default CouponUsageCounter;
