import mongoose from 'mongoose';
import type { SortOrder } from 'mongoose';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getPaginationParams } from '../utils/pagination';
import { Coupon } from './coupon.model';
import { CouponUsage } from './coupon-usage.model';
import { getRuntimeCampaignStatus, PromotionCampaign } from './promotion-campaign.model';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

const getParamId = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] : value ?? '';

const sendMutationError = (res: Response, error: unknown, label: string): void => {
  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: Object.values(error.errors).map((entry) => entry.message),
    });
    return;
  }

  if ((error as { code?: number }).code === 11000) {
    res.status(409).json({ success: false, message: 'Coupon code must be unique' });
    return;
  }

  console.error(label, error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

const withRuntime = (campaign: any) => ({
  ...campaign,
  id: campaign._id?.toString?.() ?? campaign.id,
  runtimeStatus: getRuntimeCampaignStatus(campaign),
  _id: undefined,
  __v: undefined,
});

export const listCampaigns = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { page, limit } = getPaginationParams(Number(req.query.page ?? 1), Number(req.query.limit ?? 10));
  const search = getString(req.query.search);
  const type = getString(req.query.type);
  const status = getString(req.query.status);
  const runtimeStatus = getString(req.query.runtimeStatus);
  const sort = getString(req.query.sort) ?? 'newest';
  const now = new Date();

  const match: Record<string, unknown> = {};
  if (search) match.name = { $regex: escapeRegex(search), $options: 'i' };
  if (type) match.campaignType = type;
  if (status) match.status = status;

  const runtimeMatch: Record<string, unknown>[] = [];
  if (runtimeStatus === 'draft') runtimeMatch.push({ status: 'draft' });
  if (runtimeStatus === 'paused') runtimeMatch.push({ status: 'paused' });
  if (runtimeStatus === 'scheduled') runtimeMatch.push({ status: 'published', 'schedule.startDate': { $gt: now } });
  if (runtimeStatus === 'active') runtimeMatch.push({ status: 'published', 'schedule.startDate': { $lte: now }, 'schedule.endDate': { $gte: now } });
  if (runtimeStatus === 'ended') runtimeMatch.push({ status: 'published', 'schedule.endDate': { $lt: now } });
  if (runtimeMatch.length > 0) match.$or = runtimeMatch;

  const sortSpec: Record<string, SortOrder> =
    sort === 'startDate' ? { 'schedule.startDate': -1 } : { createdAt: -1 };
  const [items, total] = await Promise.all([
    PromotionCampaign.find(match).sort(sortSpec).skip((page - 1) * limit).limit(limit).lean().exec(),
    PromotionCampaign.countDocuments(match),
  ]);

  res.json({
    success: true,
    campaigns: items.map(withRuntime),
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
    count: total,
  });
};

export const getCampaign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = getParamId(req.params.id);
  if (!isObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid campaign ID' });
    return;
  }
  const campaign = await PromotionCampaign.findById(id).lean().exec();
  if (!campaign) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }
  res.json({ success: true, campaign: withRuntime(campaign) });
};

export const createCampaign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const campaign = await PromotionCampaign.create(req.body);
    res.status(201).json({ success: true, campaign });
  } catch (error) {
    sendMutationError(res, error, '[createCampaign]');
  }
};

export const updateCampaign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid campaign ID' });
      return;
    }
    const campaign = await PromotionCampaign.findById(id).exec();
    if (!campaign) {
      res.status(404).json({ success: false, message: 'Campaign not found' });
      return;
    }
    campaign.set(req.body);
    await campaign.save();
    res.json({ success: true, campaign });
  } catch (error) {
    sendMutationError(res, error, '[updateCampaign]');
  }
};

export const deleteCampaign = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = getParamId(req.params.id);
  if (!isObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid campaign ID' });
    return;
  }
  const deleted = await PromotionCampaign.findByIdAndDelete(id).exec();
  if (!deleted) {
    res.status(404).json({ success: false, message: 'Campaign not found' });
    return;
  }
  res.json({ success: true, message: 'Campaign deleted successfully' });
};

export const listCoupons = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { page, limit } = getPaginationParams(Number(req.query.page ?? 1), Number(req.query.limit ?? 10));
  const search = getString(req.query.search);
  const active = getString(req.query.active);
  const match: Record<string, unknown> = {};
  if (search) match.code = { $regex: escapeRegex(search), $options: 'i' };
  if (active === 'true') match.isActive = true;
  if (active === 'false') match.isActive = false;

  const [coupons, total] = await Promise.all([
    Coupon.find(match).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
    Coupon.countDocuments(match),
  ]);

  const stats = await CouponUsage.aggregate([
    { $match: { couponId: { $in: coupons.map((coupon) => coupon._id) } } },
    {
      $group: {
        _id: '$couponId',
        totalDiscountGiven: { $sum: '$discountAmount' },
        uniqueCustomers: { $addToSet: '$userId' },
      },
    },
    {
      $project: {
        totalDiscountGiven: 1,
        uniqueCustomers: { $size: '$uniqueCustomers' },
      },
    },
  ]);
  const statsMap = new Map(stats.map((row) => [row._id.toString(), row]));

  res.json({
    success: true,
    coupons: coupons.map((coupon) => {
      const row = statsMap.get(coupon._id.toString());
      return {
        ...coupon,
        id: coupon._id.toString(),
        _id: undefined,
        __v: undefined,
        stats: {
          totalUses: coupon.usageCount ?? 0,
          totalDiscountGiven: row?.totalDiscountGiven ?? 0,
          uniqueCustomers: row?.uniqueCustomers ?? 0,
          remainingUses: coupon.totalUsageLimit ? Math.max(coupon.totalUsageLimit - (coupon.usageCount ?? 0), 0) : null,
        },
      };
    }),
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
    count: total,
  });
};

export const getCoupon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = getParamId(req.params.id);
  if (!isObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid coupon ID' });
    return;
  }
  const coupon = await Coupon.findById(id).lean().exec();
  if (!coupon) {
    res.status(404).json({ success: false, message: 'Coupon not found' });
    return;
  }
  res.json({ success: true, coupon: { ...coupon, id: coupon._id.toString(), _id: undefined, __v: undefined } });
};

export const createCoupon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ success: true, coupon });
  } catch (error) {
    sendMutationError(res, error, '[createCoupon]');
  }
};

export const updateCoupon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid coupon ID' });
      return;
    }
    const coupon = await Coupon.findById(id).exec();
    if (!coupon) {
      res.status(404).json({ success: false, message: 'Coupon not found' });
      return;
    }
    coupon.set(req.body);
    await coupon.save();
    res.json({ success: true, coupon });
  } catch (error) {
    sendMutationError(res, error, '[updateCoupon]');
  }
};

export const deleteCoupon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const id = getParamId(req.params.id);
  if (!isObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid coupon ID' });
    return;
  }
  const deleted = await Coupon.findByIdAndDelete(id).exec();
  if (!deleted) {
    res.status(404).json({ success: false, message: 'Coupon not found' });
    return;
  }
  res.json({ success: true, message: 'Coupon deleted successfully' });
};
