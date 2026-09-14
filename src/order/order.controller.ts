import crypto from 'crypto';
import mongoose from 'mongoose';
import { Response } from 'express';
import { Product } from '../product/product.model';
import { Combo } from '../combo/combo.model';
import { Order, OrderItemType, PaymentMethod } from './order.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { OrderStatus } from '../enums/order-status.enum';
import { CouponUsage } from '../promotion/coupon-usage.model';
import {
  calculateAutomaticPromotion,
  DiscountableOrderItem,
  reserveCouponUsage,
  selectBetterSinglePromotion,
  validateCouponForOrder,
} from '../promotion/promotion.service';
import {
  createCheckoutQuoteFingerprint,
  resolveShipping,
  validateAndNormalizeShippingAddress,
} from '../shipping/shipping.service';

type OrderPayloadItem = {
  itemId?: string;
  productId?: string;
  itemType?: OrderItemType;
  title?: string;
  price?: number;
  thumbnail?: string;
  quantity: number;
};

type CreateOrderBody = {
  items?: OrderPayloadItem[];
  shippingAddress?: {
    name?: string;
    phone?: string;
    division?: string;
    district?: string;
    area?: string;
    address?: string;
    detailedAddress?: string;
    landmark?: string;
  };
  paymentMethod?: PaymentMethod;
  couponCode?: string;
  quoteFingerprint?: string;
};

type HttpError = Error & { statusCode?: number; code?: string; quote?: unknown };

