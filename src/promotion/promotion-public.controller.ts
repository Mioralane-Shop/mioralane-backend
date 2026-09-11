import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { Product } from '../product/product.model';
import { Combo } from '../combo/combo.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { DeliveryZone } from '../order/order.model';
import { Coupon } from './coupon.model';
import {
  calculateAutomaticPromotion,
  DiscountableOrderItem,
  findActiveCampaign,
  selectBetterSinglePromotion,
  validateCouponForOrder,
} from './promotion.service';

const SHIPPING_FEES: Record<DeliveryZone, number> = {
  inside_dhaka: 80,
  outside_dhaka: 150,
};

const isValidZone = (zone: unknown): zone is DeliveryZone =>
  zone === 'inside_dhaka' || zone === 'outside_dhaka';

export const getActivePromotion = async (_req: Request, res: Response): Promise<void> => {
  const campaign = await findActiveCampaign();

  if (!campaign) {
    res.json({ success: true, campaign: null });
    return;
  }

  const coupon =
    campaign.popup?.couponId && ['coupon', 'coupon_link'].includes(campaign.popup.actionType)
      ? await Coupon.findById(campaign.popup.couponId).select('code discountType discountValue').lean()
      : null;

  res.json({
    success: true,
    campaign: {
      id: campaign._id.toString(),
      name: campaign.name,
      campaignType: campaign.campaignType,
      floatingTab: campaign.floatingTab,
      popup: {
        enabled: campaign.popup.enabled,
        posterUrl: campaign.popup.posterUrl,
        posterAlt: campaign.popup.posterAlt,
        actionType: campaign.popup.actionType,
        ctaLabel: campaign.popup.ctaLabel,
        ctaUrl: campaign.popup.ctaUrl,
        coupon: coupon
          ? {
              code: coupon.code,
              discountType: coupon.discountType,
              discountValue: coupon.discountValue,
            }
          : null,
      },
      discount:
        campaign.campaignType === 'automatic_discount' || campaign.campaignType === 'free_delivery'
          ? campaign.discount
          : undefined,
      schedule: campaign.schedule,
    },
  });
};

const resolveItems = async (rawItems: any[]): Promise<DiscountableOrderItem[]> => {
  const resolved: DiscountableOrderItem[] = [];

  for (const item of rawItems) {
    const itemType = item?.itemType;
    const itemId = item?.itemId ?? item?.productId;
    const quantity = Number(item?.quantity);
    if (!itemId || !Number.isInteger(quantity) || quantity <= 0 || (itemType !== 'product' && itemType !== 'combo')) {
      throw new Error('Each item must include itemId, itemType, and quantity');
    }

    const source =
      itemType === 'combo'
        ? await Combo.findById(itemId).select('_id title price category stock').lean().exec()
        : await Product.findById(itemId).select('_id title price salePrice category stock').lean().exec();

    if (!source) {
      throw new Error(`${itemType === 'combo' ? 'Combo' : 'Product'} not found`);
    }

    const productSource = source as { price: number; salePrice?: number };
    resolved.push({
      itemType,
      sourceId: source._id,
      title: source.title,
      quantity,
      price: itemType === 'product' && productSource.salePrice != null ? productSource.salePrice : productSource.price,
      originalPrice: productSource.price,
      category: source.category,
    });
  }

  return resolved;
};

export const validatePromotion = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const items = await resolveItems(Array.isArray(req.body?.items) ? req.body.items : []);
    const deliveryZone = req.body?.deliveryZone;
    if (!isValidZone(deliveryZone)) {
      res.status(400).json({ success: false, message: 'Valid delivery zone is required' });
      return;
    }

    const itemsTotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const automatic = await calculateAutomaticPromotion(items, itemsTotal, req.user.id);
    const couponCode = typeof req.body?.couponCode === 'string' ? req.body.couponCode : '';
    const coupon = couponCode
      ? await validateCouponForOrder({ couponCode, userId: req.user.id, items, itemsTotal })
      : undefined;

    const baseShippingFee = SHIPPING_FEES[deliveryZone];
    const selectedDiscount = selectBetterSinglePromotion(automatic, coupon, baseShippingFee);
    const shippingFee = selectedDiscount.freeDelivery ? 0 : baseShippingFee;
    const discountAmount = selectedDiscount.discountAmount;

    res.json({
      success: true,
      totals: {
        subtotal: itemsTotal,
        discountAmount,
        shippingFee,
        totalAmount: Math.max(itemsTotal - discountAmount, 0) + shippingFee,
      },
      promotion: selectedDiscount.promotion,
      coupon: selectedDiscount.coupon,
    });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to validate promotion',
      code: err.code ?? 'promotion_validation_failed',
    });
  }
};
