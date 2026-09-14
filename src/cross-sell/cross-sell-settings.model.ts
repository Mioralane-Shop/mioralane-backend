import mongoose, { Document, Schema } from 'mongoose';

export type CrossSellSettingsValue = {
  singletonKey: 'cross_sell_settings';
  enabled: boolean;
  maximumRecommendations: number;
  minimumRecommendedProductPrice: number;
  maximumRecommendedProductPrice?: number | null;
};

export interface ICrossSellSettingsDocument extends CrossSellSettingsValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_CROSS_SELL_SETTINGS: CrossSellSettingsValue = {
  singletonKey: 'cross_sell_settings',
  enabled: true,
  maximumRecommendations: 2,
  minimumRecommendedProductPrice: 0,
  maximumRecommendedProductPrice: null,
};

const CrossSellSettingsSchema = new Schema<ICrossSellSettingsDocument>(
  {
    singletonKey: {
      type: String,
      enum: ['cross_sell_settings'],
      default: 'cross_sell_settings',
      unique: true,
      index: true,
      immutable: true,
    },
    enabled: {
      type: Boolean,
      default: DEFAULT_CROSS_SELL_SETTINGS.enabled,
      required: true,
    },
    maximumRecommendations: {
      type: Number,
      default: DEFAULT_CROSS_SELL_SETTINGS.maximumRecommendations,
      required: true,
      min: [1, 'Maximum recommendations must be greater than zero'],
      validate: {
        validator: Number.isInteger,
        message: 'Maximum recommendations must be a whole number',
      },
    },
    minimumRecommendedProductPrice: {
      type: Number,
      default: DEFAULT_CROSS_SELL_SETTINGS.minimumRecommendedProductPrice,
      required: true,
      min: [0, 'Minimum recommended product price must be zero or greater'],
    },
    maximumRecommendedProductPrice: {
      type: Number,
      default: DEFAULT_CROSS_SELL_SETTINGS.maximumRecommendedProductPrice,
      min: [0, 'Maximum recommended product price must be zero or greater'],
    },
  },
  { timestamps: true }
);

export const CrossSellSettings =
  mongoose.models.CrossSellSettings ||
  mongoose.model<ICrossSellSettingsDocument>('CrossSellSettings', CrossSellSettingsSchema);
