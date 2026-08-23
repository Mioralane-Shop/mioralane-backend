import mongoose from 'mongoose';
import { Response } from 'express';
import { UserModel } from '../auth/user.model';
import { Order } from '../order/order.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getPaginationParams } from '../utils/pagination';
import { OrderStatus } from '../enums/order-status.enum';

type CustomerListItem = {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  joinedAt: Date | string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | string | null;
};

type CustomerOrderSummary = {
  id: string;
  orderNumber: string;
  createdAt: Date | string;
  totalAmount: number;
  paymentStatus: 'pending' | 'paid' | 'failed';
  orderStatus: OrderStatus;
};

type CustomerDetail = {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  joinedAt: Date | string;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isRevenueEligibleOrder = (orderStatus: OrderStatus, paymentStatus: string): boolean =>
  orderStatus === OrderStatus.DELIVERED || paymentStatus === 'paid';

const summarizeOrders = (orders: Array<{
  _id: mongoose.Types.ObjectId;
  orderNumber: string;
  totalAmount: number;
  paymentStatus: 'pending' | 'paid' | 'failed';
  orderStatus: OrderStatus;
  createdAt: Date;
}>) => {
  return orders.reduce(
    (accumulator, order) => {
      accumulator.totalOrders += 1;
      if (isRevenueEligibleOrder(order.orderStatus, order.paymentStatus)) {
        accumulator.totalSpent += order.totalAmount ?? 0;
      }

      if (!accumulator.lastOrderAt || order.createdAt > accumulator.lastOrderAt) {
        accumulator.lastOrderAt = order.createdAt;
      }

      return accumulator;
    },
    {
      totalOrders: 0,
      totalSpent: 0,
      lastOrderAt: null as Date | null,
    }
  );
};

export const getAdminCustomers = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const { page, limit } = getPaginationParams(
    req.query.page ? Number(req.query.page) : 1,
    req.query.limit ? Number(req.query.limit) : 10
  );
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const roleQuery = typeof req.query.role === 'string' ? req.query.role.trim().toLowerCase() : 'user';

  const match: Record<string, unknown> = {};
  if (roleQuery === 'user' || roleQuery === 'admin') {
    match.role = roleQuery;
  } else {
    match.role = 'user';
  }

  if (search) {
    const escaped = escapeRegex(search);
    match.$or = [
      { username: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
    ];
  }

  const [customers, count] = await Promise.all([
    UserModel.find(match)
      .select('username email role createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec(),
    UserModel.countDocuments(match),
  ]);

  const customerIds = customers.map((customer) => customer._id);
  const orderStats = customerIds.length
    ? await Order.aggregate([
        { $match: { user: { $in: customerIds } } },
        {
          $group: {
            _id: '$user',
            totalOrders: { $sum: 1 },
            totalSpent: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$orderStatus', OrderStatus.DELIVERED] },
                      { $eq: ['$paymentStatus', 'paid'] },
                    ],
                  },
                  '$totalAmount',
                  0,
                ],
              },
            },
            lastOrderAt: { $max: '$createdAt' },
          },
        },
      ])
    : [];

  const statsByCustomerId = new Map(
    orderStats.map(
      (item: { _id: mongoose.Types.ObjectId; totalOrders: number; totalSpent: number; lastOrderAt: Date }) =>
        [item._id.toString(), item]
    )
  );

  const responseCustomers: CustomerListItem[] = customers.map((customer) => {
    const stats = statsByCustomerId.get(customer._id.toString());

    return {
      id: customer._id.toString(),
      name: customer.username,
      email: customer.email,
      role: customer.role,
      joinedAt: customer.createdAt,
      totalOrders: stats?.totalOrders ?? 0,
      totalSpent: stats?.totalSpent ?? 0,
      lastOrderAt: stats?.lastOrderAt ?? null,
    };
  });

  res.status(200).json({
    success: true,
    count,
    page,
    limit,
    totalPages: Math.max(Math.ceil(count / limit), 1),
    customers: responseCustomers,
  });
};

export const getAdminCustomerById = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const rawId = req.params.id;
  const customerId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
    res.status(400).json({ success: false, message: 'Invalid customer ID' });
    return;
  }

  const customer = await UserModel.findOne({ _id: customerId, role: 'user' })
    .select('username email role createdAt')
    .lean()
    .exec();

  if (!customer) {
    res.status(404).json({ success: false, message: 'Customer not found' });
    return;
  }

  const orders = await Order.find({ user: customer._id })
    .select('orderNumber totalAmount paymentStatus orderStatus createdAt')
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  const summary = summarizeOrders(orders.map((order) => ({
    ...order,
    _id: order._id,
    createdAt: order.createdAt,
  })));

  const responseOrders: CustomerOrderSummary[] = orders.map((order) => ({
    id: order._id.toString(),
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    totalAmount: order.totalAmount,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
  }));

  const responseCustomer: CustomerDetail = {
    id: customer._id.toString(),
    name: customer.username,
    email: customer.email,
    role: customer.role,
    joinedAt: customer.createdAt,
  };

  res.status(200).json({
    success: true,
    customer: responseCustomer,
    summary: {
      totalOrders: summary.totalOrders,
      totalSpent: summary.totalSpent,
      lastOrderAt: summary.lastOrderAt,
    },
    orders: responseOrders,
  });
};
