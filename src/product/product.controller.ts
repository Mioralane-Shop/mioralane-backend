import { Request, Response } from 'express';
import { Product, IProduct, IProductDocument } from './product.model';
import { getPaginationParams } from '../utils/pagination';
import { slugify } from '../utils/slugify';
import mongoose from 'mongoose';

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
  } else {
    formatted.compareAtPrice = Math.round(Number(formatted.price || 0) * 1.25);
  }

  delete formatted.salePrice;

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
 *                 default: 5.0
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
    const body = req.body as IProduct;

    // Validate required fields
    if (!body.title || !body.brand || !body.category || !body.price) {
      res.status(400).json({
        success: false,
        message: 'Missing required fields: title, brand, category, price',
      });
      return;
    }

    if (!body.images || body.images.length === 0) {
      res.status(400).json({
        success: false,
        message: 'At least one image URL is required',
      });
      return;
    }

    const product = await Product.create({
      ...body,
      slug: slugify(body.title), // pre-save hook will ensure uniqueness
    });

    res.status(201).json({
      success: true,
      product,
    });
  } catch (error: any) {
    // Duplicate key (slug collision)
    if (error.code === 11000) {
      res.status(409).json({
        success: false,
        message: 'A product with a similar title already exists',
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
