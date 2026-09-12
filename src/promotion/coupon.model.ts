import mongoose, { Document, Model, Schema } from 'mongoose';
import { Product } from '../product/product.model';

export type DiscountType = 'percentage' | 'fixed';
export type EligibilityAppliesTo = 'all' | 'products' | 'categories';

export interface ICoupon {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  minimumOrderValue?: number;
  maximumDiscount?: number;
  appliesTo: EligibilityAppliesTo;
  productIds?: mongoose.Types.ObjectId[];
  categories?: string[];
  startDate: Date;
  expiryDate: Date;
  totalUsageLimit?: number;
  perCustomerUsageLimit?: number;
  isActive: boolean;
  usageCount: number;
}

export interface ICouponDocument extends ICoupon, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const normalizeCouponCode = (value: string): string =>
  value.trim().toUpperCase().replace(/\s+/g, '');

const positiveOptionalNumber = {
  validator(value: number | undefined) {
    return value === undefined || value === null || value >= 0;
  },
  message: 'Value cannot be negative',
};

const positiveOptionalInteger = {
  validator(value: number | undefined) {
    return value === undefined || value === null || (Number.isInteger(value) && value > 0);
  },
  message: 'Usage limits must be positive integers',
};

const CouponSchema = new Schema<ICouponDocument>(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
      set: normalizeCouponCode,
    },
    discountType: {
      type: String,
      enum: ['percentage', 'fixed'],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
      min: [0, 'Discount value must be greater than zero'],
    },
    minimumOrderValue: {
      type: Number,
      min: 0,
      validate: positiveOptionalNumber,
      default: undefined,
    },
    maximumDiscount: {
      type: Number,
      min: 0,
      validate: positiveOptionalNumber,
      default: undefined,
    },
    appliesTo: {
      type: String,
      enum: ['all', 'products', 'categories'],
      default: 'all',
      required: true,
    },
    productIds: {
      type: [Schema.Types.ObjectId],
      ref: 'Product',
      default: [],
    },
    categories: {
      type: [String],
      default: [],
    },
    startDate: {
      type: Date,
      required: true,
    },
    expiryDate: {
      type: Date,
      required: true,
    },
    totalUsageLimit: {
      type: Number,
      validate: positiveOptionalInteger,
      default: undefined,
    },
    perCustomerUsageLimit: {
      type: Number,
      validate: positiveOptionalInteger,
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    usageCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Usage count must be an integer',
      },
    },
  },
  { timestamps: true }
);

CouponSchema.pre<ICouponDocument>('validate', async function () {
  this.code = normalizeCouponCode(this.code ?? '');

  if (this.discountType === 'percentage' && (this.discountValue <= 0 || this.discountValue > 100)) {
    this.invalidate('discountValue', 'Percentage discount must be greater than 0 and no more than 100');
  }

  if (this.discountType === 'fixed' && this.discountValue <= 0) {
    this.invalidate('discountValue', 'Fixed discount must be greater than 0');
  }

  if (this.expiryDate <= this.startDate) {
    this.invalidate('expiryDate', 'Expiry date must be after start date');
  }

  if (this.appliesTo === 'products') {
    if (!this.productIds || this.productIds.length === 0) {
      this.invalidate('productIds', 'At least one product is required for selected product coupons');
      return;
    }

    const count = await Product.countDocuments({ _id: { $in: this.productIds } });
    if (count !== this.productIds.length) {
      this.invalidate('productIds', 'One or more selected products do not exist');
    }
  }

  if (this.appliesTo === 'categories' && (!this.categories || this.categories.length === 0)) {
    this.invalidate('categories', 'At least one category is required for selected category coupons');
  }
});

CouponSchema.set('toJSON', {
  transform(_doc, ret) {
    const r = ret as unknown as Record<string, unknown> & { _id?: { toString: () => string }; __v?: unknown };
    r.id = r._id?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Coupon: Model<ICouponDocument> =
  mongoose.models.Coupon || mongoose.model<ICouponDocument>('Coupon', CouponSchema);

export default Coupon;
