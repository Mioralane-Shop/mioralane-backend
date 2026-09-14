import mongoose from 'mongoose';
import { Product, IProductDocument } from '../product/product.model';
import {
  CrossSellSettings,
  CrossSellSettingsValue,
  DEFAULT_CROSS_SELL_SETTINGS,
} from './cross-sell-settings.model';

type HttpError = Error & { statusCode?: number; code?: string };

export type CrossSellRecommendationInput = {
  productId: unknown;
  priority?: unknown;
  enabled?: unknown;
};

export type NormalizedCrossSellRecommendation = {
  productId: mongoose.Types.ObjectId;
  priority: number;
  enabled: boolean;
};

export type CartRecommendationProduct = {
  id: string;
  slug: string;
  name: string;
  title: string;
  brand: string;
  category: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  media?: unknown[];
  hoverImage?: string;
  stock: number;
  availabilityMode: 'in_stock' | 'pre_order';
  preOrder?: {
    expectedArrivalDate?: Date;
    quantityLimit: number;
    customerMessage?: string;
    status: 'accepting' | 'closed' | 'arrived';
    remainingQuantity: number;
  };
  volume?: string;
  rating: number;
  reviewCount: number;
  tag: 'best' | 'new' | null;
  isBestSeller: boolean;
  isNewArrival: boolean;
  itemType: 'product';
  recommendationPriority: number;
  createdAt: Date;
};

const createCrossSellError = (statusCode: number, message: string, code?: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const isValidObjectId = (value: unknown): value is string =>
  typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

const normalizeOptionalPrice = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createCrossSellError(400, 'Maximum recommended product price must be zero or greater', 'invalid_cross_sell_price');
  }

  return parsed;
};

export const normalizeCrossSellSettingsPayload = (payload: unknown): CrossSellSettingsValue => {
  const body = (payload ?? {}) as Partial<CrossSellSettingsValue>;
  const maximumRecommendations = Number(body.maximumRecommendations);
  const minimumRecommendedProductPrice = Number(body.minimumRecommendedProductPrice ?? 0);
  const maximumRecommendedProductPrice = normalizeOptionalPrice(body.maximumRecommendedProductPrice);

  if (!Number.isInteger(maximumRecommendations) || maximumRecommendations <= 0) {
    throw createCrossSellError(400, 'Maximum recommendations must be a positive whole number', 'invalid_cross_sell_maximum');
  }

  if (!Number.isFinite(minimumRecommendedProductPrice) || minimumRecommendedProductPrice < 0) {
    throw createCrossSellError(400, 'Minimum recommended product price must be zero or greater', 'invalid_cross_sell_price');
  }

  if (
    maximumRecommendedProductPrice !== null &&
    maximumRecommendedProductPrice < minimumRecommendedProductPrice
  ) {
    throw createCrossSellError(
      400,
      'Maximum recommended product price must be greater than or equal to minimum price',
      'invalid_cross_sell_price_range'
    );
  }

  return {
    singletonKey: 'cross_sell_settings',
    enabled: Boolean(body.enabled),
    maximumRecommendations,
    minimumRecommendedProductPrice,
    maximumRecommendedProductPrice,
  };
};

export const serializeCrossSellSettings = (
  settings?: Partial<CrossSellSettingsValue> | null
): CrossSellSettingsValue => ({
  singletonKey: 'cross_sell_settings',
  enabled: settings?.enabled ?? DEFAULT_CROSS_SELL_SETTINGS.enabled,
  maximumRecommendations:
    settings?.maximumRecommendations ?? DEFAULT_CROSS_SELL_SETTINGS.maximumRecommendations,
  minimumRecommendedProductPrice:
    settings?.minimumRecommendedProductPrice ??
    DEFAULT_CROSS_SELL_SETTINGS.minimumRecommendedProductPrice,
  maximumRecommendedProductPrice:
    settings?.maximumRecommendedProductPrice ??
    DEFAULT_CROSS_SELL_SETTINGS.maximumRecommendedProductPrice,
});

