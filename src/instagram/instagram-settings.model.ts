import mongoose, { Document, Schema } from 'mongoose';

/**
 * Homepage Instagram showcase selection — a singleton.
 *
 * `featuredMediaIds` is the ordered list of Instagram media ids the admin
 * wants on the storefront. The array IS the display order. Selection is kept
 * separate from the synced media rows precisely so a sync can never touch it.
 *
 * The 5–7 rule is soft on purpose: the backend enforces the hard maximum (7)
 * and that every id is a synced reel, but it does NOT refuse a selection of
 * fewer than 5 — the connected account may simply not have five eligible reels
 * yet, and the admin UI explains that instead of blocking all management.
 */

export const MAX_FEATURED_INSTAGRAM_VIDEOS = 7;
export const MIN_FEATURED_INSTAGRAM_VIDEOS = 5;

export type InstagramSettingsValue = {
  singletonKey: 'instagram_feed';
  featuredMediaIds: string[];
  /** Set by the last successful sync (server clock). */
  lastSyncAt?: Date | null;
  /**
   * Last time the stored media URLs were refreshed from Meta. Instagram's
   * `media_url` / `thumbnail_url` are signed links that expire after a few days,
   * so the read paths re-fetch them (see `refreshStaleInstagramUrls`) and use
   * this field to keep that from happening on every request.
   */
  lastUrlRefreshAt?: Date | null;
};

export interface IInstagramSettingsDocument extends InstagramSettingsValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_INSTAGRAM_SETTINGS: InstagramSettingsValue = {
  singletonKey: 'instagram_feed',
  featuredMediaIds: [],
};

const InstagramSettingsSchema = new Schema<IInstagramSettingsDocument>(
  {
    singletonKey: {
      type: String,
      enum: ['instagram_feed'],
      default: 'instagram_feed',
      unique: true,
      index: true,
      immutable: true,
    },
    featuredMediaIds: {
      type: [String],
      default: [],
    },
    lastSyncAt: {
      type: Date,
      default: undefined,
    },
    lastUrlRefreshAt: {
      type: Date,
      default: undefined,
    },
  },
  { timestamps: true }
);

export const InstagramSettings =
  mongoose.models.InstagramSettings ||
  mongoose.model<IInstagramSettingsDocument>('InstagramSettings', InstagramSettingsSchema);
