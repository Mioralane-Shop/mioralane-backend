import { Request, Response } from 'express';
import { Product, IProduct, IProductDocument } from './product.model';
import { getPaginationParams } from '../utils/pagination';
import { slugify } from '../utils/slugify';
import mongoose from 'mongoose';
import { extractMediaUrls, normalizeMediaAssets } from '../media/media.utils';
import type { MediaAsset } from '../media/media.types';
import { normalizeOptionalLowStockThreshold } from '../inventory/inventory.service';

// ─── Types ────────────────────────────────────────────────────────────────

interface ProductQueryParams {
  tab?: string;
  brand?: string;
  category?: string;
  skinType?: string;
  skinConcern?: string;
  concern?: string;
  search?: string;
  sort?: string;
  featured?: string;
  bestSeller?: string;
  inStock?: string;
  minPrice?: string;
  maxPrice?: string;
  page?: string;
  limit?: string;
}

type ProductAggregateRow = Record<string, any>;
type ProductMutationBody = Partial<
  Pick<
    IProduct,
    | 'title'
    | 'slug'
    | 'brand'
    | 'category'
    | 'description'
    | 'ingredients'
    | 'howToUse'
    | 'keyIngredients'
    | 'skinType'
    | 'skinConcern'
    | 'price'
    | 'salePrice'
    | 'badge'
    | 'images'
    | 'media'
    | 'hoverImage'
    | 'volume'
    | 'stock'
    | 'lowStockThreshold'
    | 'availabilityMode'
    | 'preOrder'
    | 'isBestSeller'
    | 'isNewArrival'
    | 'isTrending'
  >
>;

const mutationFields: (keyof ProductMutationBody)[] = [
  'title',
  'slug',
  'brand',
  'category',
  'description',
  'ingredients',
  'howToUse',
  'keyIngredients',
  'skinType',
  'skinConcern',
  'price',
  'salePrice',
  'badge',
  'images',
  'media',
  'hoverImage',
  'volume',
  'stock',
  'lowStockThreshold',
  'availabilityMode',
  'preOrder',
  'isBestSeller',
  'isNewArrival',
  'isTrending',
];

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const splitCsv = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const parseBoolean = (value?: string): boolean =>
  ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

const parseNullableNumber = (value?: string): number | undefined => {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeKeyIngredients = (
  value: unknown
): Array<{
  name: string;
  benefit?: string;
}> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('Key ingredients must be an array.');
  }

  const normalized: Array<{
    name: string;
    benefit?: string;
  }> = [];

  for (const row of value) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const candidate = row as Record<string, unknown>;
    const name = normalizeOptionalString(candidate.name);
    const benefit = normalizeOptionalString(candidate.benefit);

    if (!name && !benefit) {
      continue;
    }

    if (!name) {
      throw new Error('Each key ingredient row requires a non-empty name.');
    }

    normalized.push(
      benefit ? { name, benefit } : { name }
    );
  }

  return normalized;
};

const isValidObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

const sanitizeMutationBody = (body: Record<string, unknown>): ProductMutationBody => {
  const sanitized: ProductMutationBody = {};

  for (const key of mutationFields) {
    const value = body[key];
    if (value !== undefined) {
      sanitized[key] = value as never;
    }
  }

  return sanitized;
};

const normalizeProductMedia = (body: ProductMutationBody): void => {
  const media = normalizeMediaAssets((body as Record<string, unknown>).media);
  if (media.length > 0) {
    body.media = media as MediaAsset[];
    body.images = extractMediaUrls(media);
  }
};

const normalizeInventoryFields = (body: ProductMutationBody): void => {
  const normalizedThreshold = normalizeOptionalLowStockThreshold(
    (body as Record<string, unknown>).lowStockThreshold
  );

  if (normalizedThreshold !== undefined) {
    body.lowStockThreshold = normalizedThreshold;
  }
};

