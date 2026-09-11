import mongoose from 'mongoose';
import { Order } from '../order/order.model';
import { Coupon, ICouponDocument, normalizeCouponCode } from './coupon.model';
import { CouponUsage } from './coupon-usage.model';
import {
  CampaignType,
  getRuntimeCampaignStatus,
  IPromotionCampaignDocument,
  PromotionCampaign,
} from './promotion-campaign.model';

export type DiscountableOrderItem = {
  itemType: 'product' | 'combo';
  sourceId: mongoose.Types.ObjectId;
  title: string;
  quantity: number;
  price: number;
  originalPrice?: number;
  category?: string;
};

export type PromotionCalculation = {
  discountAmount: number;
  freeDelivery: boolean;
  promotion?: {
    campaignId?: mongoose.Types.ObjectId;
    campaignName?: string;
    campaignType?: CampaignType;
  };
  coupon?: {
    couponId: mongoose.Types.ObjectId;
    code: string;
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    discountAmount: number;
  };
  message?: string;
};

export const getPromotionSavings = (
  calculation: PromotionCalculation,
  baseShippingFee: number
): number => calculation.discountAmount + (calculation.freeDelivery ? baseShippingFee : 0);

export const selectBetterSinglePromotion = (
  automaticPromotion: PromotionCalculation,
  couponPromotion: PromotionCalculation | undefined,
  baseShippingFee: number
): PromotionCalculation => {
  if (!couponPromotion) {
    return automaticPromotion;
  }

  return getPromotionSavings(couponPromotion, baseShippingFee) >
    getPromotionSavings(automaticPromotion, baseShippingFee)
    ? couponPromotion
    : automaticPromotion;
};

type HttpError = Error & { statusCode?: number; code?: string };

export const createPromotionError = (
  statusCode: number,
  message: string,
  code?: string
): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const roundMoney = (value: number): number => Math.max(0, Math.round(value));

const isManualSaleItem = (item: DiscountableOrderItem): boolean =>
  item.originalPrice !== undefined && item.originalPrice > item.price;

const getEligibleSubtotal = (
  items: DiscountableOrderItem[],
  eligibility: {
    appliesTo: 'all' | 'products' | 'categories';
    productIds?: mongoose.Types.ObjectId[];
    categories?: string[];
  },
  excludeManualSaleProducts: boolean
): number => {
  const productIdSet = new Set((eligibility.productIds ?? []).map((id) => id.toString()));
  const categorySet = new Set((eligibility.categories ?? []).map((category) => category.trim().toLowerCase()));

  return items.reduce((sum, item) => {
    if (excludeManualSaleProducts && item.itemType === 'product' && isManualSaleItem(item)) {
      return sum;
    }

    if (eligibility.appliesTo === 'products' && !productIdSet.has(item.sourceId.toString())) {
      return sum;
    }

    if (
      eligibility.appliesTo === 'categories' &&
      (!item.category || !categorySet.has(item.category.trim().toLowerCase()))
    ) {
      return sum;
    }

    return sum + item.price * item.quantity;
  }, 0);
};

const calculateDiscount = (
  type: 'percentage' | 'fixed',
  value: number,
  eligibleSubtotal: number,
  maximumDiscount?: number
): number => {
  if (eligibleSubtotal <= 0) {
    return 0;
  }

  const rawDiscount = type === 'percentage' ? (eligibleSubtotal * value) / 100 : Math.min(value, eligibleSubtotal);
  const capped = maximumDiscount ? Math.min(rawDiscount, maximumDiscount) : rawDiscount;
  return roundMoney(capped);
};

export const findActiveCampaign = async (
  now = new Date(),
  session?: mongoose.ClientSession
): Promise<IPromotionCampaignDocument | null> => {
  return PromotionCampaign.findOne({
    status: 'published',
    'schedule.startDate': { $lte: now },
    'schedule.endDate': { $gte: now },
  })
    .session(session ?? null)
    .sort({ priority: -1, publishedAt: -1, createdAt: -1 })
    .exec();
};

