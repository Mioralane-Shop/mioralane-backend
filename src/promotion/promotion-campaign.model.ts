import mongoose, { Document, Model, Schema } from 'mongoose';
import { Product } from '../product/product.model';

export type CampaignType =
  | 'automatic_discount'
  | 'coupon_discount'
  | 'announcement'
  | 'free_delivery'
  | 'free_gift';

export type CampaignAdminStatus = 'draft' | 'published' | 'paused';
export type PopupActionType = 'none' | 'link' | 'coupon' | 'coupon_link';
export type RuntimeCampaignStatus = 'draft' | 'scheduled' | 'active' | 'ended' | 'paused';

export interface IPromotionCampaign {
  name: string;
  internalDescription?: string;
  campaignType: CampaignType;
  status: CampaignAdminStatus;
  priority: number;
  publishedAt?: Date;
  floatingTab: {
    enabled: boolean;
    title: string;
    subtitle?: string;
  };
  popup: {
    enabled: boolean;
    posterUrl?: string;
    posterFileId?: string;
    posterAlt?: string;
    actionType: PopupActionType;
    ctaLabel?: string;
    ctaUrl?: string;
    couponId?: mongoose.Types.ObjectId;
  };
  discount?: {
    type: 'percentage' | 'fixed';
    value: number;
    minimumOrderValue?: number;
    maximumDiscount?: number;
  };
  eligibility: {
    appliesTo: 'all' | 'products' | 'categories';
    productIds?: mongoose.Types.ObjectId[];
    categories?: string[];
  };
  usageLimits?: {
    totalUsageLimit?: number;
    perCustomerUsageLimit?: number;
  };
  schedule: {
    startDate: Date;
    endDate: Date;
  };
}

export interface IPromotionCampaignDocument extends IPromotionCampaign, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const getRuntimeCampaignStatus = (
  campaign: Pick<IPromotionCampaign, 'status' | 'schedule'>,
  now = new Date()
): RuntimeCampaignStatus => {
  if (campaign.status === 'draft') return 'draft';
  if (campaign.status === 'paused') return 'paused';
  if (now < campaign.schedule.startDate) return 'scheduled';
  if (now > campaign.schedule.endDate) return 'ended';
  return 'active';
};

const positiveOptionalInteger = {
  validator(value: number | undefined) {
    return value === undefined || value === null || (Number.isInteger(value) && value > 0);
  },
  message: 'Usage limits must be positive integers',
};

const PromotionCampaignSchema = new Schema<IPromotionCampaignDocument>(
  {
    name: {
      type: String,
      required: [true, 'Campaign name is required'],
      trim: true,
      maxlength: 160,
      index: true,
    },
    internalDescription: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: undefined,
    },
    campaignType: {
      type: String,
      enum: ['automatic_discount', 'coupon_discount', 'announcement', 'free_delivery', 'free_gift'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'paused'],
      default: 'draft',
      index: true,
    },
    priority: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    publishedAt: {
      type: Date,
      default: undefined,
      index: true,
    },
    floatingTab: {
      enabled: { type: Boolean, default: false },
      title: { type: String, trim: true, default: '' },
      subtitle: { type: String, trim: true, default: '' },
    },
    popup: {
      enabled: { type: Boolean, default: false },
      posterUrl: { type: String, trim: true, default: '' },
      posterFileId: { type: String, trim: true, default: '' },
      posterAlt: { type: String, trim: true, default: '' },
      actionType: {
        type: String,
        enum: ['none', 'link', 'coupon', 'coupon_link'],
        default: 'none',
      },
      ctaLabel: { type: String, trim: true, default: '' },
      ctaUrl: { type: String, trim: true, default: '' },
      couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: undefined },
    },
    discount: {
      type: {
        type: String,
        enum: ['percentage', 'fixed'],
      },
      value: {
        type: Number,
        min: 0,
      },
      minimumOrderValue: {
        type: Number,
        min: 0,
        default: undefined,
      },
      maximumDiscount: {
        type: Number,
        min: 0,
        default: undefined,
      },
    },
    eligibility: {
      appliesTo: {
        type: String,
        enum: ['all', 'products', 'categories'],
        default: 'all',
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
    },
    usageLimits: {
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
    },
    schedule: {
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
    },
  },
  { timestamps: true }
);

PromotionCampaignSchema.pre<IPromotionCampaignDocument>('validate', async function () {
  if (this.campaignType === 'coupon_discount' || this.campaignType === 'announcement' || this.campaignType === 'free_gift') {
    this.discount = undefined;
  }

  if (this.schedule?.endDate <= this.schedule?.startDate) {
    this.invalidate('schedule.endDate', 'End date must be after start date');
  }

  if (this.floatingTab?.enabled && !this.floatingTab.title?.trim()) {
    this.invalidate('floatingTab.title', 'Floating tab title is required when the tab is enabled');
  }

  if (this.popup?.enabled && ['link', 'coupon_link'].includes(this.popup.actionType)) {
    if (!this.popup.ctaLabel?.trim() || !this.popup.ctaUrl?.trim()) {
      this.invalidate('popup.ctaUrl', 'CTA label and URL are required for link actions');
    }
  }

  if (['coupon', 'coupon_link'].includes(this.popup?.actionType) && !this.popup?.couponId) {
    this.invalidate('popup.couponId', 'Coupon is required for coupon actions');
  }

  if (['automatic_discount', 'free_delivery'].includes(this.campaignType)) {
    if (!this.discount?.type || this.discount.value === undefined || this.discount.value === null) {
      this.invalidate('discount.value', 'Discount rules are required for this campaign type');
    } else if (this.discount.type === 'percentage' && (this.discount.value <= 0 || this.discount.value > 100)) {
      this.invalidate('discount.value', 'Percentage discount must be greater than 0 and no more than 100');
    } else if (this.discount.type === 'fixed' && this.discount.value <= 0) {
      this.invalidate('discount.value', 'Fixed discount must be greater than 0');
    }
  }

  if (this.eligibility?.appliesTo === 'products') {
    const productIds = this.eligibility.productIds ?? [];
    if (productIds.length === 0) {
      this.invalidate('eligibility.productIds', 'At least one product is required');
      return;
    }

    const count = await Product.countDocuments({ _id: { $in: productIds } });
    if (count !== productIds.length) {
      this.invalidate('eligibility.productIds', 'One or more selected products do not exist');
    }
  }

  if (this.eligibility?.appliesTo === 'categories' && (this.eligibility.categories ?? []).length === 0) {
    this.invalidate('eligibility.categories', 'At least one category is required');
  }

  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }
});

PromotionCampaignSchema.set('toJSON', {
  transform(_doc, ret) {
    const r = ret as unknown as Record<string, unknown> & {
      _id?: { toString: () => string };
      __v?: unknown;
      status: CampaignAdminStatus;
      schedule: { startDate: Date; endDate: Date };
    };
    r.id = r._id?.toString();
    r.runtimeStatus = getRuntimeCampaignStatus(r);
    delete r._id;
    delete r.__v;
    return r;
  },
});

PromotionCampaignSchema.index({ status: 1, 'schedule.startDate': 1, 'schedule.endDate': 1 });
PromotionCampaignSchema.index({ name: 'text', internalDescription: 'text' });

export const PromotionCampaign: Model<IPromotionCampaignDocument> =
  mongoose.models.PromotionCampaign ||
  mongoose.model<IPromotionCampaignDocument>('PromotionCampaign', PromotionCampaignSchema);

export default PromotionCampaign;
