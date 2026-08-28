import { Request, Response } from 'express';
import { Combo, ICombo } from './combo.model';
import { getPaginationParams } from '../utils/pagination';
import { slugify } from '../utils/slugify';
import mongoose from 'mongoose';

// ─── Types ────────────────────────────────────────────────────────────────

interface ComboQueryParams {
    search?: string;
    sort?: 'newest' | 'price-asc' | 'price-desc' | 'popularity';
    page?: string;
    limit?: string;
}

const isValidObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);
const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @swagger
 * /api/combos:
 *   post:
 *     tags: [Combos]
 *     summary: Create a new combo / bundle (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, price, images]
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Glass Skin 4-Step Routine"
 *               badge:
 *                 type: string
 *                 example: "MORNING PACK"
 *                 description: Label on the card image badge
 *               description:
 *                 type: string
 *                 example: "The complete Korean glass skin routine in one bundle."
 *               price:
 *                 type: number
 *                 example: 4250
 *                 description: Bundle selling price
 *               compareAtPrice:
 *                 type: number
 *                 example: 5100
 *                 description: Original total if bought separately
 *               savings:
 *                 type: number
 *                 example: 850
 *                 description: Amount saved (auto-computed if not provided)
 *               includedItems:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Cleanser", "Toner", "Serum", "Moisturizer", "Sunscreen"]
 *               routineTag:
 *                 type: string
 *                 example: "For Glass Skin"
 *               brand:
 *                 type: string
 *                 default: "Mioralane Bundle"
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["https://example.com/routine.jpg"]
 *               hoverImage:
 *                 type: string
 *                 example: "https://example.com/routine-alt.jpg"
 *                 description: Alternate image shown on card hover
 *               size:
 *                 type: string
 *                 example: "5-piece set"
 *                 description: Bundle size descriptor
 *               stock:
 *                 type: number
 *                 default: 0
 *               rating:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 5
 *                 default: 0
 *               numReviews:
 *                 type: number
 *                 default: 0
 *               concerns:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Complete Routine", "Best Value"]
 *               skinType:
 *                 type: string
 *                 default: "All skin types"
 *               isBestSeller:
 *                 type: boolean
 *                 default: false
 *               isNewArrival:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Combo created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Not authorized
 *       403:
 *         description: Admin access required
 */
