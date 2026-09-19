import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  WishlistSort,
  addWishlistItem as addWishlistItemService,
  createWishlistError,
  getWishlistSnapshot,
  normalizeWishlistItemType,
  normalizeWishlistSort,
  removeWishlistItem as removeWishlistItemService,
  toggleWishlistItem as toggleWishlistItemService,
} from './wishlist.service';
import { recordActivity } from '../activity-log/activity-log.service';

/** Catalog title for a resolved wishlist item, when we have it. */
const wishlistItemName = (
  target: { product?: Record<string, unknown> } | undefined
): string | undefined => {
  const title = target?.product?.title;
  return typeof title === 'string' ? title : undefined;
};

/** Participant activity for saved/removed wishlist items. */
const logWishlistActivity = async (
  req: AuthenticatedRequest,
  action: 'CREATE' | 'DELETE',
  itemId: unknown,
  itemType: string,
  itemName?: string
): Promise<void> => {
  await recordActivity(req, {
    action,
    entityType: 'WISHLIST',
    entityId: String(itemId),
    entityName: itemName,
    description: `${action === 'CREATE' ? 'Saved' : 'Removed'} ${itemName ?? `a ${itemType}`} ${action === 'CREATE' ? 'to' : 'from'
      } the wishlist`,
    metadata: { itemType },
  });
};

const respondWithError = (res: Response, error: unknown, fallbackMessage: string): void => {
  const err = error as { statusCode?: number; message?: string; code?: string };

  if ((err.statusCode ?? 500) >= 500) {
    console.error('[wishlist]', error);
  }

  res.status(err.statusCode ?? 500).json({
    success: false,
    message: err.message ?? fallbackMessage,
    ...(err.code ? { code: err.code } : {}),
  });
};

/**
 * The legacy response shape (`productIds` + `products`) is preserved so the
 * existing hearts/count keep working; `items` adds the per-item price, stock
 * and price-drop data the upgraded wishlist UI needs.
 */
const respondWithWishlist = async (
  res: Response,
  userId: string,
  sort: WishlistSort,
  extra: Record<string, unknown> = {}
): Promise<void> => {
  const snapshot = await getWishlistSnapshot(userId, sort);

  res.status(200).json({
    success: true,
    sort: snapshot.sort,
    productIds: snapshot.itemIds,
    products: snapshot.products,
    items: snapshot.items,
    ...extra,
  });
};

const readItemId = (value: unknown): mongoose.Types.ObjectId => {
  const raw = typeof value === 'string' ? value.trim() : '';

  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) {
    throw createWishlistError(400, 'A valid itemId is required', 'invalid_item_id');
  }

  return new mongoose.Types.ObjectId(raw);
};

/** Accepts `itemId` (current) and `productId` (legacy field name). */
const readWishlistTarget = (body: unknown) => {
  const payload = (body ?? {}) as { itemId?: unknown; productId?: unknown; itemType?: unknown };

  return {
    itemId: readItemId(payload.itemId ?? payload.productId),
    itemType: normalizeWishlistItemType(payload.itemType),
  };
};

export const getWishlist = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await respondWithWishlist(res, req.user.id, normalizeWishlistSort(req.query.sort));
  } catch (error) {
    respondWithError(res, error, 'Unable to load your wishlist');
  }
};

/** Idempotent add — re-saving an item keeps the price/date it was first saved at. */
export const addToWishlist = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { itemId, itemType } = readWishlistTarget(req.body);
    const { isWishlisted, created, target } = await addWishlistItemService(req.user.id, itemId, itemType);

    if (created) {
      await logWishlistActivity(req, 'CREATE', itemId, itemType, wishlistItemName(target));
    }

    await respondWithWishlist(res, req.user.id, normalizeWishlistSort(req.body?.sort), {
      isWishlisted,
    });
  } catch (error) {
    respondWithError(res, error, 'Unable to add this item to your wishlist');
  }
};

export const removeFromWishlist = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const itemId = readItemId(req.params.itemId);
    const itemType =
      req.query.itemType === undefined ? undefined : normalizeWishlistItemType(req.query.itemType);
    const { removed } = await removeWishlistItemService(req.user.id, itemId, itemType);

    if (removed) {
      await logWishlistActivity(req, 'DELETE', itemId, itemType ?? 'product');
    }

    await respondWithWishlist(res, req.user.id, normalizeWishlistSort(req.query.sort), {
      removed,
    });
  } catch (error) {
    respondWithError(res, error, 'Unable to remove this item from your wishlist');
  }
};

export const toggleWishlist = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { itemId, itemType } = readWishlistTarget(req.body);
    const { isWishlisted, target } = await toggleWishlistItemService(req.user.id, itemId, itemType);

    await logWishlistActivity(
      req,
      isWishlisted ? 'CREATE' : 'DELETE',
      itemId,
      itemType,
      wishlistItemName(target)
    );

    await respondWithWishlist(res, req.user.id, normalizeWishlistSort(req.body?.sort), {
      isWishlisted,
    });
  } catch (error) {
    respondWithError(res, error, 'Unable to update your wishlist');
  }
};