const normalizePreOrderFields = (body: ProductMutationBody): void => {
  const rawBody = body as Record<string, unknown>;
  const availabilityMode = rawBody.availabilityMode;

  if (availabilityMode !== undefined && availabilityMode !== 'in_stock' && availabilityMode !== 'pre_order') {
    throw Object.assign(new Error('availabilityMode must be in_stock or pre_order'), {
      statusCode: 400,
      code: 'invalid_availability_mode',
    });
  }

  if (availabilityMode === 'in_stock') {
    body.availabilityMode = 'in_stock';
    body.preOrder = undefined;
    return;
  }

  if (availabilityMode !== 'pre_order' && rawBody.preOrder === undefined) {
    return;
  }

  const preOrder = (rawBody.preOrder ?? {}) as Record<string, unknown>;
  const expectedArrivalDate =
    typeof preOrder.expectedArrivalDate === 'string' || preOrder.expectedArrivalDate instanceof Date
      ? new Date(preOrder.expectedArrivalDate)
      : null;
  const quantityLimit = Number(preOrder.quantityLimit);
  const status = preOrder.status ?? 'accepting';
  const customerMessage = normalizeOptionalString(preOrder.customerMessage);

  if (!expectedArrivalDate || Number.isNaN(expectedArrivalDate.getTime())) {
    throw Object.assign(new Error('Expected arrival date is required for pre-order products'), {
      statusCode: 400,
      code: 'invalid_pre_order_expected_arrival',
    });
  }

  if (!Number.isInteger(quantityLimit) || quantityLimit < 0) {
    throw Object.assign(new Error('Pre-order quantity limit must be a non-negative whole number'), {
      statusCode: 400,
      code: 'invalid_pre_order_quantity_limit',
    });
  }

  if (status !== 'accepting' && status !== 'closed' && status !== 'arrived') {
    throw Object.assign(new Error('Pre-order status must be accepting, closed, or arrived'), {
      statusCode: 400,
      code: 'invalid_pre_order_status',
    });
  }

  body.availabilityMode = 'pre_order';
  body.preOrder = {
    expectedArrivalDate,
    quantityLimit,
    customerMessage,
    status,
    reservedQuantity: typeof preOrder.reservedQuantity === 'number' ? preOrder.reservedQuantity : undefined,
  };
};

const normalizeSkincareFields = (body: ProductMutationBody): void => {
  body.ingredients = normalizeOptionalString(body.ingredients);
  body.howToUse = normalizeOptionalString(body.howToUse);

  const keyIngredients = normalizeKeyIngredients(body.keyIngredients);
  if (keyIngredients !== undefined) {
    body.keyIngredients = keyIngredients;
  }
};

const resolveSlug = (body: ProductMutationBody, fallbackTitle?: string): string => {
  const source =
    typeof body.slug === 'string' && body.slug.trim()
      ? body.slug
      : typeof body.title === 'string' && body.title.trim()
        ? body.title
        : fallbackTitle ?? '';

  return slugify(source);
};

const findDuplicateSlug = async (slug: string, excludeId?: string): Promise<boolean> => {
  const query: Record<string, unknown> = { slug };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const duplicate = await Product.findOne(query).select('_id').lean();
  return Boolean(duplicate);
};

const buildExactMatchCondition = (
  field: string,
  values: string[]
): Record<string, unknown> | null => {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

  if (uniqueValues.length === 0) {
    return null;
  }

  return {
    [field]: {
      $in: uniqueValues.map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i')),
    },
  };
};

const buildSearchCondition = (search?: string): Record<string, unknown> | null => {
  const query = search?.trim();
  if (!query) return null;

  const regex = new RegExp(escapeRegex(query), 'i');

  return {
    $or: [
      { title: regex },
      { brand: regex },
      { category: regex },
      { description: regex },
      { skinConcern: regex },
    ],
  };
};

const formatProduct = (product: ProductAggregateRow): ProductAggregateRow => {
  const formatted = { ...product };

  formatted.id = formatted._id?.toString?.() ?? formatted.id;
  delete formatted._id;
  delete formatted.__v;
  delete formatted.currentPrice;

  formatted.name = formatted.title;
  formatted.concerns = formatted.skinConcern;
  formatted.reviewCount = formatted.numReviews;
  formatted.description = formatted.description || '';

  if (formatted.isBestSeller || formatted.badge === 'Best') {
    formatted.tag = 'best';
  } else if (formatted.isNewArrival || formatted.badge === 'New') {
    formatted.tag = 'new';
  } else {
    formatted.tag = null;
  }

  if (formatted.salePrice != null) {
    formatted.compareAtPrice = formatted.price;
    formatted.price = formatted.salePrice;
  }

  delete formatted.salePrice;

  formatted.availabilityMode = formatted.availabilityMode ?? 'in_stock';
  if (formatted.preOrder && (formatted.availabilityMode === 'pre_order' || formatted.preOrder.status === 'arrived')) {
    const quantityLimit = Number(formatted.preOrder.quantityLimit ?? 0);
    const reservedQuantity = Number(formatted.preOrder.reservedQuantity ?? 0);
    formatted.preOrder = {
      expectedArrivalDate: formatted.preOrder.expectedArrivalDate,
      quantityLimit,
      customerMessage: formatted.preOrder.customerMessage,
      status: formatted.preOrder.status ?? 'accepting',
      reservedQuantity,
      remainingQuantity: Math.max(quantityLimit - reservedQuantity, 0),
    };
  } else {
    formatted.preOrder = undefined;
  }

  return formatted;
};

