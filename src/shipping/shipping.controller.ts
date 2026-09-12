import { Response } from 'express';
import mongoose from 'mongoose';
import { Combo } from '../combo/combo.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { Product } from '../product/product.model';
import {
  calculateAutomaticPromotion,
  DiscountableOrderItem,
  selectBetterSinglePromotion,
  validateCouponForOrder,
} from '../promotion/promotion.service';
import {
  createCheckoutQuoteFingerprint,
  getShippingSettings,
  resolveShippingQuote,
  upsertShippingSettings,
  validateAndNormalizeShippingQuoteAddress,
} from './shipping.service';

const resolveQuoteItems = async (rawItems: any[]): Promise<DiscountableOrderItem[]> => {
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
        ? await Combo.findById(itemId).select('_id title price category').lean().exec()
        : await Product.findById(itemId).select('_id title price salePrice category').lean().exec();

    if (!source) {
      throw new Error(`${itemType === 'combo' ? 'Combo' : 'Product'} not found`);
    }

    const productSource = source as { price: number; salePrice?: number };
    resolved.push({
      itemType,
      sourceId: source._id as mongoose.Types.ObjectId,
      title: source.title,
      quantity,
      price: itemType === 'product' && productSource.salePrice != null ? productSource.salePrice : productSource.price,
      originalPrice: productSource.price,
      category: source.category,
    });
  }

  return resolved;
};

export const quoteShipping = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const items = await resolveQuoteItems(Array.isArray(req.body?.items) ? req.body.items : []);
    const normalizedAddress = validateAndNormalizeShippingQuoteAddress(req.body?.shippingAddress ?? req.body?.address);
    const itemsTotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const automaticPromotion = await calculateAutomaticPromotion(items, itemsTotal, req.user.id);
    const couponCode = typeof req.body?.couponCode === 'string' ? req.body.couponCode.trim() : '';
    const couponPromotion = couponCode
      ? await validateCouponForOrder({ couponCode, userId: req.user.id, items, itemsTotal })
      : undefined;

    const baseShipping = await resolveShippingQuote({
      address: normalizedAddress,
      itemsTotal,
      discountAmount: 0,
    });
    const selectedPromotion = selectBetterSinglePromotion(
      automaticPromotion,
      couponPromotion,
      baseShipping.baseCharge
    );
    const discountAmount = Math.min(selectedPromotion.discountAmount, itemsTotal);
    const shipping = await resolveShippingQuote({
      address: normalizedAddress,
      itemsTotal,
      discountAmount,
      promotionFreeDelivery: selectedPromotion.freeDelivery,
    });
    const totals = {
      subtotal: itemsTotal,
      discountAmount,
      shippingFee: shipping.finalCharge,
      totalAmount: Math.max(itemsTotal - discountAmount, 0) + shipping.finalCharge,
    };

    res.json({
      success: true,
      quoteFingerprint: createCheckoutQuoteFingerprint({
        shipping,
        totals,
        promotion: selectedPromotion.promotion,
        coupon: selectedPromotion.coupon,
      }),
      shipping: {
        zone: shipping.zone,
        baseShippingCharge: shipping.baseCharge,
        finalShippingCharge: shipping.finalCharge,
        isFreeDelivery: shipping.isFreeDelivery,
        freeDeliveryReason: shipping.freeDeliveryReason,
        estimatedMinDays: shipping.estimatedMinDays,
        estimatedMaxDays: shipping.estimatedMaxDays,
        availability: shipping.availability,
      },
      totals,
      promotion: selectedPromotion.promotion,
      coupon: selectedPromotion.coupon,
    });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to calculate shipping quote',
      code: err.code ?? 'shipping_quote_failed',
    });
  }
};

export const getAdminShippingSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const settings = await getShippingSettings();
  res.json({ success: true, settings });
};

export const updateAdminShippingSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const settings = await upsertShippingSettings(req.body);
    res.json({ success: true, settings });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to update shipping settings',
      code: err.code ?? 'shipping_settings_update_failed',
    });
  }
};
