import mongoose, { Schema, Document, Model } from 'mongoose';
import { OrderStatus } from '../enums/order-status.enum';

export type PaymentMethod = 'cash_on_delivery';
export type PaymentStatus = 'pending' | 'paid' | 'failed';
export type DeliveryZone = 'inside_dhaka' | 'dhaka_suburban' | 'outside_dhaka';
export type OrderItemType = 'product' | 'combo';
export type FulfillmentType = 'regular' | 'pre_order';

export interface IOrderItem {
  itemType: OrderItemType;
  sourceId: string;
  product?: mongoose.Types.ObjectId;
  combo?: mongoose.Types.ObjectId;
  title: string;
  quantity: number;
  price: number;
  thumbnail: string;
  fulfillmentType?: FulfillmentType;
  preOrderSnapshot?: {
    expectedArrivalDate?: Date;
    customerMessage?: string;
    quantityLimit?: number;
  };
}

export interface IShippingAddress {
  name: string;
  phone: string;
  division?: string;
  district?: string;
  deliveryZone: DeliveryZone;
  area: string;
  address: string;
  landmark?: string;
}

export interface IOrderShippingSnapshot {
  zone: DeliveryZone;
  baseCharge: number;
  finalCharge: number;
  isFreeDelivery: boolean;
  freeDeliveryReason?: 'threshold' | 'campaign';
  estimatedMinDays: number;
  estimatedMaxDays: number;
}

export interface IOrder {
  orderNumber: string;
  user: mongoose.Types.ObjectId;
  items: IOrderItem[];
  shippingAddress: IShippingAddress;
  itemsTotal: number;
  discountAmount: number;
  shippingFee: number;
  shipping?: IOrderShippingSnapshot;
  totalAmount: number;
  promotion?: {
    campaignId?: mongoose.Types.ObjectId;
    campaignName?: string;
    campaignType?: string;
  };
  coupon?: {
    couponId?: mongoose.Types.ObjectId;
    code?: string;
    discountType?: string;
    discountValue?: number;
    discountAmount?: number;
  };
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  containsPreOrder?: boolean;
  expectedReadinessDate?: Date;
  preOrderReservationsReleased?: boolean;
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
    fulfillmentType: {
      type: String,
      enum: ['regular', 'pre_order'],
      default: 'regular',
    },
    preOrderSnapshot: {
      expectedArrivalDate: {
        type: Date,
        default: undefined,
      },
      customerMessage: {
        type: String,
        trim: true,
        default: undefined,
      },
      quantityLimit: {
        type: Number,
        min: 0,
        default: undefined,
      },
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
    division: {
      type: String,
      trim: true,
      default: undefined,
    },
    district: {
      type: String,
      trim: true,
      default: undefined,
    },
    deliveryZone: {
      type: String,
      enum: ['inside_dhaka', 'dhaka_suburban', 'outside_dhaka'],
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
    landmark: {
      type: String,
      trim: true,
      default: undefined,
    },
  },
  { _id: false }
);

const OrderShippingSnapshotSchema = new Schema<IOrderShippingSnapshot>(
  {
    zone: {
      type: String,
      enum: ['inside_dhaka', 'dhaka_suburban', 'outside_dhaka'],
      required: true,
    },
    baseCharge: {
      type: Number,
      required: true,
      min: 0,
    },
    finalCharge: {
      type: Number,
      required: true,
      min: 0,
    },
    isFreeDelivery: {
      type: Boolean,
      required: true,
      default: false,
    },
    freeDeliveryReason: {
      type: String,
      enum: ['threshold', 'campaign'],
      default: undefined,
    },
    estimatedMinDays: {
      type: Number,
      required: true,
      min: 0,
    },
    estimatedMaxDays: {
      type: Number,
      required: true,
      min: 0,
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
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    shippingFee: {
      type: Number,
      required: true,
      min: 0,
    },
    shipping: {
      type: OrderShippingSnapshotSchema,
      default: undefined,
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
    promotion: {
      campaignId: {
        type: Schema.Types.ObjectId,
        ref: 'PromotionCampaign',
        default: undefined,
      },
      campaignName: {
        type: String,
        trim: true,
        default: undefined,
      },
      campaignType: {
        type: String,
        trim: true,
        default: undefined,
      },
    },
    coupon: {
      couponId: {
        type: Schema.Types.ObjectId,
        ref: 'Coupon',
        default: undefined,
      },
      code: {
        type: String,
        trim: true,
        default: undefined,
      },
      discountType: {
        type: String,
        trim: true,
        default: undefined,
      },
      discountValue: {
        type: Number,
        min: 0,
        default: undefined,
      },
      discountAmount: {
        type: Number,
        min: 0,
        default: undefined,
      },
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
    containsPreOrder: {
      type: Boolean,
      default: false,
      index: true,
    },
    expectedReadinessDate: {
      type: Date,
      default: undefined,
    },
    preOrderReservationsReleased: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as unknown as Record<string, unknown> & {
          _id?: { toString: () => string };
          user?: { toString: () => string };
          shippingAddress?: Record<string, unknown> & {
            address?: string;
            fullAddress?: string;
          };
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

        // Read-only alias: the order keeps a frozen snapshot of the delivery
        // address under `address`; expose it as `fullAddress` too so saved
        // address book entries and order snapshots share one field name.
        if (r.shippingAddress && r.shippingAddress.address !== undefined) {
          r.shippingAddress.fullAddress = r.shippingAddress.address;
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
