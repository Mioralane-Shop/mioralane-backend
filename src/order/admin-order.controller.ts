import mongoose, { PipelineStage } from 'mongoose';
import { Response } from 'express';
import { OrderStatus } from '../enums/order-status.enum';
import { UserModel } from '../auth/user.model';
import { Order } from './order.model';
import { Product } from '../product/product.model';
import { Combo } from '../combo/combo.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getPaginationParams } from '../utils/pagination';

type AdminOrderUser = {
  id: string;
  username: string;
  email?: string;
  role?: 'user' | 'admin';
};

type AdminOrderItem = {
  itemType: 'product' | 'combo';
  sourceId: string;
  productId?: string;
  comboId?: string;
  title: string;
  quantity: number;
  price: number;
  thumbnail: string;
};

type RawOrderUser =
  | string
  | mongoose.Types.ObjectId
  | {
      _id?: string | mongoose.Types.ObjectId;
      username?: string;
      email?: string;
      role?: 'user' | 'admin';
    }
  | null
  | undefined;

type RawOrderRecord = {
  _id?: string | mongoose.Types.ObjectId;
  orderNumber?: string;
  user?: RawOrderUser;
  items?: Array<{
    itemType?: 'product' | 'combo';
    sourceId?: string;
    product?: string | mongoose.Types.ObjectId | null;
    combo?: string | mongoose.Types.ObjectId | null;
    title?: string;
    quantity?: number;
    price?: number;
    thumbnail?: string;
  }>;
  shippingAddress?: {
    name?: string;
    phone?: string;
    deliveryZone?: 'inside_dhaka' | 'outside_dhaka';
    area?: string;
    address?: string;
  };
  itemsTotal?: number;
  shippingFee?: number;
  totalAmount?: number;
  paymentMethod?: 'cash_on_delivery';
  paymentStatus?: 'pending' | 'paid' | 'failed';
  orderStatus?: OrderStatus;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

type AdminOrderSummary = {
  id: string;
  orderNumber: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  createdAt?: string | Date;
  items: AdminOrderItem[];
  itemsCount: number;
  totalAmount: number;
  paymentMethod?: 'cash_on_delivery';
  paymentStatus?: 'pending' | 'paid' | 'failed';
  orderStatus: OrderStatus;
  status: OrderStatus;
  trackingStatus: OrderStatus;
};

type AdminOrderDetail = AdminOrderSummary & {
  userId?: string;
  shippingAddress: {
    name: string;
    phone: string;
    deliveryZone: 'inside_dhaka' | 'outside_dhaka';
    area: string;
    address: string;
  };
  itemsTotal: number;
  shippingFee: number;
  updatedAt?: string | Date;
};

const ALLOWED_ORDER_STATUSES = Object.values(OrderStatus);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type HttpError = Error & { statusCode?: number };

const createHttpError = (statusCode: number, message: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const isValidOrderStatus = (status: unknown): status is OrderStatus =>
  typeof status === 'string' && ALLOWED_ORDER_STATUSES.includes(status as OrderStatus);

const restoreCancelledOrderItemStock = async (
  item: NonNullable<RawOrderRecord['items']>[number],
  session: mongoose.ClientSession
): Promise<void> => {
  if (item.itemType !== 'product' && item.itemType !== 'combo') {
    throw createHttpError(400, `Order item ${item.title ?? 'unknown item'} has an invalid itemType`);
  }

  if (!item.sourceId || !mongoose.Types.ObjectId.isValid(item.sourceId)) {
    throw createHttpError(
      400,
      `Order item ${item.title ?? 'unknown item'} is missing a valid catalog reference`
    );
  }

  const quantity = item.quantity ?? 0;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw createHttpError(
      400,
      `Order item ${item.title ?? 'unknown item'} has an invalid quantity`
    );
  }

  const updatedItem =
    item.itemType === 'combo'
      ? await Combo.findByIdAndUpdate(
          item.sourceId,
          { $inc: { stock: quantity } },
          { new: true, session }
        ).exec()
      : await Product.findByIdAndUpdate(
          item.sourceId,
          { $inc: { stock: quantity } },
          { new: true, session }
        ).exec();

  if (!updatedItem) {
    throw createHttpError(
      404,
      `Referenced ${item.itemType} was not found for cancelled order item ${item.title ?? item.sourceId}`
    );
  }
};

const formatOrderUser = (user: RawOrderUser): AdminOrderUser | undefined => {
  if (!user || typeof user === 'string' || user instanceof mongoose.Types.ObjectId) {
    return undefined;
  }

  const idValue = user._id?.toString();
  if (!idValue) {
    return undefined;
  }

  return {
    id: idValue,
    username: user.username ?? 'Unknown customer',
    email: user.email,
    role: user.role,
  };
};

const formatOrderItems = (items: RawOrderRecord['items']): AdminOrderItem[] =>
  (items ?? []).map((item) => ({
    itemType: item.itemType ?? 'product',
    sourceId: item.sourceId ?? '',
    productId: item.product ? item.product.toString() : undefined,
    comboId: item.combo ? item.combo.toString() : undefined,
    title: item.title ?? 'Untitled item',
    quantity: item.quantity ?? 0,
    price: item.price ?? 0,
    thumbnail: item.thumbnail ?? '',
  }));

const formatOrder = (order: RawOrderRecord): AdminOrderSummary | AdminOrderDetail => {
  const id = order._id?.toString() ?? '';
  const items = formatOrderItems(order.items);
  const customerUser = formatOrderUser(order.user);
  const shippingName = order.shippingAddress?.name?.trim() || customerUser?.username || 'Unknown customer';
  const shippingPhone = order.shippingAddress?.phone?.trim() || '';

  const base = {
    id,
    orderNumber: order.orderNumber ?? '',
    customer: {
      name: shippingName,
      phone: shippingPhone,
      email: customerUser?.email,
    },
    createdAt: order.createdAt,
    items,
    itemsCount: items.length,
    totalAmount: order.totalAmount ?? 0,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus ?? OrderStatus.PENDING,
    status: order.orderStatus ?? OrderStatus.PENDING,
    trackingStatus: order.orderStatus ?? OrderStatus.PENDING,
  };

  if (!order.shippingAddress) {
    return base;
  }

  return {
    ...base,
    userId: customerUser?.id,
    shippingAddress: {
      name: shippingName,
      phone: shippingPhone,
      deliveryZone: order.shippingAddress.deliveryZone ?? 'inside_dhaka',
      area: order.shippingAddress.area ?? '',
      address: order.shippingAddress.address ?? '',
    },
    itemsTotal: order.itemsTotal ?? 0,
    shippingFee: order.shippingFee ?? 0,
    updatedAt: order.updatedAt,
  };
};

const buildBaseMatch = (orderStatus: string | undefined, paymentStatus: string | undefined) => {
  const match: Record<string, unknown> = {};

  if (isValidOrderStatus(orderStatus)) {
    match.orderStatus = orderStatus;
  }

  if (paymentStatus && ['pending', 'paid', 'failed'].includes(paymentStatus)) {
    match.paymentStatus = paymentStatus;
  }

  return match;
};

const buildSearchMatch = (search: string | undefined) => {
  const query = search?.trim();
  if (!query) {
    return null;
  }

  const escaped = escapeRegex(query);

  return {
    $or: [
      { orderNumber: { $regex: escaped, $options: 'i' } },
      { 'shippingAddress.name': { $regex: escaped, $options: 'i' } },
      { 'shippingAddress.phone': { $regex: escaped, $options: 'i' } },
      { 'shippingAddress.area': { $regex: escaped, $options: 'i' } },
      { 'user.username': { $regex: escaped, $options: 'i' } },
      { 'user.email': { $regex: escaped, $options: 'i' } },
    ],
  };
};

export const getAdminOrders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { page, limit } = getPaginationParams(
    req.query.page ? Number(req.query.page) : 1,
    req.query.limit ? Number(req.query.limit) : 10
  );
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const orderStatus = typeof req.query.orderStatus === 'string' ? req.query.orderStatus : undefined;
  const paymentStatus = typeof req.query.paymentStatus === 'string' ? req.query.paymentStatus : undefined;

  const baseMatch = buildBaseMatch(orderStatus, paymentStatus);
  const searchMatch = buildSearchMatch(search);

  const pipeline: PipelineStage[] = [
    { $match: baseMatch },
    {
      $lookup: {
        from: UserModel.collection.name,
        localField: 'user',
        foreignField: '_id',
        as: 'user',
      },
    },
    {
      $unwind: {
        path: '$user',
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  if (searchMatch) {
    pipeline.push({ $match: searchMatch });
  }

  pipeline.push(
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        meta: [{ $count: 'count' }],
      },
    },
  );

  const [result] = await Order.aggregate(pipeline);

  const orders = (result?.items ?? []).map((order: RawOrderRecord) => formatOrder(order) as AdminOrderSummary);
  const total = result?.meta?.[0]?.count ?? 0;

  res.status(200).json({
    success: true,
    count: orders.length,
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
    orders,
  });
};

export const getAdminOrderById = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const rawId = req.params.id;
  const orderId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400).json({ success: false, message: 'Invalid order ID' });
    return;
  }

  const order = (await Order.findById(orderId).lean().exec()) as RawOrderRecord | null;

  if (!order) {
    res.status(404).json({ success: false, message: 'Order not found' });
    return;
  }

  const customer = await UserModel.findById(order.user ?? undefined)
    .select('username email role')
    .lean()
    .exec();

  const responseOrder = formatOrder({
    ...order,
    user: customer
      ? {
          _id: customer._id,
          username: customer.username,
          email: customer.email,
          role: customer.role,
        }
      : order.user,
  }) as AdminOrderDetail;

  res.status(200).json({
    success: true,
    order: responseOrder,
  });
};

