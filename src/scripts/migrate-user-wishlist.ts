/**
 * One-time Mongo migration.
 *
 * Backfills existing users so old documents gain the new wishlist fields:
 * - wishlist: []
 * - comboWishlist: []
 *
 * Usage:
 *   npx tsx src/scripts/migrate-user-wishlist.ts
 */

import "../env";
import { connectDB } from "../data-source";
import { UserModel } from "../auth/user.model";

async function migrateUserWishlist() {
  console.log("⏳ Connecting to MongoDB...");
  await connectDB();

  const wishlistResult = await UserModel.updateMany(
    {
      $or: [{ wishlist: { $exists: false } }, { wishlist: null }],
    },
    {
      $set: { wishlist: [] },
    }
  );

  const comboWishlistResult = await UserModel.updateMany(
    {
      $or: [{ comboWishlist: { $exists: false } }, { comboWishlist: null }],
    },
    {
      $set: { comboWishlist: [] },
    }
  );

  console.log(
    `✅ Wishlist backfill complete. wishlist matched=${wishlistResult.matchedCount}, modified=${wishlistResult.modifiedCount}`
  );
  console.log(
    `✅ Combo wishlist backfill complete. comboWishlist matched=${comboWishlistResult.matchedCount}, modified=${comboWishlistResult.modifiedCount}`
  );

  process.exit(0);
}

migrateUserWishlist().catch((error) => {
  console.error("❌ Wishlist migration failed:", error);
  process.exit(1);
});
