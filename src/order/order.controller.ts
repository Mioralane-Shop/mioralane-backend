import crypto from 'crypto';
import mongoose from 'mongoose';
import { Response } from 'express';
import { Product } from '../product/product.model';
import { Combo } from '../combo/combo.model';
import { Order, IOrderDocument, OrderItemType } from './order.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { sanitizeErrorMessage } from '../middleware/error.middleware';
import { OrderStatus } from '../enums/order-status.enum';
import { CouponUsage } from '../promotion/coupon-usage.model';
import {
  calculateAutomaticPromotion,
  DiscountableOrderItem,
  reserveCouponUsage,
  reserveCouponUsageForCustomer,
  selectBetterSinglePromotion,
  validateCouponForOrder,
} from '../promotion/promotion.service';
import {
  createCheckoutQuoteFingerprint,
  resolveShipping,
  validateAndNormalizeShippingAddress,
} from '../shipping/shipping.service';
import { resolveSavedAddressForCheckout } from '../address/address.service';
import { recordOrderStockDeductions } from '../inventory/inventory-transaction.service';
// NOTE (P1.3, R8): stock is deducted here with this module's own guarded `$inc`
// rather than through the inventory module's `applyStockDelta`, and the ledger
// row is then written via the module in the same transaction. Both guards are
// equivalent today, but two implementations of one invariant is the drift shape
// G6 removed from the upload path — worth collapsing when this path is next
// touched.
import {
  IDEMPOTENCY_KEY_TTL_MS,
  IdempotencyKey,
  createCheckoutRequestFingerprint,
} from './idempotency-key.model';
import { pickActivitySnapshot, recordActivity } from '../activity-log/activity-log.service';
import type { CreateOrderInput } from './order.schemas';
import { MAX_ORDER_ITEM_QUANTITY } from './order.schemas';

/** Fields kept in the participant order snapshot. */
const ORDER_AUDIT_FIELDS = ['orderNumber', 'orderStatus', 'totalAmount', 'paymentMethod'];

type HttpError = Error & { statusCode?: number; code?: string; quote?: unknown };

/**
 * The product/combo fields checkout reads, as one shape (P1.3, R5).
 *
 * Loading a combo and a product into a single variable produced a union
 * TypeScript cannot index, which is why this path previously reached for
 * `as any` on `availabilityMode`/`preOrder` — exactly the pre-order capacity
 * logic, where a field rename would otherwise go unnoticed by the compiler.
 * Building the view explicitly removes both casts without one of its own.
 */
type ResolvedPreOrder = {
  expectedArrivalDate?: Date;
  quantityLimit?: number;
  customerMessage?: string;
  status?: string;
  reservedQuantity?: number;
};

type ResolvedSourceDoc = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  price: number;
  salePrice?: number;
  images?: string[];
  stock: number;
  category?: string;
  availabilityMode?: string;
  preOrder?: ResolvedPreOrder;
};

// NOTE (P1.3, R8): the 3-byte random token makes a collision roughly 1 in 16.7M
// per day. If one ever happened, the unique index would raise a duplicate-key
// error, which this controller does not translate — it would surface as a 500.
// Acceptable at this scale; if the volume grows, retry the insert on 11000.
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

/** MongoDB's duplicate-key error, as raised by a unique index. */
const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

/** The response body every successful checkout returns, replay or first attempt. */
const CREATED_ORDER_MESSAGE = 'Order placed successfully';

