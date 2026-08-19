import crypto from 'crypto';
import mongoose from 'mongoose';
import { Response } from 'express';
import { Product } from '../product/product.model';
import { Combo } from '../combo/combo.model';
import { Order, DeliveryZone, OrderItemType, PaymentMethod } from './order.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { OrderStatus } from '../enums/order-status.enum';

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
    deliveryZone?: DeliveryZone;
    area?: string;
    address?: string;
  };
  paymentMethod?: PaymentMethod;
};

type HttpError = Error & { statusCode?: number };

const SHIPPING_FEES: Record<DeliveryZone, number> = {
  inside_dhaka: 80,
  outside_dhaka: 150,
};

const generateOrderNumber = (): string => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const token = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MIOR-${stamp}-${token}`;
};

const normalizePhone = (value: string): string => value.trim().replace(/\s+/g, ' ');

const isValidZone = (zone: unknown): zone is DeliveryZone =>
  zone === 'inside_dhaka' || zone === 'outside_dhaka';

const createHttpError = (statusCode: number, message: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
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

  if (
    !shippingAddress?.name ||
    !shippingAddress.phone ||
    !shippingAddress.area ||
    !shippingAddress.address ||
    !isValidZone(shippingAddress.deliveryZone)
  ) {
    res.status(400).json({
      success: false,
      message: 'Shipping name, phone, area, address, and delivery zone are required',
    });
    return;
  }

  const validatedShippingAddress = shippingAddress as {
    name: string;
    phone: string;
    deliveryZone: DeliveryZone;
    area: string;
    address: string;
  };

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
                .select('_id title price images stock')
                .exec()
            : await Product.findById(item.itemId)
                .session(session)
                .select('_id title price images stock')
                .exec();

        if (!sourceDoc) {
          throw createHttpError(
            404,
            `${item.itemType === 'combo' ? 'Combo' : 'Product'} not found: ${item.itemId}`
          );
        }

        if (sourceDoc.stock < item.quantity) {
          throw createHttpError(
            409,
            `Insufficient stock for ${sourceDoc.title ?? item.itemId}`
          );
        }

          resolvedItems.push({
          itemType: item.itemType,
          itemId: item.itemId as string,
          sourceId: sourceDoc._id,
          title: sourceDoc.title ?? (item.itemId as string),
          price: sourceDoc.price,
          thumbnail: sourceDoc.images?.[0] ?? '',
          quantity: item.quantity,
        });
      }

      for (const item of resolvedItems) {
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

      const itemsTotal = resolvedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const shippingFee = SHIPPING_FEES[validatedShippingAddress.deliveryZone];
      const totalAmount = itemsTotal + shippingFee;

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
            })),
            shippingAddress: {
              name: validatedShippingAddress.name.trim(),
              phone: normalizePhone(validatedShippingAddress.phone),
              deliveryZone: validatedShippingAddress.deliveryZone,
              area: validatedShippingAddress.area.trim(),
              address: validatedShippingAddress.address.trim(),
            },
            itemsTotal,
            shippingFee,
            totalAmount,
            paymentMethod,
            paymentStatus: 'pending',
            orderStatus: OrderStatus.PENDING,
          },
        ],
        { session }
      );

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
