/**
 * One-time Mongo migration.
 *
 * Moves every user's legacy wishlist arrays (`wishlist`, `comboWishlist`) into
 * the `wishlistitems` collection, which stores the price the customer saved the
 * item at (used for price-drop) and a real added date (used for sorting).
 *
 * Backfilled items are stored with `priceAtAdd` equal to the CURRENT price, so
 * no false "price dropped" badge appears for items saved before this change.
 * The legacy arrays are left untouched so the previous build keeps working.
 *
 * Safe to re-run: already migrated entries are skipped.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-wishlist-items.ts
 *   npm run migrate:wishlist-items
 */

import '../env';
import mongoose from 'mongoose';
import { connectDB } from '../data-source';
import { UserModel } from '../auth/user.model';
import Product from '../product/product.model';
import Combo from '../combo/combo.model';
import { WishlistItem, WishlistItemType } from '../wishlist/wishlist-item.model';

const wishlistProductSelect = 'price salePrice';
const wishlistComboSelect = 'price';

const priceOf = (json: Record<string, unknown>): number => {
    const price = Number(json.price);
    return Number.isFinite(price) ? price : 0;
};

async function migrateWishlistItems() {
    console.log('⏳ Connecting to MongoDB...');
    await connectDB();

    const users = await UserModel.find({
        $or: [{ wishlist: { $ne: [] } }, { comboWishlist: { $ne: [] } }],
    }).select('wishlist comboWishlist');

    console.log(`👤 Users with a legacy wishlist: ${users.length}`);

    let created = 0;
    let skipped = 0;
    let missing = 0;

    for (const user of users) {
        const refs: Array<{ itemId: mongoose.Types.ObjectId; itemType: WishlistItemType }> = [
            ...(user.wishlist ?? []).map((itemId) => ({
                itemId: itemId as unknown as mongoose.Types.ObjectId,
                itemType: 'product' as const,
            })),
            ...(user.comboWishlist ?? []).map((itemId) => ({
                itemId: itemId as unknown as mongoose.Types.ObjectId,
                itemType: 'combo' as const,
            })),
        ];

        if (refs.length === 0) {
            continue;
        }

        const productIds = refs.filter((ref) => ref.itemType === 'product').map((ref) => ref.itemId);
        const comboIds = refs.filter((ref) => ref.itemType === 'combo').map((ref) => ref.itemId);

        const [products, combos, existing] = await Promise.all([
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
            WishlistItem.find({ user: user._id }).select('itemId itemType').exec(),
        ]);

        const prices = new Map<string, number>();

        for (const doc of products) {
            prices.set(
                `product:${doc._id.toString()}`,
                priceOf(doc.toJSON() as unknown as Record<string, unknown>)
            );
        }

        for (const doc of combos) {
            prices.set(
                `combo:${doc._id.toString()}`,
                priceOf(doc.toJSON() as unknown as Record<string, unknown>)
            );
        }

        const alreadyMigrated = new Set(
            existing.map((record) => `${record.itemType}:${record.itemId.toString()}`)
        );
        const base = Date.now();
        const documents: Array<Record<string, unknown>> = [];

        refs.forEach((ref, index) => {
            const key = `${ref.itemType}:${ref.itemId.toString()}`;

            if (alreadyMigrated.has(key)) {
                skipped += 1;
                return;
            }

            const price = prices.get(key);

            if (price === undefined) {
                // Product/combo was deleted — nothing meaningful to migrate.
                missing += 1;
                return;
            }

            documents.push({
                user: user._id,
                itemId: ref.itemId,
                itemType: ref.itemType,
                priceAtAdd: price,
                // Keep the legacy array order: later array entries are the newest.
                createdAt: new Date(base + index),
                updatedAt: new Date(base + index),
            });
        });

        if (documents.length > 0) {
            await WishlistItem.collection.insertMany(documents);
            created += documents.length;
        }
    }

    console.log(
        `✅ Wishlist items migrated: created=${created}, skipped=${skipped}, missing target=${missing}`
    );
    console.log('ℹ️  Legacy user.wishlist / user.comboWishlist arrays were left untouched.');

    await mongoose.disconnect();
    process.exit(0);
}

migrateWishlistItems().catch(async (error) => {
    console.error('❌ Wishlist item migration failed:', error);
    try {
        await mongoose.disconnect();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
