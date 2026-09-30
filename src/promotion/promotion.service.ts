import mongoose from 'mongoose';
import { Order } from '../order/order.model';
import { Coupon, ICouponDocument, normalizeCouponCode } from './coupon.model';
import { CouponUsage } from './coupon-usage.model';
import { CouponUsageCounter } from './coupon-usage-counter.model';
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

/**
 * Per-customer reservation (P1.3, R3) — the atomic counterpart of the
 * `countDocuments` pre-check in {@link validateCouponForOrder}.
 *
 * Reads the coupon's own `perCustomerUsageLimit` inside the transaction rather
 * than taking it from the caller, so it cannot be passed a stale or widened
 * limit. No-ops when the coupon has no per-customer limit, which is the common
 * case.
 *
 * The upsert-then-increment pair is deliberate: the increment's `$expr` guard
 * needs the document to exist, and MongoDB cannot construct an upserted document
 * from a `$expr` filter. Both writes are inside the caller's transaction, and the
 * increment itself is a single atomic operation.
 *
 * Failure mode under concurrency is fail-closed: the losing transaction raises a
 * duplicate key on the counter's unique index and the order is not created.
 */
export const reserveCouponUsageForCustomer = async (
  couponId: mongoose.Types.ObjectId | string,
  userId: string,
  session: mongoose.ClientSession
): Promise<void> => {
  const coupon = await Coupon.findById(couponId)
    .session(session)
    .select('perCustomerUsageLimit')
    .exec();

  const perCustomerLimit = coupon?.perCustomerUsageLimit;

  if (!perCustomerLimit) {
    return;
  }

  const userObjectId = new mongoose.Types.ObjectId(userId);

  await CouponUsageCounter.updateOne(
    { couponId, userId: userObjectId },
    { $setOnInsert: { count: 0 } },
    { upsert: true, session }
  ).exec();

  const reserved = await CouponUsageCounter.findOneAndUpdate(
    { couponId, userId: userObjectId, $expr: { $lt: ['$count', perCustomerLimit] } },
    { $inc: { count: 1 } },
    { new: true, session }
  ).exec();

  if (!reserved) {
    throw createPromotionError(
      400,
      'Coupon usage limit has been reached for this customer',
      'customer_usage_exceeded'
    );
  }
};

/**
 * Filter used to give a consumed use back (P1.6-followup-a). Exported so the
 * harness asserts the guard instead of reading it out of a query string.
 *
 * `$expr: { $gt: ['$usageCount', 0] }` is the whole point of it. Without that
 * guard a second release drives the counter to -1, and a negative counter is not
 * a harmless artefact: it hands the coupon an extra free use, which is the same
 * class of asymmetry this function exists to close.
 */
export const couponUsageReleaseFilter = (
  couponId: mongoose.Types.ObjectId | string
): Record<string, unknown> => ({
  _id: couponId,
  $expr: { $gt: ['$usageCount', 0] },
});

export const couponUsageReleaseUpdate = { $inc: { usageCount: -1 } } as const;

/**
 * Counter filter counterpart of {@link couponUsageReleaseFilter}. The per-customer
 * counter has no `$expr` need — `count` is a plain field — but it needs the same
 * floor so it cannot go negative, and it is deliberately a no-op when no counter
 * exists (an order placed before the counter was introduced), which `updateOne`
 * gives for free.
 */
export const couponUsageCounterReleaseFilter = (
  couponId: mongoose.Types.ObjectId | string,
  userId: mongoose.Types.ObjectId | string
): Record<string, unknown> => ({
  couponId,
  userId,
  count: { $gt: 0 },
});

export const couponUsageCounterReleaseUpdate = { $inc: { count: -1 } } as const;

/** What {@link releaseCouponUsageForOrder} needs from an order. */
export type CouponUsageReleaseTarget = {
  _id: mongoose.Types.ObjectId | string;
  user?: mongoose.Types.ObjectId | string;
  coupon?: { couponId?: mongoose.Types.ObjectId | string };
};

/**
 * Gives back everything a cancelled order consumed from a coupon
 * (P1.6-followup-a) — the mirror of `reserveCouponUsage` +
 * `reserveCouponUsageForCustomer` + the `CouponUsage` row, in the caller's
 * transaction.
 *
 * ## Why all three, not just the two counters
 *
 * `coupon.usageCount` is the global authority and `CouponUsageCounter` is the
 * per-customer authority, but `CouponUsage` (one row per order) is what
 * `validateCouponForOrder`'s friendly pre-check counts. Releasing the two counters
 * and leaving the row would still refuse the coupon — with the pre-check's message
 * rather than the counter's — so the cancellation would look fixed and not be.
 *
 * ## Idempotency is structural, not conditional
 *
 * The delete comes FIRST and its `deletedCount` decides everything else. That row
 * is the record that *this order* consumed a use, so a second call deletes nothing,
 * returns `false`, and touches no counter. The same property covers an order placed
 * before the row existed (nothing to delete → no-op) and a coupon deleted after the
 * order (the counter decrement is independent, and the `coupon.usageCount` update
 * simply matches nothing). No flag on the order is needed, and no counter can be
 * released twice even if a future path reaches this outside the CANCELLED branch.
 *
 * The guards do not make this atomic against a concurrent release — the order
 * document's write is what serialises two cancels (see the note in
 * `updateAdminOrderStatus`) — they make it safe if it ever is not.
 *
 * @returns `true` when this call released a use, `false` when there was nothing to
 * release. The caller records it, because "the coupon was given back" is exactly
 * the kind of thing an audit entry should not have to infer.
 */
export const releaseCouponUsageForOrder = async (
  order: CouponUsageReleaseTarget,
  session: mongoose.ClientSession
): Promise<boolean> => {
  const couponId = order.coupon?.couponId;
  const userId = order.user;

  if (!couponId || !userId) {
    return false;
  }

  const released = await CouponUsage.deleteOne({ orderId: order._id, couponId }, { session }).exec();

  if (released.deletedCount !== 1) {
    return false;
  }

  await Coupon.findOneAndUpdate(couponUsageReleaseFilter(couponId), couponUsageReleaseUpdate, {
    session,
  }).exec();

  await CouponUsageCounter.updateOne(
    couponUsageCounterReleaseFilter(couponId, userId),
    couponUsageCounterReleaseUpdate,
    { session }
  ).exec();

  return true;
};