export const getCrossSellSettings = async (): Promise<CrossSellSettingsValue> => {
  const settings = await CrossSellSettings.findOneAndUpdate(
    { singletonKey: 'cross_sell_settings' },
    { $setOnInsert: DEFAULT_CROSS_SELL_SETTINGS },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return serializeCrossSellSettings(settings);
};

export const upsertCrossSellSettings = async (payload: unknown): Promise<CrossSellSettingsValue> => {
  const normalized = normalizeCrossSellSettingsPayload(payload);
  const settings = await CrossSellSettings.findOneAndUpdate(
    { singletonKey: 'cross_sell_settings' },
    {
      $set: {
        enabled: normalized.enabled,
        maximumRecommendations: normalized.maximumRecommendations,
        minimumRecommendedProductPrice: normalized.minimumRecommendedProductPrice,
        maximumRecommendedProductPrice: normalized.maximumRecommendedProductPrice,
      },
      $setOnInsert: {
        singletonKey: 'cross_sell_settings',
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return serializeCrossSellSettings(settings);
};

export const normalizeCrossSellRecommendations = async (
  sourceProductId: string | undefined,
  value: unknown
): Promise<NormalizedCrossSellRecommendation[] | undefined> => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw createCrossSellError(400, 'Cross-sell recommendations must be an array', 'invalid_cross_sell_recommendations');
  }

  const seen = new Set<string>();
  const normalized: NormalizedCrossSellRecommendation[] = [];

  for (const row of value as CrossSellRecommendationInput[]) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    if (!isValidObjectId(row.productId)) {
      throw createCrossSellError(400, 'Recommended product ID is invalid', 'invalid_cross_sell_product');
    }

    const productId = row.productId;
    if (sourceProductId && productId === sourceProductId) {
      throw createCrossSellError(400, 'A product cannot recommend itself', 'self_cross_sell_recommendation');
    }

    if (seen.has(productId)) {
      throw createCrossSellError(400, 'Recommended products cannot be duplicated', 'duplicate_cross_sell_recommendation');
    }
    seen.add(productId);

    const priority = row.priority === undefined || row.priority === '' ? 0 : Number(row.priority);
    if (!Number.isFinite(priority) || priority < 0) {
      throw createCrossSellError(400, 'Recommendation priority must be a finite non-negative number', 'invalid_cross_sell_priority');
    }

    normalized.push({
      productId: new mongoose.Types.ObjectId(productId),
      priority,
      enabled: row.enabled !== undefined ? Boolean(row.enabled) : true,
    });
  }

  if (normalized.length > 0) {
    const existingCount = await Product.countDocuments({
      _id: { $in: normalized.map((row) => row.productId) },
    });

    if (existingCount !== normalized.length) {
      throw createCrossSellError(400, 'One or more recommended products do not exist', 'missing_cross_sell_product');
    }
  }

  return normalized.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.productId.toString().localeCompare(b.productId.toString());
  });
};

const getEffectivePrice = (product: IProductDocument): { price: number; compareAtPrice?: number } => {
  const salePrice = product.salePrice;
  if (salePrice != null && Number.isFinite(salePrice) && salePrice >= 0 && salePrice < product.price) {
    return { price: salePrice, compareAtPrice: product.price };
  }

  return { price: product.price };
};

const isProductAvailable = (product: IProductDocument): boolean => {
  if ((product.availabilityMode ?? 'in_stock') === 'pre_order') {
    const quantityLimit = Number(product.preOrder?.quantityLimit ?? 0);
    const reservedQuantity = Number(product.preOrder?.reservedQuantity ?? 0);
    return product.preOrder?.status === 'accepting' && quantityLimit - reservedQuantity > 0;
  }

  return product.stock > 0;
};

