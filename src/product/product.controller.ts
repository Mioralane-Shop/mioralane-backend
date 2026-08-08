import { Request, Response } from 'express';
import { Product, IProduct, IProductDocument } from './product.model';
import { getPaginationParams } from '../utils/pagination';
import { slugify } from '../utils/slugify';
import mongoose from 'mongoose';

// ─── Types ────────────────────────────────────────────────────────────────

interface ProductQueryParams {
  tab?: 'bestseller' | 'new' | 'trending';
  brand?: string;
  category?: string;
  skinType?: string;
  skinConcern?: string;
  search?: string;
  page?: string;
  limit?: string;
}

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
      search,
      page: pageStr,
      limit: limitStr,
    } = req.query as ProductQueryParams;

    const { page, limit } = getPaginationParams(
      pageStr ? parseInt(pageStr) : 1,
      limitStr ? parseInt(limitStr) : 8
    );

    // Build filter
    const filter: Record<string, any> = {};

    // Tab-based filtering
    if (tab === 'bestseller') {
      filter.isBestSeller = true;
    } else if (tab === 'new') {
      filter.isNewArrival = true;
    } else if (tab === 'trending') {
      filter.isTrending = true;
    }

    if (brand) {
      // Case-insensitive brand match
      filter.brand = { $regex: new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    }

    if (category) {
      filter.category = { $regex: new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    }

    if (skinType) {
      filter.skinType = { $in: [skinType] };
    }

    if (skinConcern) {
      filter.skinConcern = { $in: [skinConcern] };
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { skinConcern: { $regex: search, $options: 'i' } },
      ];
    }

    const [products, count] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
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

    const product = await Product.findOne(query).lean();

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