/**
 * @swagger
 * /api/products:
 *   post:
 *     tags: [Products]
 *     summary: Create a new product (admin only)
 *     description: Creates a new product. Slug is auto-generated from title.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, brand, category, price, images]
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Advanced Snail 96 Mucin Power Essence"
 *               brand:
 *                 type: string
 *                 example: "COSRX"
 *               category:
 *                 type: string
 *                 example: "Serum"
 *               skinType:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Combination", "Oily"]
 *               skinConcern:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Acne", "Glass Skin"]
 *               price:
 *                 type: number
 *                 example: 2250
 *               salePrice:
 *                 type: number
 *                 example: 1999
 *               badge:
 *                 type: string
 *                 enum: [Sale, Best, New]
 *                 example: "Best"
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["https://example.com/image.jpg"]
 *               hoverImage:
 *                 type: string
 *                 example: "https://example.com/hover.jpg"
 *                 description: Secondary image shown on hover
 *               volume:
 *                 type: string
 *                 example: "100ml"
 *                 description: Product volume (e.g. "50ml", "100ml")
 *               stock:
 *                 type: number
 *                 default: 0
 *                 example: 50
 *               isBestSeller:
 *                 type: boolean
 *                 default: false
 *               isNewArrival:
 *                 type: boolean
 *                 default: false
 *               isTrending:
 *                 type: boolean
 *                 default: false
 *               rating:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 5
 *                 default: 0
 *               numReviews:
 *                 type: number
 *                 default: 0
 *     responses:
 *       201:
 *         description: Product created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 product:
 *                   $ref: '#/components/schemas/Product'
 *       400:
 *         description: Validation error — missing required fields
 *       401:
 *         description: Not authorized
 *       403:
 *         description: Admin access required
 *       409:
 *         description: Product with similar title already exists
 */
export const createProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = sanitizeMutationBody((req.body ?? {}) as Record<string, unknown>);
    normalizeProductMedia(body);
    normalizeSkincareFields(body);
    normalizeInventoryFields(body);
    normalizePreOrderFields(body);

    // Validate required fields
  if (!body.title || !body.brand || !body.category || body.price === undefined || body.price === null) {
      res.status(400).json({
        success: false,
        message: 'Missing required fields: title, brand, category, price',
      });
      return;
    }

    if (!body.images || body.images.length === 0) {
      res.status(400).json({
        success: false,
        message: 'At least one image URL or media asset is required',
      });
      return;
    }

    const slug = resolveSlug(body);

    if (await findDuplicateSlug(slug)) {
      res.status(409).json({
        success: false,
        message: 'A product with a similar title already exists',
      });
      return;
    }

    const product = await Product.create({
      ...body,
      slug,
    });

    res.status(201).json({
      success: true,
      product,
    });
  } catch (error: any) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }

    if (error instanceof Error && error.message === 'Key ingredients must be an array.') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.message],
      });
      return;
    }

    if (error instanceof Error && error.message === 'Each key ingredient row requires a non-empty name.') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.message],
      });
      return;
    }

    // Duplicate key (slug collision)
    if (error.code === 11000) {
      res.status(409).json({
        success: false,
        message: 'A product with a similar title already exists',
      });
      return;
    }

    if (error instanceof mongoose.Error.CastError || error?.name === 'CastError') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.path === 'stock' ? 'Stock must be a non-negative integer' : error.message],
      });
      return;
    }

    // Mongoose validation error
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e: any) => e.message);
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: messages,
      });
      return;
    }

    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const updateProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as { id: string };

    if (!isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: 'Invalid product ID',
      });
      return;
    }

    const product = await Product.findById(id);

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found',
      });
      return;
    }

    const body = sanitizeMutationBody((req.body ?? {}) as Record<string, unknown>);
    normalizeProductMedia(body);
    normalizeSkincareFields(body);
    normalizeInventoryFields(body);
    normalizePreOrderFields(body);

    if (
      (body.title !== undefined && body.title.trim() === '') ||
      (body.brand !== undefined && body.brand.trim() === '') ||
      (body.category !== undefined && body.category.trim() === '')
    ) {
      res.status(400).json({
        success: false,
        message: 'Title, brand, and category cannot be empty',
      });
      return;
    }

    const nextSlug = resolveSlug(body, product.title);

    if (await findDuplicateSlug(nextSlug, id)) {
      res.status(409).json({
        success: false,
        message: 'A product with a similar title already exists',
      });
      return;
    }

    if (body.availabilityMode === 'pre_order' && body.preOrder) {
      body.preOrder.reservedQuantity = product.preOrder?.reservedQuantity ?? 0;
    }

    product.set({
      ...body,
      slug: nextSlug,
    });

    await product.save();

    res.status(200).json({
      success: true,
      product,
    });
  } catch (error: any) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }

    if (error instanceof Error && error.message === 'Key ingredients must be an array.') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.message],
      });
      return;
    }

    if (error instanceof Error && error.message === 'Each key ingredient row requires a non-empty name.') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.message],
      });
      return;
    }

    if (error.code === 11000) {
      res.status(409).json({
        success: false,
        message: 'A product with a similar title already exists',
      });
      return;
    }

    if (error instanceof mongoose.Error.CastError || error?.name === 'CastError') {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [error.path === 'stock' ? 'Stock must be a non-negative integer' : error.message],
      });
      return;
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e: any) => e.message);
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: messages,
      });
      return;
    }

    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const deleteProduct = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as { id: string };

    if (!isValidObjectId(id)) {
      res.status(400).json({
        success: false,
        message: 'Invalid product ID',
      });
      return;
    }

    const product = await Product.findByIdAndDelete(id);

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

