import mongoose, { Document, Schema } from 'mongoose';
import { DeliveryZone } from '../order/order.model';

export type ShippingZoneSettings = {
  enabled: boolean;
  charge: number;
  estimatedMinDays: number;
  estimatedMaxDays: number;
};

export type ShippingSettingsValue = {
  singletonKey: 'shipping_settings';
  zones: Record<DeliveryZone, ShippingZoneSettings>;
  freeDeliveryThreshold: {
    enabled: boolean;
    minimumOrderValue: number;
  };
  addressRequirements: {
    landmarkRequired: boolean;
  };
};

export interface IShippingSettingsDocument extends ShippingSettingsValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettingsValue = {
  singletonKey: 'shipping_settings',
  zones: {
    inside_dhaka: {
      enabled: true,
      charge: 80,
      estimatedMinDays: 1,
      estimatedMaxDays: 2,
    },
    dhaka_suburban: {
      enabled: true,
      charge: 100,
      estimatedMinDays: 1,
      estimatedMaxDays: 3,
    },
    outside_dhaka: {
      enabled: true,
      charge: 150,
      estimatedMinDays: 2,
      estimatedMaxDays: 4,
    },
  },
  freeDeliveryThreshold: {
    enabled: true,
    minimumOrderValue: 2000,
  },
  addressRequirements: {
    landmarkRequired: false,
  },
};

const ZoneSettingsSchema = new Schema<ShippingZoneSettings>(
  {
    enabled: { type: Boolean, required: true, default: true },
    charge: { type: Number, required: true, min: 0 },
    estimatedMinDays: { type: Number, required: true, min: 0 },
    estimatedMaxDays: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ShippingSettingsSchema = new Schema<IShippingSettingsDocument>(
  {
    singletonKey: {
      type: String,
      enum: ['shipping_settings'],
      default: 'shipping_settings',
      unique: true,
      index: true,
      immutable: true,
    },
    zones: {
      inside_dhaka: { type: ZoneSettingsSchema, required: true },
      dhaka_suburban: { type: ZoneSettingsSchema, required: true, default: DEFAULT_SHIPPING_SETTINGS.zones.dhaka_suburban },
      outside_dhaka: { type: ZoneSettingsSchema, required: true },
    },
    freeDeliveryThreshold: {
      enabled: { type: Boolean, required: true, default: true },
      minimumOrderValue: { type: Number, required: true, min: 0, default: 2000 },
    },
    addressRequirements: {
      landmarkRequired: { type: Boolean, required: true, default: false },
    },
  },
  { timestamps: true }
);

ShippingSettingsSchema.pre('validate', function validateEstimatedDays() {
  const zones = this.zones;

  for (const zone of ['inside_dhaka', 'dhaka_suburban', 'outside_dhaka'] as DeliveryZone[]) {
    if (zones[zone].estimatedMinDays > zones[zone].estimatedMaxDays) {
      this.invalidate(`zones.${zone}.estimatedMinDays`, 'Estimated minimum days must be less than or equal to maximum days');
    }
  }

});

export const ShippingSettings =
  mongoose.models.ShippingSettings ||
  mongoose.model<IShippingSettingsDocument>('ShippingSettings', ShippingSettingsSchema);
