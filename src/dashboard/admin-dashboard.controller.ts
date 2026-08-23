import { Response } from 'express';
import mongoose from 'mongoose';
import { OrderStatus } from '../enums/order-status.enum';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { Combo } from '../combo/combo.model';
import { Order } from '../order/order.model';
import { Product } from '../product/product.model';
import { UserModel } from '../auth/user.model';

const LOW_STOCK_THRESHOLD = 5;
const RECENT_ORDERS_LIMIT = 5;
const INVENTORY_ATTENTION_LIMIT = 10;

type DashboardOrderCustomer = {
  name: string;
  phone: string;
  email?: string;
};

type DashboardRecentOrder = {
  id: string;
  orderNumber: string;
  customer: DashboardOrderCustomer;
  createdAt?: string | Date;
  totalAmount: number;
  paymentStatus: 'pending' | 'paid' | 'failed';
  orderStatus: OrderStatus;
};

type DashboardInventoryAttentionItem = {
  id: string;
  itemType: 'product' | 'combo';
  title: string;
  stock: number;
  context: string;
};

type DashboardSummaryResponse = {
  totalOrders: number;
  totalProducts: number;
  lowStockCount: number;
  completedRevenue: number;
  orderStatusCounts: Record<OrderStatus, number>;
  recentOrders: DashboardRecentOrder[];
  inventoryAttention: DashboardInventoryAttentionItem[];
};

type OrderStatusCountRow = {
  _id?: OrderStatus;
  count?: number;
};

type RecentOrderRow = {
  _id?: mongoose.Types.ObjectId;
  orderNumber?: string;
  createdAt?: Date;
  totalAmount?: number;
  paymentStatus?: 'pending' | 'paid' | 'failed';
  orderStatus?: OrderStatus;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
};

type ProductAttentionRow = {
  _id?: mongoose.Types.ObjectId;
  title?: string;
  stock?: number;
  brand?: string;
};

type ComboAttentionRow = {
  _id?: mongoose.Types.ObjectId;
  title?: string;
  stock?: number;
  routineTag?: string;
  brand?: string;
};

const ORDER_STATUS_VALUES = Object.values(OrderStatus);

const buildEmptyOrderStatusCounts = (): Record<OrderStatus, number> =>
  Object.fromEntries(ORDER_STATUS_VALUES.map((status) => [status, 0])) as Record<OrderStatus, number>;

const sortInventoryAttention = (left: DashboardInventoryAttentionItem, right: DashboardInventoryAttentionItem) => {
  if (left.stock !== right.stock) {
    return left.stock - right.stock;
  }

  return left.title.localeCompare(right.title);
};

export const getAdminDashboardSummary = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const lowStockMatch = { stock: { $lte: LOW_STOCK_THRESHOLD } };

    const [
      totalOrders,
      totalProducts,
      lowStockProducts,
      lowStockCombos,
      completedRevenueResult,
      orderStatusRows,
      recentOrderRows,
      productAttentionRows,
      comboAttentionRows,
    ] = await Promise.all([
      Order.countDocuments({}),
      Product.countDocuments({}),
      Product.countDocuments(lowStockMatch),
      Combo.countDocuments(lowStockMatch),
      Order.aggregate<{ completedRevenue?: number }>([
        {
          $match: {
            $or: [{ orderStatus: OrderStatus.DELIVERED }, { paymentStatus: 'paid' }],
          },
        },
        {
          $group: {
            _id: null,
            completedRevenue: { $sum: '$totalAmount' },
          },
        },
      ]),
      Order.aggregate<OrderStatusCountRow>([
        {
          $group: {
            _id: { $ifNull: ['$orderStatus', OrderStatus.PENDING] },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate<RecentOrderRow>([
        { $sort: { createdAt: -1 } },
        { $limit: RECENT_ORDERS_LIMIT },
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
        {
          $project: {
            orderNumber: 1,
            createdAt: 1,
            totalAmount: 1,
            paymentStatus: 1,
            orderStatus: 1,
            customerName: {
              $ifNull: ['$shippingAddress.name', '$user.username'],
            },
            customerPhone: {
              $ifNull: ['$shippingAddress.phone', ''],
            },
            customerEmail: '$user.email',
          },
        },
      ]),
      Product.aggregate<ProductAttentionRow>([
        { $match: lowStockMatch },
        { $sort: { stock: 1, updatedAt: -1, createdAt: -1 } },
        { $limit: INVENTORY_ATTENTION_LIMIT },
        {
          $project: {
            title: 1,
            stock: 1,
            brand: 1,
          },
        },
      ]),
      Combo.aggregate<ComboAttentionRow>([
        { $match: lowStockMatch },
        { $sort: { stock: 1, updatedAt: -1, createdAt: -1 } },
        { $limit: INVENTORY_ATTENTION_LIMIT },
        {
          $project: {
            title: 1,
            stock: 1,
            routineTag: 1,
            brand: 1,
          },
        },
      ]),
    ]);

    const orderStatusCounts = buildEmptyOrderStatusCounts();
    for (const row of orderStatusRows) {
      const status = row._id;
      if (status && ORDER_STATUS_VALUES.includes(status)) {
        orderStatusCounts[status] = row.count ?? 0;
      }
    }

    const recentOrders: DashboardRecentOrder[] = recentOrderRows.map((order) => ({
      id: order._id?.toString() ?? '',
      orderNumber: order.orderNumber ?? '',
      customer: {
        name: order.customerName ?? 'Unknown customer',
        phone: order.customerPhone ?? '',
        email: order.customerEmail,
      },
      createdAt: order.createdAt,
      totalAmount: order.totalAmount ?? 0,
      paymentStatus: order.paymentStatus ?? 'pending',
      orderStatus: order.orderStatus ?? OrderStatus.PENDING,
    }));

    const inventoryAttention = [...productAttentionRows, ...comboAttentionRows]
      .map<DashboardInventoryAttentionItem>((item) => ({
        id: item._id?.toString() ?? '',
        itemType: 'routineTag' in item ? 'combo' : 'product',
        title: item.title ?? 'Untitled item',
        stock: item.stock ?? 0,
        context: String(
          'routineTag' in item
            ? item.routineTag ?? item.brand ?? '—'
            : item.brand ?? '—'
        ),
      }))
      .sort(sortInventoryAttention)
      .slice(0, INVENTORY_ATTENTION_LIMIT);

    const completedRevenue = completedRevenueResult[0]?.completedRevenue ?? 0;

    const response: DashboardSummaryResponse = {
      totalOrders,
      totalProducts,
      lowStockCount: lowStockProducts + lowStockCombos,
      completedRevenue,
      orderStatusCounts,
      recentOrders,
      inventoryAttention,
    };

    res.status(200).json({
      success: true,
      ...response,
    });
  } catch (error) {
    console.error('[getAdminDashboardSummary]', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};
