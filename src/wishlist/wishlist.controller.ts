import { Response } from 'express';
import mongoose, { Schema } from 'mongoose';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserModel } from '../auth/user.model';
import Product from '../product/product.model';
import Combo from '../combo/combo.model';

const wishlistProductSelect =
  'title slug brand category description skinType skinConcern price salePrice badge images hoverImage volume stock isBestSeller isNewArrival isTrending rating numReviews createdAt updatedAt';

const wishlistComboSelect =
  'title slug badge description price compareAtPrice savings includedItems routineTag category brand images hoverImage size volume stock rating numReviews concerns skinType isBestSeller isNewArrival createdAt updatedAt';

const normalizeWishlistIds = (wishlist: unknown[]): string[] =>
  wishlist
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'object' && '_id' in item) {
        return (item as { _id: unknown })._id?.toString();
      }
      return item.toString();
    })
    .filter(Boolean) as string[];

const compactPopulatedWishlist = <T>(wishlist: unknown[]): T[] =>
  wishlist.filter((item): item is T => Boolean(item));

const populateWishlist = (userId: string) =>
  UserModel.findById(userId)
    .populate({
      path: 'wishlist',
      select: wishlistProductSelect,
    })
    .populate({
      path: 'comboWishlist',
      select: wishlistComboSelect,
    });

async function findWishlistTarget(productId: string, itemType: string | undefined) {
  if (itemType === 'combo') {
    return Combo.findById(productId).select('_id').lean();
  }

  if (!itemType || itemType === 'product') {
    return Product.findById(productId).select('_id').lean();
  }

  return null;
}

export const getWishlist = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const user = await populateWishlist(req.user.id);

    if (!user) {
      res.status(401).json({ success: false, message: 'User session is no longer valid' });
      return;
    }

    const productWishlist = compactPopulatedWishlist(user.wishlist ?? []);
    const comboWishlist = compactPopulatedWishlist(user.comboWishlist ?? []);

    res.status(200).json({
      success: true,
      productIds: [
        ...normalizeWishlistIds(productWishlist),
        ...normalizeWishlistIds(comboWishlist),
      ],
      products: [...productWishlist, ...comboWishlist],
    });
  } catch (error) {
    console.error('[getWishlist]', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
};

export const toggleWishlist = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { productId, itemType } = req.body || {};

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      res.status(400).json({ success: false, message: 'A valid productId is required' });
      return;
    }

    if (itemType !== 'product' && itemType !== 'combo' && itemType != null) {
      res.status(400).json({ success: false, message: 'itemType must be product or combo' });
      return;
    }

    const target = await findWishlistTarget(productId, itemType);

    if (!target) {
      res.status(404).json({
        success: false,
        message: `${itemType === 'combo' ? 'Combo' : 'Product'} not found`,
      });
      return;
    }

    const user = await UserModel.findById(req.user.id);

    if (!user) {
      res.status(401).json({ success: false, message: 'User session is no longer valid' });
      return;
    }

    const isCombo = itemType === 'combo';
    const currentWishlist = isCombo ? user.comboWishlist ?? [] : user.wishlist ?? [];
    const currentIds = normalizeWishlistIds(currentWishlist);
    const exists = currentIds.includes(productId);
    const nextWishlist = exists
      ? currentWishlist.filter((id) => id.toString() !== productId)
      : [...currentWishlist, new mongoose.Types.ObjectId(productId) as unknown as Schema.Types.ObjectId];

    if (isCombo) {
      user.comboWishlist = nextWishlist;
    } else {
      user.wishlist = nextWishlist;
    }

    await user.save();

    const populatedUser = await populateWishlist(req.user.id);
    const productWishlist = compactPopulatedWishlist(populatedUser?.wishlist ?? []);
    const comboWishlist = compactPopulatedWishlist(populatedUser?.comboWishlist ?? []);

    res.status(200).json({
      success: true,
      isWishlisted: !exists,
      productIds: [
        ...normalizeWishlistIds(productWishlist),
        ...normalizeWishlistIds(comboWishlist),
      ],
      products: [...productWishlist, ...comboWishlist],
    });
  } catch (error) {
    console.error('[toggleWishlist]', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
};