export const createCombo = async (req: Request, res: Response): Promise<void> => {
    try {
        const body = req.body as Omit<ICombo, "rating" | "numReviews">;

        if (!body.title || body.price === undefined || body.price === null) {
            res.status(400).json({
                success: false,
                message: 'Missing required fields: title, price',
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

        // Default category to "combo" if not provided
        const data: ICombo = {
            ...body,
            category: body.category || 'combo',
            brand: body.brand || 'Mioralane Bundle',
            slug: slugify(body.title),
            rating: 0,
            numReviews: 0,
        };

        // Keep savings derived from the actual bundle prices
        data.savings = data.compareAtPrice && data.compareAtPrice > data.price
            ? data.compareAtPrice - data.price
            : 0;

        const combo = await Combo.create(data);

        res.status(201).json({
            success: true,
            combo,
        });
    } catch (error: any) {
        if (error.code === 11000) {
            res.status(409).json({
                success: false,
                message: 'A combo with a similar title already exists',
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

        console.error('Error creating combo:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

/**
 * @swagger
 * /api/combos:
 *   get:
 *     tags: [Combos]
 *     summary: Get paginated list of combos / bundles
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Full-text search across title and description
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 8
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [newest, price-asc, price-desc, popularity]
 *     responses:
 *       200:
 *         description: Paginated combo list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 combos:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Combo'
 */
export const getCombos = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            search,
            sort,
            page: pageStr,
            limit: limitStr,
        } = req.query as ComboQueryParams;

        const { page, limit } = getPaginationParams(
            pageStr ? parseInt(pageStr) : 1,
            limitStr ? parseInt(limitStr) : 8
        );

        // Build filter — only return documents with category "combo"
        const filter: Record<string, any> = {};

        if (search) {
            const regex = new RegExp(escapeRegex(search.trim()), 'i');
            filter.$or = [
                { title: regex },
                { brand: regex },
                { description: regex },
                { badge: regex },
            ];
        }

        // Sorting
        let sortObj: Record<string, 1 | -1> = { createdAt: -1 };
        switch (sort) {
            case 'price-asc':
                sortObj = { price: 1 };
                break;
            case 'price-desc':
                sortObj = { price: -1 };
                break;
            case 'newest':
                sortObj = { createdAt: -1 };
                break;
            case 'popularity':
                sortObj = { rating: -1, numReviews: -1 };
                break;
        }

        const [combos, count] = await Promise.all([
            Combo.find(filter)
                .sort(sortObj)
                .skip((page - 1) * limit)
                .limit(limit),
            Combo.countDocuments(filter),
        ]);

        res.status(200).json({
            success: true,
            count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
            combos,
        });
    } catch (error) {
        console.error('Error fetching combos:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

/**
 * @swagger
 * /api/combos/{idOrSlug}:
 *   get:
 *     tags: [Combos]
 *     summary: Get a single combo by ID or slug
 *     parameters:
 *       - in: path
 *         name: idOrSlug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Combo found
 *       404:
 *         description: Combo not found
 */
export const getComboByIdOrSlug = async (req: Request, res: Response): Promise<void> => {
    try {
        const { idOrSlug } = req.params as { idOrSlug: string };

        if (!idOrSlug) {
            res.status(400).json({ success: false, message: 'Missing combo ID or slug' });
            return;
        }

        // Check if the parameter is a valid MongoDB ObjectId
        const isObjectId = /^[0-9a-fA-F]{24}$/.test(idOrSlug);

        const combo = isObjectId
            ? await Combo.findById(idOrSlug)
            : await Combo.findOne({ slug: idOrSlug.toLowerCase().trim() });

        if (!combo) {
            res.status(404).json({
                success: false,
                message: 'Combo not found',
            });
            return;
        }

        res.status(200).json({
            success: true,
            combo,
        });
    } catch (error) {
        console.error('Error fetching combo:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};

/**
 * @swagger
 * /api/combos/{id}:
 *   put:
 *     tags: [Combos]
 *     summary: Update a combo / bundle (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               badge:
 *                 type: string
 *                 example: "MORNING ROUTINE"
 *               price:
 *                 type: number
 *               compareAtPrice:
 *                 type: number
 *               savings:
 *                 type: number
 *               includedItems:
 *                 type: array
 *                 items:
 *                   type: string
 *               routineTag:
 *                 type: string
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               stock:
 *                 type: number
 *     responses:
 *       200:
 *         description: Combo updated
 *       404:
 *         description: Combo not found
 */
export const updateCombo = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params as { id: string };
        const updates = req.body;

        if (!isValidObjectId(id)) {
            res.status(400).json({
                success: false,
                message: 'Invalid combo ID',
            });
            return;
        }

        // Only allow specific fields to be updated
        const allowed = [
            'badge', 'title', 'description', 'price', 'compareAtPrice', 'savings',
            'includedItems', 'routineTag', 'images', 'hoverImage', 'size', 'volume', 'stock',
            'concerns', 'skinType', 'isBestSeller', 'isNewArrival',
        ];
        const sanitized: Record<string, any> = {};
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                sanitized[key] = updates[key];
            }
        }

        const combo = await Combo.findById(id);

        if (!combo) {
            res.status(404).json({ success: false, message: 'Combo not found' });
            return;
        }

        combo.set(sanitized);

        const compareAtPrice = typeof combo.compareAtPrice === 'number' ? combo.compareAtPrice : 0;
        const price = typeof combo.price === 'number' ? combo.price : 0;
        combo.savings = compareAtPrice > price ? compareAtPrice - price : 0;

        await combo.save();

        res.status(200).json({ success: true, combo });
    } catch (error: any) {
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
            res.status(400).json({ success: false, message: 'Validation failed', errors: messages });
            return;
        }
        console.error('Error updating combo:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * @swagger
 * /api/combos/{id}:
 *   delete:
 *     tags: [Combos]
 *     summary: Delete a combo / bundle (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Combo deleted
 *       400:
 *         description: Invalid combo ID
 *       404:
 *         description: Combo not found
 */
export const deleteCombo = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params as { id: string };

        if (!isValidObjectId(id)) {
            res.status(400).json({
                success: false,
                message: 'Invalid combo ID',
            });
            return;
        }

        const combo = await Combo.findByIdAndDelete(id);

        if (!combo) {
            res.status(404).json({
                success: false,
                message: 'Combo not found',
            });
            return;
        }

        res.status(200).json({
            success: true,
            message: 'Combo deleted successfully',
        });
    } catch (error) {
        console.error('Error deleting combo:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
};