export const createOrder = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const body = req.body as CreateOrderInput | undefined;
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

  // When checkout sends a saved address id, every shipping field is read back
  // from the customer's own address book — client values are ignored so a
  // foreign address id can never be used to ship an order.
  const savedAddressId = (body?.addressId ?? shippingAddress?.addressId ?? '').trim();
  let shippingAddressInput = shippingAddress;

  if (savedAddressId) {
    try {
      shippingAddressInput = await resolveSavedAddressForCheckout(userId, savedAddressId);
    } catch (error) {
      const err = error as HttpError;
      res.status(err.statusCode ?? 400).json({
        success: false,
        message: sanitizeErrorMessage(error, 'Saved delivery address could not be used'),
        code: err.code ?? 'invalid_address_id',
      });
      return;
    }
  }

  let normalizedShippingAddress;
  try {
    normalizedShippingAddress = validateAndNormalizeShippingAddress(shippingAddressInput);
  } catch (error) {
    // `code` added in P1.3 (R2): the zone resolver now refuses an unknown
    // district/area, and the client needs the machine-readable reason to point at
    // the right field. Error shape only — success responses are unchanged.
    const addressError = error as HttpError;

    res.status(400).json({
      success: false,
      message: sanitizeErrorMessage(error, 'Invalid shipping address'),
      code: addressError.code ?? 'invalid_shipping_address',
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

  // R6: the schema already caps this. Re-applied here so an internal caller that
  // bypasses `validate()` cannot exceed it either — unreachable from the route,
  // and a refusal rather than a silent pass if that ever changes.
  if (normalizedItems.some((item) => item.quantity > MAX_ORDER_ITEM_QUANTITY)) {
    res.status(400).json({
      success: false,
      message: `An order item quantity cannot exceed ${MAX_ORDER_ITEM_QUANTITY}`,
    });
    return;
  }

  // ── Idempotency (P1.3, R1) ────────────────────────────────────────────
  // Checked before any write, so a replay costs one read and creates nothing.
  const idempotencyKey =
    typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const requestFingerprint = createCheckoutRequestFingerprint(body ?? { items: [] }, userId);

  if (idempotencyKey) {
    const existingKey = await IdempotencyKey.findOne({ userId, key: idempotencyKey }).exec();

    if (existingKey) {
      if (existingKey.requestFingerprint !== requestFingerprint) {
        res.status(409).json({
          success: false,
          message: 'This checkout key was already used for a different order.',
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
        return;
      }

      const existingOrder = await Order.findById(existingKey.orderId).exec();

      if (existingOrder) {
        res.status(200).json({
          success: true,
          message: CREATED_ORDER_MESSAGE,
          order: existingOrder,
        });
        return;
      }

      // Key present, order gone (should be impossible: both are written in one
      // transaction). Fall through and place the order rather than fail closed on
      // a customer who did nothing wrong.
    }
  }

  const session = await mongoose.startSession();
  let createdOrder: IOrderDocument | null = null;

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

        const comboDoc =
          item.itemType === 'combo'
            ? await Combo.findById(item.itemId)
              .session(session)
              .select('_id title price images stock category')
              .exec()
            : null;
        const fetchedProductDoc =
          item.itemType === 'product'
            ? await Product.findById(item.itemId)
              .session(session)
              .select('_id title price salePrice images stock category availabilityMode preOrder')
              .exec()
            : null;

        const sourceDoc: ResolvedSourceDoc | null = fetchedProductDoc
          ? {
            _id: fetchedProductDoc._id,
            title: fetchedProductDoc.title,
            price: fetchedProductDoc.price,
            salePrice: fetchedProductDoc.salePrice,
            images: fetchedProductDoc.images,
            stock: fetchedProductDoc.stock,
            category: fetchedProductDoc.category,
            availabilityMode: fetchedProductDoc.availabilityMode,
            preOrder: fetchedProductDoc.preOrder,
          }
          : comboDoc
            ? {
              _id: comboDoc._id,
              title: comboDoc.title,
              price: comboDoc.price,
              images: comboDoc.images,
              stock: comboDoc.stock,
              category: comboDoc.category,
            }
            : null;

        if (!sourceDoc) {
          throw createHttpError(
            404,
            `${item.itemType === 'combo' ? 'Combo' : 'Product'} not found: ${item.itemId}`
          );
        }

        const isPreOrderProduct =
          item.itemType === 'product' && sourceDoc.availabilityMode === 'pre_order';
        // `?? {}` rather than `undefined`: a pre-order product with no pre-order
        // configuration must still fail closed as PRE_ORDER_CLOSED, which is what
        // the optional-chain form did before this was typed.
        const preOrder: ResolvedPreOrder = isPreOrderProduct ? sourceDoc.preOrder ?? {} : {};
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

        const sellingPrice =
          item.itemType === 'product' && sourceDoc.salePrice != null
            ? sourceDoc.salePrice
            : sourceDoc.price;

        resolvedItems.push({
          itemType: item.itemType,
          itemId: item.itemId as string,
          sourceId: sourceDoc._id,
          title: sourceDoc.title ?? (item.itemId as string),
          price: sellingPrice,
          thumbnail: sourceDoc.images?.[0] ?? '',
          quantity: item.quantity,
          originalPrice: sourceDoc.price,
          category: sourceDoc.category,
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

      // Stock actually removed by this checkout — ledgered in the same
      // transaction once the order exists.
      const deductedStockLines: Array<{
        itemType: OrderItemType;
        itemId: string;
        quantity: number;
      }> = [];

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

        deductedStockLines.push({
          itemType: item.itemType,
          itemId: item.itemId as string,
          quantity: item.quantity,
        });
      }

      const preOrderDates = resolvedItems
        .filter((item) => item.fulfillmentType === 'pre_order' && item.preOrderSnapshot?.expectedArrivalDate)
        .map((item) => new Date(item.preOrderSnapshot!.expectedArrivalDate!).getTime());
      const containsPreOrder = preOrderDates.length > 0;
      const expectedReadinessDate = containsPreOrder ? new Date(Math.max(...preOrderDates)) : undefined;

      // Coupon counters are reserved BEFORE the order row exists (P1.3). The
      // global counter already worked this way; the per-customer counter (R3) now
      // does too, so neither limit depends on a read that a concurrent checkout
      // could have taken before the other committed.
      if (selectedPromotion.coupon) {
        await reserveCouponUsage({ _id: selectedPromotion.coupon.couponId }, session);
        await reserveCouponUsageForCustomer(selectedPromotion.coupon.couponId, userId, session);
      }

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

      // Idempotency record (P1.3, R1), written in the same transaction as the
      // order: a rolled-back checkout leaves no key behind, so the customer's
      // retry is free to succeed rather than being answered with a stale replay.
      if (idempotencyKey) {
        await IdempotencyKey.create(
          [
            {
              userId: new mongoose.Types.ObjectId(userId),
              key: idempotencyKey,
              requestFingerprint,
              orderId: order._id,
              expiresAt: new Date(Date.now() + IDEMPOTENCY_KEY_TTL_MS),
            },
          ],
          { session }
        );
      }

      await recordOrderStockDeductions(
        order._id.toString(),
        userId,
        deductedStockLines,
        session
      );

      if (selectedPromotion.coupon) {
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

      // Participant activity, written in the same transaction as the order so a
      // rolled-back checkout leaves no log behind.
      await recordActivity(req, {
        action: 'CREATE',
        entityType: 'ORDER',
        entityId: order._id.toString(),
        entityName: order.orderNumber ?? order._id.toString(),
        after: pickActivitySnapshot(order.toObject(), ORDER_AUDIT_FIELDS),
        metadata: { itemCount: order.items?.length ?? 0 },
        session,
      });

      return order;
    });

    res.status(201).json({
      success: true,
      message: CREATED_ORDER_MESSAGE,
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

    // A concurrent request carrying the same key lost the race on the unique
    // index. Re-read it: when the winner committed this is an ordinary replay,
    // and when it did not the caller should simply try again.
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const racedKey = await IdempotencyKey.findOne({ userId, key: idempotencyKey }).exec();
      const racedOrder = racedKey ? await Order.findById(racedKey.orderId).exec() : null;

      if (racedKey && racedOrder && racedKey.requestFingerprint === requestFingerprint) {
        res.status(200).json({
          success: true,
          message: CREATED_ORDER_MESSAGE,
          order: racedOrder,
        });
        return;
      }

      res.status(409).json({
        success: false,
        message: 'This checkout is already being processed. Please wait a moment and try again.',
        code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      });
      return;
    }

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