export const markPreOrderArrived = async (req: Request, res: Response): Promise<void> => {
  const session = await mongoose.startSession();

  try {
    const { id } = req.params as { id: string };
    const actualReceivedQuantity = Number(req.body?.actualReceivedQuantity);

    if (!isValidObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid product ID' });
      return;
    }

    if (!Number.isInteger(actualReceivedQuantity) || actualReceivedQuantity < 0) {
      res.status(400).json({
        success: false,
        message: 'Actual quantity received must be a non-negative whole number',
        code: 'invalid_received_quantity',
      });
      return;
    }

    const product = await session.withTransaction(async () => {
      const current = await Product.findById(id).session(session).exec();

      if (!current) {
        throw Object.assign(new Error('Product not found'), { statusCode: 404 });
      }

      if ((current.availabilityMode ?? 'in_stock') !== 'pre_order') {
        throw Object.assign(new Error('Product is not configured for pre-order'), {
          statusCode: 400,
          code: 'not_pre_order',
        });
      }

      const reservedQuantity = current.preOrder?.reservedQuantity ?? 0;
      if (actualReceivedQuantity < reservedQuantity) {
        throw Object.assign(
          new Error('Received quantity is lower than the quantity reserved by active pre-orders.'),
          { statusCode: 409, code: 'pre_order_arrival_shortage' }
        );
      }

      current.stock = actualReceivedQuantity - reservedQuantity;
      current.availabilityMode = 'in_stock';
      current.preOrder = {
        ...(current.preOrder ?? {}),
        status: 'arrived',
        reservedQuantity,
      };

      await current.save({ session });
      return current;
    });

    res.status(200).json({
      success: true,
      product,
    });
  } catch (error: any) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }

    console.error('[markPreOrderArrived]', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    await session.endSession();
  }
};

/**
 * @swagger
 * /api/products:
 *   get:
 *     tags: [Products]
 *     summary: Get paginated list of products
 *     description: Query products with optional filters — tab, brand, category, skinType, skinConcern, search.
 *     parameters:
 *       - in: query
 *         name: tab
 *         schema:
 *           type: string
 *           enum: [bestseller, new, trending]
 *         description: Filter by product tab
 *       - in: query
 *         name: brand
 *         schema:
 *           type: string
 *         description: Case-insensitive brand filter (e.g. COSRX)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Case-insensitive category filter (e.g. Serum)
 *       - in: query
 *         name: skinType
 *         schema:
 *           type: string
 *         description: Filter by skin type (e.g. Oily)
 *       - in: query
 *         name: skinConcern
 *         schema:
 *           type: string
 *         description: Filter by skin concern (e.g. Acne)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Full-text search across title, brand, category, concerns
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 8
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Paginated product list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 count:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 products:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Product'
 */