const serializeRecommendationProduct = (
  product: IProductDocument,
  recommendationPriority: number
): CartRecommendationProduct => {
  const effectivePrice = getEffectivePrice(product);
  const quantityLimit = Number(product.preOrder?.quantityLimit ?? 0);
  const reservedQuantity = Number(product.preOrder?.reservedQuantity ?? 0);
  const availabilityMode = product.availabilityMode ?? 'in_stock';

  return {
    id: product._id.toString(),
    slug: product.slug,
    name: product.title,
    title: product.title,
    brand: product.brand,
    category: product.category,
    description: product.description || '',
    price: effectivePrice.price,
    compareAtPrice: effectivePrice.compareAtPrice,
    images: product.media?.length ? product.media.map((asset) => asset.url).filter(Boolean) : product.images ?? [],
    media: product.media ?? [],
    hoverImage: product.hoverImage,
    stock: product.stock,
    availabilityMode,
    preOrder:
      availabilityMode === 'pre_order'
        ? {
            expectedArrivalDate: product.preOrder?.expectedArrivalDate,
            quantityLimit,
            customerMessage: product.preOrder?.customerMessage,
            status: product.preOrder?.status ?? 'accepting',
            remainingQuantity: Math.max(quantityLimit - reservedQuantity, 0),
          }
        : undefined,
    volume: product.volume,
    rating: product.rating,
    reviewCount: product.numReviews,
    tag: product.isBestSeller || product.badge === 'Best' ? 'best' : product.isNewArrival || product.badge === 'New' ? 'new' : null,
    isBestSeller: product.isBestSeller,
    isNewArrival: product.isNewArrival,
    itemType: 'product',
    recommendationPriority,
    createdAt: product.createdAt,
  };
};

export const getCartCrossSellRecommendations = async (
  cartProductIds: unknown
): Promise<CartRecommendationProduct[]> => {
  const ids = Array.isArray(cartProductIds) ? cartProductIds : [];
  const uniqueCartIds = Array.from(
    new Set(ids.filter(isValidObjectId))
  );

  if (uniqueCartIds.length !== ids.length) {
    throw createCrossSellError(400, 'Cart product IDs must be valid product IDs', 'invalid_cart_product_ids');
  }

  if (uniqueCartIds.length === 0) {
    return [];
  }

  const settings = await getCrossSellSettings();
  if (!settings.enabled) {
    return [];
  }

  const sourceProducts = await Product.find({ _id: { $in: uniqueCartIds } })
    .select('_id crossSellRecommendations')
    .lean()
    .exec();

  const cartIdSet = new Set(uniqueCartIds);
  const recommendationMap = new Map<string, { productId: string; priority: number; firstIndex: number }>();
  let sequence = 0;

  for (const source of sourceProducts) {
    for (const recommendation of source.crossSellRecommendations ?? []) {
      const productId = recommendation.productId?.toString();
      if (!recommendation.enabled || !productId || cartIdSet.has(productId)) {
        sequence += 1;
        continue;
      }

      const existing = recommendationMap.get(productId);
      if (!existing || recommendation.priority > existing.priority) {
        recommendationMap.set(productId, {
          productId,
          priority: recommendation.priority,
          firstIndex: existing?.firstIndex ?? sequence,
        });
      }
      sequence += 1;
    }
  }

  if (recommendationMap.size === 0) {
    return [];
  }

  const recommendedProducts = await Product.find({
    _id: { $in: Array.from(recommendationMap.keys()) },
  }).exec();

  const filtered = recommendedProducts
    .flatMap((product) => {
      const meta = recommendationMap.get(product._id.toString());
      return meta ? [{ product, ...meta }] : [];
    })
    .filter(({ product }) => {
      if (!isProductAvailable(product)) return false;
      const { price } = getEffectivePrice(product);
      if (price < settings.minimumRecommendedProductPrice) return false;
      if (
        settings.maximumRecommendedProductPrice != null &&
        price > settings.maximumRecommendedProductPrice
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
      return a.productId.localeCompare(b.productId);
    })
    .slice(0, settings.maximumRecommendations);

  return filtered.map(({ product, priority }) => serializeRecommendationProduct(product, priority));
};