const generateOrderNumber = (): string => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const token = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MIOR-${stamp}-${token}`;
};

const createHttpError = (statusCode: number, message: string, code?: string, quote?: unknown): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  error.quote = quote;
  return error;
};

export const createOrder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CreateOrderBody | undefined;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authorized' });
    return;
  }

  const items = body?.items;
  const shippingAddress = body?.shippingAddress;
  const paymentMethod = body?.paymentMethod ?? 'cash_on_delivery';

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, message: 'Order items are required' });
    return;
  }

  if (paymentMethod !== 'cash_on_delivery') {
    res.status(400).json({ success: false, message: 'Only Cash on Delivery is supported for now' });
    return;
  }

  let normalizedShippingAddress;
  try {
    normalizedShippingAddress = validateAndNormalizeShippingAddress(shippingAddress);
  } catch (error) {
    const err = error as HttpError;
    res.status(400).json({
      success: false,
      message: err.message,
    });
    return;
  }

  const normalizedItems = items
    .map((item) => ({
      itemId: (item?.itemId ?? item?.productId)?.trim(),
      itemType: item?.itemType,
      quantity: Number(item?.quantity),
    }))
    .filter((item) => item.itemId && Number.isInteger(item.quantity) && item.quantity > 0);

  if (normalizedItems.length !== items.length) {
    res.status(400).json({
      success: false,
      message: 'Each order item must include a valid itemId and quantity greater than zero',
    });
    return;
  }

  const session = await mongoose.startSession();
  let createdOrder: any = null;

  try {
    createdOrder = await session.withTransaction(async () => {
      const resolvedItems: Array<{
        itemType: OrderItemType;
        itemId: string;
        sourceId: mongoose.Types.ObjectId;
        title: string;
        price: number;
        thumbnail: string;
        quantity: number;
        originalPrice?: number;
        category?: string;
        fulfillmentType: 'regular' | 'pre_order';
        preOrderSnapshot?: {
          expectedArrivalDate?: Date;
          customerMessage?: string;
          quantityLimit?: number;
        };
      }> = [];

      for (const item of normalizedItems) {
        if (item.itemType !== 'product' && item.itemType !== 'combo') {
          throw createHttpError(
            400,
            `Order item ${item.itemId} must specify a valid itemType of product or combo`
          );
        }

        const sourceDoc =
          item.itemType === 'combo'
            ? await Combo.findById(item.itemId)
                .session(session)
                .select('_id title price images stock category')
                .exec()
            : await Product.findById(item.itemId)
                .session(session)
                .select('_id title price salePrice images stock category availabilityMode preOrder')
                .exec();

        if (!sourceDoc) {
          throw createHttpError(
            404,
            `${item.itemType === 'combo' ? 'Combo' : 'Product'} not found: ${item.itemId}`
          );
        }

        const isPreOrderProduct =
          item.itemType === 'product' && (sourceDoc as any).availabilityMode === 'pre_order';
        const preOrder = isPreOrderProduct ? (sourceDoc as any).preOrder : undefined;
        const preOrderLimit = Number(preOrder?.quantityLimit ?? 0);
        const preOrderReserved = Number(preOrder?.reservedQuantity ?? 0);
        const preOrderRemaining = Math.max(preOrderLimit - preOrderReserved, 0);

        if (isPreOrderProduct) {
          if (preOrder?.status !== 'accepting') {
            throw createHttpError(
              409,
              `Pre-order is not currently accepting orders for ${sourceDoc.title ?? item.itemId}`,
              'PRE_ORDER_CLOSED'
            );
          }

          if (!preOrder?.expectedArrivalDate || preOrderLimit <= 0 || preOrderRemaining < item.quantity) {
            throw createHttpError(
              409,
              `Pre-order capacity is full for ${sourceDoc.title ?? item.itemId}`,
              'PRE_ORDER_FULL'
            );
          }
        } else if (sourceDoc.stock < item.quantity) {
          throw createHttpError(
            409,
            `Insufficient stock for ${sourceDoc.title ?? item.itemId}`
          );
        }

        const productDoc = sourceDoc as { salePrice?: number; price: number; category?: string };
        const sellingPrice =
          item.itemType === 'product' && productDoc.salePrice != null
            ? productDoc.salePrice
            : productDoc.price;

        resolvedItems.push({
          itemType: item.itemType,
          itemId: item.itemId as string,
          sourceId: sourceDoc._id,
          title: sourceDoc.title ?? (item.itemId as string),
          price: sellingPrice,
          thumbnail: sourceDoc.images?.[0] ?? '',
          quantity: item.quantity,
          originalPrice: productDoc.price,
          category: productDoc.category,
          fulfillmentType: isPreOrderProduct ? 'pre_order' : 'regular',
          preOrderSnapshot: isPreOrderProduct
            ? {
                expectedArrivalDate: preOrder.expectedArrivalDate,
                customerMessage: preOrder.customerMessage,
                quantityLimit: preOrderLimit,
              }
            : undefined,
        });
      }

      const itemsTotal = resolvedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const discountItems: DiscountableOrderItem[] = resolvedItems.map((item) => ({
        itemType: item.itemType,
        sourceId: item.sourceId,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        originalPrice: item.originalPrice,
        category: item.category,
      }));

      const automaticPromotion = await calculateAutomaticPromotion(discountItems, itemsTotal, userId, session);
      const couponCode = typeof body?.couponCode === 'string' ? body.couponCode.trim() : '';
      const couponPromotion = couponCode
        ? await validateCouponForOrder({
            couponCode,
            userId,
            items: discountItems,
            itemsTotal,
            session,
          })
        : undefined;
      const baseShipping = await resolveShipping({
        address: normalizedShippingAddress,
        itemsTotal,
        discountAmount: 0,
        session,
      });
      const selectedPromotion = selectBetterSinglePromotion(
        automaticPromotion,
        couponPromotion,
        baseShipping.baseCharge
      );
      const discountAmount = Math.min(selectedPromotion.discountAmount, itemsTotal);
      const shipping = await resolveShipping({
        address: normalizedShippingAddress,
        itemsTotal,
        discountAmount,
        promotionFreeDelivery: selectedPromotion.freeDelivery,
        session,
      });
      if (!shipping.availability.available) {
        throw createHttpError(400, shipping.availability.message ?? 'Delivery is unavailable for the selected address');
      }

      const shippingFee = shipping.finalCharge;
      const totalAmount = Math.max(itemsTotal - discountAmount, 0) + shippingFee;
      const totals = {
        subtotal: itemsTotal,
        discountAmount,
        shippingFee,
        totalAmount,
      };
      const quoteFingerprint = createCheckoutQuoteFingerprint({
        shipping,
        totals,
        promotion: selectedPromotion.promotion,
        coupon: selectedPromotion.coupon,
      });

      if (body?.quoteFingerprint !== quoteFingerprint) {
        throw createHttpError(
          409,
          'Delivery or order total has been updated. Please review the new total and place your order again.',
          'CHECKOUT_QUOTE_CHANGED',
          {
            quoteFingerprint,
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
          }
        );
      }

      for (const item of resolvedItems) {
        if (item.fulfillmentType === 'pre_order') {
          const updated = await Product.findOneAndUpdate(
            {
              _id: item.sourceId,
              availabilityMode: 'pre_order',
              'preOrder.status': 'accepting',
              $expr: {
                $gte: [
                  { $subtract: ['$preOrder.quantityLimit', { $ifNull: ['$preOrder.reservedQuantity', 0] }] },
                  item.quantity,
                ],
              },
            },
            { $inc: { 'preOrder.reservedQuantity': item.quantity } },
            { new: true, session }
          ).exec();

          if (!updated) {
            throw createHttpError(409, 'One or more pre-order items are no longer available', 'PRE_ORDER_FULL');
          }

          continue;
        }

        const updated =
          item.itemType === 'combo'
            ? await Combo.findOneAndUpdate(
                { _id: item.sourceId, stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity } },
                { new: true, session }
              ).exec()
            : await Product.findOneAndUpdate(
                { _id: item.sourceId, stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity } },
                { new: true, session }
              ).exec();

        if (!updated) {
          throw createHttpError(409, 'One or more items are out of stock');
        }
      }

      const preOrderDates = resolvedItems
        .filter((item) => item.fulfillmentType === 'pre_order' && item.preOrderSnapshot?.expectedArrivalDate)
        .map((item) => new Date(item.preOrderSnapshot!.expectedArrivalDate!).getTime());
      const containsPreOrder = preOrderDates.length > 0;
      const expectedReadinessDate = containsPreOrder ? new Date(Math.max(...preOrderDates)) : undefined;

      const [order] = await Order.create(
        [
          {
            orderNumber: generateOrderNumber(),
            user: new mongoose.Types.ObjectId(userId),
            items: resolvedItems.map((item) => ({
              itemType: item.itemType,
              sourceId: item.itemId,
              product: item.itemType === 'product' ? item.sourceId : undefined,
              combo: item.itemType === 'combo' ? item.sourceId : undefined,
              title: item.title,
              quantity: item.quantity,
              price: item.price,
              thumbnail: item.thumbnail,
              fulfillmentType: item.fulfillmentType,
              preOrderSnapshot: item.preOrderSnapshot,
            })),
            shippingAddress: {
              name: normalizedShippingAddress.name,
              phone: normalizedShippingAddress.phone,
              division: normalizedShippingAddress.division,
              district: normalizedShippingAddress.district,
              deliveryZone: shipping.zone,
              area: normalizedShippingAddress.area,
              address: normalizedShippingAddress.address,
              landmark: normalizedShippingAddress.landmark,
            },
            itemsTotal,
            discountAmount,
            shippingFee,
            shipping: {
              zone: shipping.zone,
              baseCharge: shipping.baseCharge,
              finalCharge: shipping.finalCharge,
              isFreeDelivery: shipping.isFreeDelivery,
              freeDeliveryReason: shipping.freeDeliveryReason,
              estimatedMinDays: shipping.estimatedMinDays,
              estimatedMaxDays: shipping.estimatedMaxDays,
            },
            totalAmount,
            promotion: selectedPromotion.promotion,
            coupon: selectedPromotion.coupon,
            paymentMethod,
            paymentStatus: 'pending',
            orderStatus: OrderStatus.PENDING,
            containsPreOrder,
            expectedReadinessDate,
            preOrderReservationsReleased: false,
          },
        ],
        { session }
      );

      if (selectedPromotion.coupon) {
        await reserveCouponUsage({ _id: selectedPromotion.coupon.couponId }, session);
        await CouponUsage.create(
          [
            {
              couponId: selectedPromotion.coupon.couponId,
              userId: new mongoose.Types.ObjectId(userId),
              orderId: order._id,
              discountAmount: selectedPromotion.coupon.discountAmount,
              usedAt: new Date(),
            },
          ],
          { session }
        );
      }

      return order;
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: createdOrder,
    });
  } catch (error) {
    const httpError = error as HttpError;
    const transactionUnsupported =
      error instanceof Error &&
      /transaction numbers are only allowed|replica set|mongos|Transaction numbers/i.test(
        error.message
      );

    console.error('[createOrder]', error);
    if (transactionUnsupported) {
      res.status(503).json({
        success: false,
        message:
          'MongoDB transactions are not supported by the current deployment topology. Checkout cannot complete safely without a replica set or compatible MongoDB setup.',
      });
      return;
    }

    if (httpError.statusCode) {
      res.status(httpError.statusCode).json({
        success: false,
        message: httpError.message,
        code: httpError.code,
        quote: httpError.quote,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
  finally {
    await session.endSession();
  }
};

export const getMyOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authorized' });
    return;
  }

  const orders = await Order.find({ user: userId }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: orders.length,
    orders,
  });
};

export const getOrderById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const role = req.user?.role;
  const rawId = req.params.id;
  const orderId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authorized' });
    return;
  }

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400).json({ success: false, message: 'Invalid order ID' });
    return;
  }

  const order = await Order.findOne(
    role === 'admin'
      ? { _id: orderId }
      : {
          _id: orderId,
          user: userId,
        }
  );

  if (!order) {
    res.status(404).json({
      success: false,
      message: 'Order not found',
    });
    return;
  }

  res.status(200).json({
    success: true,
    order,
  });
};