export const calculateAutomaticPromotion = async (
  items: DiscountableOrderItem[],
  itemsTotal: number,
  userId?: string,
  session?: mongoose.ClientSession
): Promise<PromotionCalculation> => {
  const campaign = await findActiveCampaign(new Date(), session);

  if (!campaign || getRuntimeCampaignStatus(campaign) !== 'active') {
    return { discountAmount: 0, freeDelivery: false };
  }

  const basePromotion = {
    campaignId: campaign._id as mongoose.Types.ObjectId,
    campaignName: campaign.name,
    campaignType: campaign.campaignType,
  };

  if (campaign.usageLimits?.totalUsageLimit) {
    const totalUses = await Order.countDocuments({ 'promotion.campaignId': campaign._id }).session(session ?? null);
    if (totalUses >= campaign.usageLimits.totalUsageLimit) {
      return { discountAmount: 0, freeDelivery: false };
    }
  }

  if (campaign.usageLimits?.perCustomerUsageLimit && userId) {
    const customerUses = await Order.countDocuments({
      'promotion.campaignId': campaign._id,
      user: new mongoose.Types.ObjectId(userId),
    }).session(session ?? null);
    if (customerUses >= campaign.usageLimits.perCustomerUsageLimit) {
      return { discountAmount: 0, freeDelivery: false };
    }
  }

  if (campaign.campaignType === 'free_delivery') {
    const minimum = campaign.discount?.minimumOrderValue ?? 0;
    const eligibleSubtotal = getEligibleSubtotal(items, campaign.eligibility, false);
    const freeDelivery = eligibleSubtotal > 0 && itemsTotal >= minimum;
    return {
      discountAmount: 0,
      freeDelivery,
      promotion: freeDelivery ? basePromotion : undefined,
    };
  }

  if (campaign.campaignType !== 'automatic_discount' || !campaign.discount) {
    return {
      discountAmount: 0,
      freeDelivery: false,
    };
  }

  const minimum = campaign.discount.minimumOrderValue ?? 0;
  if (itemsTotal < minimum) {
    return {
      discountAmount: 0,
      freeDelivery: false,
      message: 'Minimum order value was not met',
    };
  }

  const eligibleSubtotal = getEligibleSubtotal(items, campaign.eligibility, true);
  const discountAmount = calculateDiscount(
    campaign.discount.type,
    campaign.discount.value,
    eligibleSubtotal,
    campaign.discount.maximumDiscount
  );

  return {
    discountAmount,
    freeDelivery: false,
    promotion: discountAmount > 0 ? basePromotion : undefined,
  };
};

export const validateCouponForOrder = async ({
  couponCode,
  userId,
  items,
  itemsTotal,
  session,
}: {
  couponCode: string;
  userId: string;
  items: DiscountableOrderItem[];
  itemsTotal: number;
  session?: mongoose.ClientSession;
}): Promise<PromotionCalculation> => {
  const code = normalizeCouponCode(couponCode);
  if (!code) {
    throw createPromotionError(400, 'Coupon code is required', 'coupon_required');
  }

  const coupon = await Coupon.findOne({ code }).session(session ?? null).exec();
  if (!coupon) {
    throw createPromotionError(404, 'Coupon is invalid', 'invalid_coupon');
  }

  const now = new Date();
  if (!coupon.isActive) {
    throw createPromotionError(400, 'Coupon is inactive', 'inactive_coupon');
  }

  if (now < coupon.startDate) {
    throw createPromotionError(400, 'Coupon is not active yet', 'coupon_not_started');
  }

  if (now > coupon.expiryDate) {
    throw createPromotionError(400, 'Coupon has expired', 'expired_coupon');
  }

  if (coupon.totalUsageLimit && coupon.usageCount >= coupon.totalUsageLimit) {
    throw createPromotionError(400, 'Coupon usage limit has been reached', 'usage_exceeded');
  }

  const customerUsage = await CouponUsage.countDocuments({
    couponId: coupon._id,
    userId: new mongoose.Types.ObjectId(userId),
  }).session(session ?? null);

  if (coupon.perCustomerUsageLimit && customerUsage >= coupon.perCustomerUsageLimit) {
    throw createPromotionError(400, 'Coupon usage limit has been reached for this customer', 'customer_usage_exceeded');
  }

  if (coupon.minimumOrderValue && itemsTotal < coupon.minimumOrderValue) {
    throw createPromotionError(400, 'Minimum order value was not met', 'minimum_not_met');
  }

  const eligibleSubtotal = getEligibleSubtotal(
    items,
    {
      appliesTo: coupon.appliesTo,
      productIds: coupon.productIds,
      categories: coupon.categories,
    },
    true
  );

  if (eligibleSubtotal <= 0) {
    throw createPromotionError(400, 'Coupon is not eligible for these items', 'not_eligible');
  }

  const discountAmount = calculateDiscount(
    coupon.discountType,
    coupon.discountValue,
    eligibleSubtotal,
    coupon.maximumDiscount
  );

  if (discountAmount <= 0) {
    throw createPromotionError(400, 'Coupon did not produce a discount', 'not_eligible');
  }

  return {
    discountAmount,
    freeDelivery: false,
    coupon: {
      couponId: coupon._id as mongoose.Types.ObjectId,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount,
    },
  };
};

export const reserveCouponUsage = async (
  coupon: Pick<ICouponDocument, '_id'>,
  session: mongoose.ClientSession
): Promise<void> => {
  const updated = await Coupon.findOneAndUpdate(
    { _id: coupon._id, $or: [{ totalUsageLimit: { $exists: false } }, { $expr: { $lt: ['$usageCount', '$totalUsageLimit'] } }] },
    { $inc: { usageCount: 1 } },
    { session, new: true }
  ).exec();

  if (!updated) {
    throw createPromotionError(400, 'Coupon usage limit has been reached', 'usage_exceeded');
  }
};
