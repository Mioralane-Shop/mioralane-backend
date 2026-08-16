import mongoose, { Schema, Document, Model } from 'mongoose';
import { OrderStatus } from '../enums/order-status.enum';

export type PaymentMethod = 'cash_on_delivery';
export type PaymentStatus = 'pending' | 'paid' | 'failed';
export type DeliveryZone = 'inside_dhaka' | 'outside_dhaka';
export type OrderItemType = 'product' | 'combo';

export interface IOrderItem {
  itemType: OrderItemType;
  sourceId: string;
  product?: mongoose.Types.ObjectId;
  combo?: mongoose.Types.ObjectId;
  title: string;
  quantity: number;
  price: number;
  thumbnail: string;
}

export interface IShippingAddress {
  name: string;
  phone: string;
  deliveryZone: DeliveryZone;
  area: string;
  address: string;
}

export interface IOrder {
  orderNumber: string;
  user: mongoose.Types.ObjectId;
  items: IOrderItem[];
  shippingAddress: IShippingAddress;
  itemsTotal: number;
  shippingFee: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
}

export interface IOrderDocument extends IOrder, Document {
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    itemType: {
      type: String,
      enum: ['product', 'combo'],
      required: true,
    },
    sourceId: {
      type: String,
      required: true,
      trim: true,
    },
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    combo: {
      type: Schema.Types.ObjectId,
      ref: 'Combo',
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    thumbnail: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const ShippingAddressSchema = new Schema<IShippingAddress>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    deliveryZone: {
      type: String,
      enum: ['inside_dhaka', 'outside_dhaka'],
      required: true,
    },
    area: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const OrderSchema = new Schema<IOrderDocument>(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (items: IOrderItem[]) => Array.isArray(items) && items.length > 0,
        message: 'At least one order item is required',
      },
    },
    shippingAddress: {
      type: ShippingAddressSchema,
      required: true,
    },
    itemsTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    shippingFee: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ['cash_on_delivery'],
      default: 'cash_on_delivery',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },
    orderStatus: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as unknown as Record<string, unknown> & {
          _id?: { toString: () => string };
          user?: { toString: () => string };
          items?: Array<
            Record<string, unknown> & {
              product?: { toString: () => string } | null;
              combo?: { toString: () => string } | null;
            }
          >;
        };

        if (r._id) {
          r.id = r._id.toString();
          delete r._id;
        }

        delete r.__v;

        if (r.user) {
          r.userId = r.user.toString();
        }

        if (Array.isArray(r.items)) {
          r.items = r.items.map((item) => {
            const product = item.product;
            const combo = item.combo;
            return {
              ...item,
              productId: product ? product.toString() : undefined,
              comboId: combo ? combo.toString() : undefined,
            };
          });
        }

        r.status = r.orderStatus;
        r.trackingStatus = r.orderStatus;
        r.orderId = r.orderNumber;

        return r;
      },
    },
  }
);

export const Order = mongoose.models.Order || mongoose.model<IOrderDocument>('Order', OrderSchema);

export default Order;