export const getProducts = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      tab,
      brand,
      category,
      skinType,
      skinConcern,
      concern,
      search,
      sort,
      featured,
      bestSeller,
      inStock,
      minPrice,
      maxPrice,
      page: pageStr,
      limit: limitStr,
    } = req.query as ProductQueryParams;

    const { page, limit } = getPaginationParams(
      pageStr ? parseInt(pageStr) : 1,
      limitStr ? parseInt(limitStr) : 8
    );

    const andConditions: Record<string, unknown>[] = [];

    const normalizedTab = tab?.trim().toLowerCase();
    if (normalizedTab === 'bestseller' || normalizedTab === 'best' || normalizedTab === 'best-seller') {
      andConditions.push({ isBestSeller: true });
    } else if (normalizedTab === 'new') {
      andConditions.push({ isNewArrival: true });
    } else if (normalizedTab === 'trending') {
      andConditions.push({ isTrending: true });
    }

    if (parseBoolean(featured) || parseBoolean(bestSeller)) {
      andConditions.push({ isBestSeller: true });
    }

    if (parseBoolean(inStock)) {
      andConditions.push({ stock: { $gt: 0 } });
    }

    const brandCondition = buildExactMatchCondition('brand', splitCsv(brand));
    if (brandCondition) andConditions.push(brandCondition);

    const categoryCondition = buildExactMatchCondition('category', splitCsv(category));
    if (categoryCondition) andConditions.push(categoryCondition);

    const skinTypeCondition = buildExactMatchCondition('skinType', splitCsv(skinType));
    if (skinTypeCondition) andConditions.push(skinTypeCondition);

    const concernValues = [...splitCsv(skinConcern), ...splitCsv(concern)];
    const concernCondition = buildExactMatchCondition('skinConcern', concernValues);
    if (concernCondition) andConditions.push(concernCondition);

    const searchCondition = buildSearchCondition(search);
    if (searchCondition) andConditions.push(searchCondition);

    const min = parseNullableNumber(minPrice);
    const max = parseNullableNumber(maxPrice);

    if (min !== undefined || max !== undefined) {
      const priceBounds: Record<string, number> = {};
      const lower = min !== undefined ? min : undefined;
      const upper = max !== undefined ? max : undefined;
      const minBound = lower !== undefined && upper !== undefined && lower > upper ? upper : lower;
      const maxBound = lower !== undefined && upper !== undefined && lower > upper ? lower : upper;

      if (minBound !== undefined) priceBounds.$gte = minBound;
      if (maxBound !== undefined) priceBounds.$lte = maxBound;

      andConditions.push({ currentPrice: priceBounds });
    }

    const normalizedSort = sort?.trim().toLowerCase();
    let sortObj: Record<string, 1 | -1> = { createdAt: -1 };
    switch (normalizedSort) {
      case 'price-asc':
        sortObj = { currentPrice: 1, createdAt: -1 };
        break;
      case 'price-desc':
        sortObj = { currentPrice: -1, createdAt: -1 };
        break;
      case 'rating':
        sortObj = { rating: -1, numReviews: -1, createdAt: -1 };
        break;
      case 'popular':
      case 'popularity':
        sortObj = { rating: -1, numReviews: -1, createdAt: -1 };
        break;
      case 'newest':
      default:
        sortObj = { createdAt: -1 };
        break;
    }

    const pipeline: any[] = [
      {
        $addFields: {
          currentPrice: { $ifNull: ['$salePrice', '$price'] },
        },
      },
    ];

    if (andConditions.length > 0) {
      pipeline.push({ $match: { $and: andConditions } });
    }

    pipeline.push(
      { $sort: sortObj },
      {
        $facet: {
          products: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
          meta: [{ $count: 'totalProducts' }],
        },
      }
    );

    const [result] = await Product.aggregate(pipeline);
    const products = (result?.products ?? []).map(formatProduct);
    const totalProducts = result?.meta?.[0]?.totalProducts ?? 0;

    res.status(200).json({
      success: true,
      count: totalProducts,
      totalProducts,
      page,
      limit,
      totalPages: Math.ceil(totalProducts / limit),
      products,
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

/**
 * @swagger
 * /api/products/{idOrSlug}:
 *   get:
 *     tags: [Products]
 *     summary: Get a single product by ID or slug
 *     parameters:
 *       - in: path
 *         name: idOrSlug
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId or URL slug (e.g. "advanced-snail-96-mucin-power-essence")
 *     responses:
 *       200:
 *         description: Product details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 product:
 *                   $ref: '#/components/schemas/Product'
 *       404:
 *         description: Product not found
 */
export const getProductByIdOrSlug = async (req: Request, res: Response): Promise<void> => {
  try {
    const idOrSlug = req.params.idOrSlug as string;

    // Determine if param is a MongoDB ObjectId or a slug
    const isObjectId = mongoose.Types.ObjectId.isValid(idOrSlug);

    const query = isObjectId
      ? { _id: idOrSlug }
      : { slug: idOrSlug.toLowerCase() };

    const product = await Product.findOne(query);

    if (!product) {
      res.status(404).json({
        success: false,
        message: 'Product not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};
