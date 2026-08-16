import crypto from 'crypto';
import mongoose from 'mongoose';
import { Request, Response } from 'express';
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

const rollbackStockChanges = async (
  changes: Array<{ itemType: OrderItemType; itemId: string; quantity: number }>
) => {
  for (const change of changes) {
    if (change.itemType === 'combo') {
      await Combo.findByIdAndUpdate(change.itemId, {
        $inc: { stock: change.quantity },
      });
    } else {
      await Product.findByIdAndUpdate(change.itemId, {
        $inc: { stock: change.quantity },
      });
    }
  }
};

const isValidZone = (zone: unknown): zone is DeliveryZone =>
  zone === 'inside_dhaka' || zone === 'outside_dhaka';

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

  const normalizedItems = items
    .map((item) => ({
      itemId: (item?.itemId ?? item?.productId)?.trim(),
      itemType: item?.itemType,
      title: item?.title?.trim(),
      price: typeof item?.price === 'number' ? item.price : Number(item?.price),
      thumbnail: item?.thumbnail?.trim(),
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

  const resolvedItems: Array<{
    itemType: OrderItemType;
    itemId: string;
    sourceRef?: {
      model: 'product' | 'combo';
      id: mongoose.Types.ObjectId;
    };
    title: string;
    price: number;
    thumbnail: string;
    quantity: number;
  }> = [];
  const missing: string[] = [];

  for (const item of normalizedItems) {
    const itemId = item.itemId;
    if (!itemId) {
      missing.push('unknown');
      continue;
    }

    const product = await Product.findById(itemId);
    const combo = product ? null : await Combo.findById(itemId);

    if (item.itemType === 'product' && !product) {
      missing.push(itemId);
      continue;
    }

    if (item.itemType === 'combo' && !combo) {
      if (!product) {
        missing.push(itemId);
        continue;
      }
    }

    const resolvedType: OrderItemType =
      item.itemType ??
      (combo ? 'combo' : 'product');

    const sourceDoc = resolvedType === 'combo' ? combo ?? product : product ?? combo;

    if (!sourceDoc) {
      if (resolvedType === 'combo' && item.title && typeof item.price === 'number') {
        resolvedItems.push({
          itemType: resolvedType,
          itemId,
          title: item.title,
          price: item.price,
          thumbnail: item.thumbnail ?? '',
          quantity: item.quantity,
        });
        continue;
      }

      missing.push(itemId);
      continue;
    }

    resolvedItems.push({
      itemType: resolvedType,
      itemId,
      sourceRef: {
        model: resolvedType,
        id: sourceDoc._id,
      },
      title: (sourceDoc as { title?: string; name?: string }).title
        ?? (sourceDoc as { name?: string }).name
        ?? itemId,
      price: sourceDoc.price,
      thumbnail: sourceDoc.images?.[0] ?? '',
      quantity: item.quantity,
    });
  }

  if (missing.length > 0) {
    res.status(404).json({
      success: false,
      message: `Some items were not found: ${missing.join(', ')}`,
    });
    return;
  }

  const stockChanges: Array<{ itemType: OrderItemType; itemId: string; quantity: number }> = [];
  const orderItems = resolvedItems.map((item) => ({
    itemType: item.itemType,
    sourceId: item.itemId,
    product: item.sourceRef?.model === 'product' ? item.sourceRef.id : undefined,
    combo: item.sourceRef?.model === 'combo' ? item.sourceRef.id : undefined,
    title: item.title,
    quantity: item.quantity,
    price: item.price,
    thumbnail: item.thumbnail,
  }));

  try {
    for (const item of resolvedItems) {
      if (!item.sourceRef) {
        continue;
      }

      const updated =
        item.sourceRef.model === 'combo'
          ? await Combo.findOneAndUpdate(
              { _id: item.sourceRef.id, stock: { $gte: item.quantity } },
              { $inc: { stock: -item.quantity } },
              { new: true }
            )
          : await Product.findOneAndUpdate(
              { _id: item.sourceRef.id, stock: { $gte: item.quantity } },
              { $inc: { stock: -item.quantity } },
              { new: true }
            );

      if (!updated) {
        await rollbackStockChanges(stockChanges);
        res.status(409).json({
          success: false,
          message: 'One or more items are out of stock',
        });
        return;
      }

      stockChanges.push({
        itemType: item.itemType,
        itemId: item.itemId,
        quantity: item.quantity,
      });
    }

    const itemsTotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingFee = SHIPPING_FEES[shippingAddress.deliveryZone];
    const totalAmount = itemsTotal + shippingFee;

    const order = await Order.create({
      orderNumber: generateOrderNumber(),
      user: new mongoose.Types.ObjectId(userId),
      items: orderItems,
      shippingAddress: {
        name: shippingAddress.name.trim(),
        phone: normalizePhone(shippingAddress.phone),
        deliveryZone: shippingAddress.deliveryZone,
        area: shippingAddress.area.trim(),
        address: shippingAddress.address.trim(),
      },
      itemsTotal,
      shippingFee,
      totalAmount,
      paymentMethod,
      paymentStatus: 'pending',
      orderStatus: OrderStatus.PENDING,
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order,
    });
  } catch (error) {
    await rollbackStockChanges(stockChanges);
    console.error('[createOrder]', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
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
