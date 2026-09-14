import { PipelineStage } from 'mongoose';
import {
  DEFAULT_INVENTORY_SETTINGS,
  InventorySettings,
  InventorySettingsValue,
} from './inventory-settings.model';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export type StockThresholdSource = {
  lowStockThreshold?: number | null;
};

type HttpError = Error & { statusCode?: number; code?: string };

const createInventoryError = (statusCode: number, message: string, code?: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export const validateLowStockThreshold = (value: unknown, label = 'Low stock threshold'): number => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw createInventoryError(400, `${label} must be a valid number`, 'invalid_low_stock_threshold');
  }

  if (!Number.isInteger(parsed)) {
    throw createInventoryError(400, `${label} must be a whole number`, 'invalid_low_stock_threshold');
  }

  if (parsed < 0) {
    throw createInventoryError(400, `${label} must be zero or greater`, 'invalid_low_stock_threshold');
  }

  return parsed;
};

export const normalizeOptionalLowStockThreshold = (value: unknown): number | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  return validateLowStockThreshold(value);
};

export const getInventorySettings = async (): Promise<InventorySettingsValue> => {
  const settings = await InventorySettings.findOneAndUpdate(
    { singletonKey: 'inventory_settings' },
    { $setOnInsert: DEFAULT_INVENTORY_SETTINGS },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return {
    singletonKey: 'inventory_settings',
    defaultLowStockThreshold:
      settings?.defaultLowStockThreshold ?? DEFAULT_INVENTORY_SETTINGS.defaultLowStockThreshold,
  };
};

export const upsertInventorySettings = async (payload: unknown): Promise<InventorySettingsValue> => {
  const candidate = payload as Partial<InventorySettingsValue> | undefined;
  const defaultLowStockThreshold = validateLowStockThreshold(
    candidate?.defaultLowStockThreshold,
    'Default low stock threshold'
  );

  const settings = await InventorySettings.findOneAndUpdate(
    { singletonKey: 'inventory_settings' },
    {
      $set: {
        defaultLowStockThreshold,
      },
      $setOnInsert: {
        singletonKey: 'inventory_settings',
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return {
    singletonKey: 'inventory_settings',
    defaultLowStockThreshold:
      settings?.defaultLowStockThreshold ?? DEFAULT_INVENTORY_SETTINGS.defaultLowStockThreshold,
  };
};

export const getEffectiveLowStockThreshold = (
  item: StockThresholdSource,
  defaultLowStockThreshold: number
): number =>
  item.lowStockThreshold !== undefined && item.lowStockThreshold !== null
    ? item.lowStockThreshold
    : defaultLowStockThreshold;

export const getStockStatus = (stock: number, effectiveLowStockThreshold: number): StockStatus => {
  if (stock <= 0) {
    return 'out_of_stock';
  }

  if (stock <= effectiveLowStockThreshold) {
    return 'low_stock';
  }

  return 'in_stock';
};

export const productEffectiveThresholdExpression = (defaultLowStockThreshold: number) => ({
  $ifNull: ['$lowStockThreshold', defaultLowStockThreshold],
});

export const productRestockMatchExpression = (defaultLowStockThreshold: number): PipelineStage.Match => ({
  $match: {
    availabilityMode: { $ne: 'pre_order' },
    $expr: {
      $or: [
        { $lte: ['$stock', 0] },
        {
          $and: [
            { $gt: ['$stock', 0] },
            { $lte: ['$stock', productEffectiveThresholdExpression(defaultLowStockThreshold)] },
          ],
        },
      ],
    },
  },
});

export const productLowStockFilter = (defaultLowStockThreshold: number): Record<string, unknown> => ({
  availabilityMode: { $ne: 'pre_order' },
  $expr: {
    $and: [
      { $gt: ['$stock', 0] },
      { $lte: ['$stock', productEffectiveThresholdExpression(defaultLowStockThreshold)] },
    ],
  },
});

export const comboLowStockFilter = (defaultLowStockThreshold: number): Record<string, unknown> => ({
  stock: {
    $gt: 0,
    $lte: defaultLowStockThreshold,
  },
});
