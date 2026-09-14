import mongoose, { Document, Schema } from 'mongoose';

export type InventorySettingsValue = {
  singletonKey: 'inventory_settings';
  defaultLowStockThreshold: number;
};

export interface IInventorySettingsDocument extends InventorySettingsValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettingsValue = {
  singletonKey: 'inventory_settings',
  defaultLowStockThreshold: 5,
};

const InventorySettingsSchema = new Schema<IInventorySettingsDocument>(
  {
    singletonKey: {
      type: String,
      enum: ['inventory_settings'],
      default: 'inventory_settings',
      unique: true,
      index: true,
      immutable: true,
    },
    defaultLowStockThreshold: {
      type: Number,
      required: true,
      default: DEFAULT_INVENTORY_SETTINGS.defaultLowStockThreshold,
      min: [0, 'Default low stock threshold must be zero or greater'],
      validate: {
        validator: Number.isInteger,
        message: 'Default low stock threshold must be a whole number',
      },
    },
  },
  { timestamps: true }
);

export const InventorySettings =
  mongoose.models.InventorySettings ||
  mongoose.model<IInventorySettingsDocument>('InventorySettings', InventorySettingsSchema);