export const updateAdminOrderStatus = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const rawId = req.params.id;
  const orderId = Array.isArray(rawId) ? rawId[0] : rawId;
  const nextStatus = req.body?.orderStatus;

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400).json({ success: false, message: 'Invalid order ID' });
    return;
  }

  if (!isValidOrderStatus(nextStatus)) {
    res.status(400).json({
      success: false,
      message: `orderStatus must be one of: ${ALLOWED_ORDER_STATUSES.join(', ')}`,
    });
    return;
  }

  const session = await mongoose.startSession();

  try {
    const updatedOrder = (await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session).exec();

      if (!order) {
        throw createHttpError(404, 'Order not found');
      }

      const currentStatus = order.orderStatus ?? OrderStatus.PENDING;

      if (currentStatus === OrderStatus.CANCELLED && nextStatus !== OrderStatus.CANCELLED) {
        throw createHttpError(
          400,
          'Cancelled orders cannot be moved back to a fulfillment status'
        );
      }

      if (currentStatus === nextStatus) {
        return order.toObject() as RawOrderRecord;
      }

      if (nextStatus === OrderStatus.CANCELLED) {
        for (const item of order.items) {
          await restoreCancelledOrderItemStock(item as NonNullable<RawOrderRecord['items']>[number], session);
        }
      }

      order.orderStatus = nextStatus;
      await order.save({ session });

      return order.toObject() as RawOrderRecord;
    })) as RawOrderRecord;

    const customer = await UserModel.findById(updatedOrder.user ?? undefined)
      .select('username email role')
      .lean()
      .exec();

    res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      order: formatOrder({
        ...updatedOrder,
        user: customer
          ? {
              _id: customer._id,
              username: customer.username,
              email: customer.email,
              role: customer.role,
            }
          : updatedOrder.user,
      }),
    });
  } catch (error) {
    const httpError = error as HttpError;
    const transactionUnsupported =
      error instanceof Error &&
      /transaction numbers are only allowed|replica set|mongos|Transaction numbers/i.test(
        error.message
      );

    if (transactionUnsupported) {
      res.status(503).json({
        success: false,
        message:
          'MongoDB transactions are not supported by the current deployment topology. Order cancellation cannot complete safely without a replica set or compatible MongoDB setup.',
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

    console.error('[updateAdminOrderStatus]', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  } finally {
    await session.endSession();
  }
};
