import mongoose from 'mongoose';
import Product from '../product/product.model';
import Combo from '../combo/combo.model';
import { WishlistItem, WishlistItemType } from './wishlist-item.model';
import {
    StockStatus,
    getEffectiveLowStockThreshold,
    getInventorySettings,
    getStockStatus,
} from '../inventory/inventory.service';

type HttpError = Error & { statusCode?: number; code?: string };

export const createWishlistError = (
    statusCode: number,
    message: string,
    code?: string
): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

// Same projections as the original wishlist endpoint.
const wishlistProductSelect =
    'title slug brand category description skinType skinConcern price salePrice badge images hoverImage volume stock lowStockThreshold availabilityMode preOrder isBestSeller isNewArrival isTrending rating numReviews createdAt updatedAt';

const wishlistComboSelect =
    'title slug badge description price compareAtPrice savings includedItems routineTag category brand images hoverImage size volume stock rating numReviews concerns skinType isBestSeller isNewArrival createdAt updatedAt';

export const WISHLIST_SORTS = ['newest', 'price-asc', 'price-desc', 'availability'] as const;
export type WishlistSort = (typeof WISHLIST_SORTS)[number];
export const DEFAULT_WISHLIST_SORT: WishlistSort = 'newest';

export const normalizeWishlistSort = (value: unknown): WishlistSort => {
    if (typeof value === 'string' && (WISHLIST_SORTS as readonly string[]).includes(value)) {
        return value as WishlistSort;
    }

    return DEFAULT_WISHLIST_SORT;
};

export const normalizeWishlistItemType = (value: unknown): WishlistItemType => {
    if (value === 'combo') {
        return 'combo';
    }

    if (value === 'product' || value === undefined || value === null || value === '') {
        return 'product';
    }

    throw createWishlistError(400, 'itemType must be product or combo', 'invalid_item_type');
};

export const toWishlistObjectId = (itemId: string): mongoose.Types.ObjectId =>
    new mongoose.Types.ObjectId(itemId);

/** One resolved catalog item (product or combo) for a wishlist entry. */
type WishlistTarget = {
    itemId: string;
    itemType: WishlistItemType;
    /** Current selling price (sale price already applied for products). */
    currentPrice: number;
    stock: number;
    stockStatus: StockStatus;
    isPreOrder: boolean;
    /** Whether the cart would currently accept this item. */
    isAvailable: boolean;
    product: Record<string, unknown>;
};

export type WishlistEntry = WishlistTarget & {
    id: string;
    addedAt: string;
    /** Price when the customer saved the item. */
    priceAtAdd: number;
    compareAtPrice: number | null;
    /** wishlistPrice - currentPrice when positive, otherwise 0. */
    priceDrop: number;
    hasPriceDrop: boolean;
};

export type WishlistSnapshot = {
    itemIds: string[];
    items: WishlistEntry[];
    products: Array<Record<string, unknown>>;
    sort: WishlistSort;
};

const readNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Products are pre-order aware (see `lib/pre-order.ts` on the frontend): an
 * accepting pre-order with capacity left is purchasable even at stock 0.
 */
const buildTarget = (
    itemType: WishlistItemType,
    document: { id: string; toJSON: () => Record<string, unknown> },
    defaultLowStockThreshold: number
): WishlistTarget => {
    const product = document.toJSON();
    const stock = readNumber(product.stock);
    const isPreOrder = itemType === 'product' && product.availabilityMode === 'pre_order';
    const preOrder = (product.preOrder ?? {}) as { status?: string; remainingQuantity?: number };
    const preOrderRemaining = Math.max(readNumber(preOrder.remainingQuantity), 0);
    const isAvailable = isPreOrder
        ? preOrder.status === 'accepting' && preOrderRemaining > 0
        : stock > 0;

    const availableStock = isPreOrder ? preOrderRemaining : stock;
    const stockStatus: StockStatus = isPreOrder
        ? isAvailable
            ? 'in_stock'
            : 'out_of_stock'
        : getStockStatus(stock, getEffectiveLowStockThreshold(product, defaultLowStockThreshold));

    return {
        itemId: document.id,
        itemType,
        // The API already flattens salePrice into `price`, so this is the
        // authoritative current price for both products and combos.
        currentPrice: readNumber(product.price),
        stock: availableStock,
        stockStatus,
        isPreOrder,
        isAvailable,
        product,
    };
};

const buildEntry = (
    record: { _id: mongoose.Types.ObjectId; createdAt: Date; priceAtAdd: number },
    target: WishlistTarget
): WishlistEntry => {
    const priceAtAdd = readNumber(record.priceAtAdd, target.currentPrice);
    const priceDrop = Math.max(priceAtAdd - target.currentPrice, 0);

    return {
        ...target,
        id: record._id.toString(),
        addedAt: new Date(record.createdAt).toISOString(),
        priceAtAdd,
        compareAtPrice:
            target.product.compareAtPrice === undefined || target.product.compareAtPrice === null
                ? null
                : readNumber(target.product.compareAtPrice),
        priceDrop,
        hasPriceDrop: priceDrop > 0,
    };
};

const STOCK_RANK: Record<StockStatus, number> = {
    in_stock: 0,
    low_stock: 1,
    out_of_stock: 2,
};

const sortEntries = (entries: WishlistEntry[], sort: WishlistSort): WishlistEntry[] => {
    const newestFirst = (a: WishlistEntry, b: WishlistEntry) =>
        new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();

    switch (sort) {
        case 'price-asc':
            return entries.sort((a, b) => a.currentPrice - b.currentPrice || newestFirst(a, b));
        case 'price-desc':
            return entries.sort((a, b) => b.currentPrice - a.currentPrice || newestFirst(a, b));
        case 'availability':
            return entries.sort(
                (a, b) => STOCK_RANK[a.stockStatus] - STOCK_RANK[b.stockStatus] || newestFirst(a, b)
            );
        case 'newest':
        default:
            return entries.sort(newestFirst);
    }
};

const resolveTargets = async (
    records: Array<{ itemId: mongoose.Types.ObjectId; itemType: WishlistItemType }>
): Promise<{ targets: Map<string, WishlistTarget>; defaultLowStockThreshold: number }> => {
    const productIds = records.filter((r) => r.itemType === 'product').map((r) => r.itemId);
    const comboIds = records.filter((r) => r.itemType === 'combo').map((r) => r.itemId);

    const [productDocs, comboDocs, settings] = await Promise.all([
        productIds.length
            ? Product.find({ _id: { $in: productIds } })
                .select(wishlistProductSelect)
                .exec()
            : Promise.resolve([]),
        comboIds.length
            ? Combo.find({ _id: { $in: comboIds } })
                .select(wishlistComboSelect)
                .exec()
            : Promise.resolve([]),
        getInventorySettings(),
    ]);

    const targets = new Map<string, WishlistTarget>();

    for (const doc of productDocs) {
        targets.set(
            `product:${doc._id.toString()}`,
            buildTarget('product', doc as never, settings.defaultLowStockThreshold)
        );
    }

    for (const doc of comboDocs) {
        targets.set(
            `combo:${doc._id.toString()}`,
            buildTarget('combo', doc as never, settings.defaultLowStockThreshold)
        );
    }

    return { targets, defaultLowStockThreshold: settings.defaultLowStockThreshold };
};

/**
 * Current wishlist for a customer, enriched with live price/stock and sorted.
 *
 * Entries whose product/combo no longer exists are dropped from the response and
 * cleaned up, so a deleted catalog item can never break the whole list.
 */
export const getWishlistSnapshot = async (
    userId: string,
    sort: WishlistSort = DEFAULT_WISHLIST_SORT
): Promise<WishlistSnapshot> => {
    const records = await WishlistItem.find({ user: userId }).sort({ createdAt: -1 });

    if (records.length === 0) {
        return { itemIds: [], items: [], products: [], sort };
    }

    const { targets } = await resolveTargets(records);

    const orphanIds: mongoose.Types.ObjectId[] = [];
    const entries: WishlistEntry[] = [];

    for (const record of records) {
        const target = targets.get(`${record.itemType}:${record.itemId.toString()}`);

        if (!target) {
            orphanIds.push(record._id);
            continue;
        }

        entries.push(
            buildEntry(
                { _id: record._id, createdAt: record.createdAt, priceAtAdd: record.priceAtAdd },
                target
            )
        );
    }

    if (orphanIds.length > 0) {
        await WishlistItem.deleteMany({ _id: { $in: orphanIds } });
        console.warn(`[wishlist] removed ${orphanIds.length} entr(ies) pointing at deleted catalog items`);
    }

    sortEntries(entries, sort);

    return {
        itemIds: entries.map((entry) => entry.itemId),
        items: entries,
        products: entries.map((entry) => entry.product),
        sort,
    };
};

/** Loads a single catalog item, validating that it exists. */
const loadWishlistTarget = async (
    itemId: mongoose.Types.ObjectId,
    itemType: WishlistItemType
): Promise<WishlistTarget> => {
    const document =
        itemType === 'combo'
            ? await Combo.findById(itemId).select(wishlistComboSelect).exec()
            : await Product.findById(itemId).select(wishlistProductSelect).exec();

    if (!document) {
        throw createWishlistError(
            404,
            `${itemType === 'combo' ? 'Combo' : 'Product'} not found`,
            'wishlist_item_not_found'
        );
    }

    const { defaultLowStockThreshold } = await getInventorySettings();

    return buildTarget(itemType, document as never, defaultLowStockThreshold);
};

export const addWishlistItem = async (
    userId: string,
    itemId: mongoose.Types.ObjectId,
    itemType: WishlistItemType
): Promise<{ isWishlisted: boolean; created: boolean; target: WishlistTarget }> => {
    const target = await loadWishlistTarget(itemId, itemType);
    let created = false;

    try {
        // $setOnInsert keeps the ORIGINAL saved price/date when the customer taps
        // the heart again on an item that is already saved.
        const result = await WishlistItem.updateOne(
            { user: userId, itemId, itemType },
            { $setOnInsert: { user: userId, itemId, itemType, priceAtAdd: target.currentPrice } },
            { upsert: true }
        );
        created = (result.upsertedCount ?? 0) > 0;
    } catch (error) {
        // Unique index raced with a parallel add — the item is saved either way.
        if (!(error instanceof Error) || !/E11000/.test(error.message)) {
            throw error;
        }
    }

    return { isWishlisted: true, created, target };
};

export const removeWishlistItem = async (
    userId: string,
    itemId: mongoose.Types.ObjectId,
    itemType?: WishlistItemType
): Promise<{ removed: boolean }> => {
    const query: Record<string, unknown> = { user: userId, itemId };

    if (itemType) {
        query.itemType = itemType;
    }

    const result = await WishlistItem.deleteMany(query);

    return { removed: result.deletedCount > 0 };
};

export const toggleWishlistItem = async (
    userId: string,
    itemId: mongoose.Types.ObjectId,
    itemType: WishlistItemType
): Promise<{ isWishlisted: boolean; target?: WishlistTarget }> => {
    const existing = await WishlistItem.findOne({ user: userId, itemId, itemType });

    if (existing) {
        await existing.deleteOne();
        return { isWishlisted: false };
    }

    const result = await addWishlistItem(userId, itemId, itemType);
    return { isWishlisted: result.isWishlisted, target: result.target };
};
