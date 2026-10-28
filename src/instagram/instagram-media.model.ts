import mongoose, { Document, Schema } from 'mongoose';

/**
 * One row per Instagram media item, keyed by the Instagram media id.
 *
 * Rows are created/refreshed exclusively by the backend sync flow (the Meta
 * Graph API call happens server-side; the token never leaves the server).
 * The admin's featured selection lives in the separate `InstagramSettings`
 * singleton — sync updates metadata only and NEVER touches `featuredMediaIds`,
 * so new posts never displace an admin's saved homepage selection.
 *
 * URLs here come from Meta's API responses, not from client input. They are
 * still normalized on the way in (https-only; permalinks must be
 * `https://www.instagram.com/...`) so a changed/broken upstream response cannot
 * inject a `javascript:` or `http:` value into the storefront markup.
 */

export const INSTAGRAM_MEDIA_TYPES = ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'] as const;
export type InstagramMediaType = (typeof INSTAGRAM_MEDIA_TYPES)[number];

export const INSTAGRAM_PRODUCT_TYPES = ['FEED', 'REELS', 'STORIES', 'IGTV', 'AD'] as const;
export type InstagramProductType = (typeof INSTAGRAM_PRODUCT_TYPES)[number];

export const MAX_INSTAGRAM_CAPTION_LENGTH = 2200;
export const MAX_INSTAGRAM_URL_LENGTH = 1000;

/** Media ids from the Graph API are numeric strings up to ~20 digits. */
export const MAX_INSTAGRAM_MEDIA_ID_LENGTH = 64;

export type InstagramMediaValue = {
  /** The Instagram media id — unique and the upsert key for repeated syncs. */
  mediaId: string;
  accountId?: string;
  permalink?: string;
  caption?: string;
  mediaType: InstagramMediaType;
  /** REELS vs FEED vs … — only present when the API returned it. */
  mediaProductType?: InstagramProductType;
  mediaUrl?: string;
  thumbnailUrl?: string;
  /** Publication time from the API (`timestamp`). */
  timestamp?: Date;
};

export interface IInstagramMediaDocument extends InstagramMediaValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

const InstagramMediaSchema = new Schema<IInstagramMediaDocument>(
  {
    mediaId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      maxlength: [MAX_INSTAGRAM_MEDIA_ID_LENGTH, 'Instagram media id is too long'],
    },
    accountId: {
      type: String,
      trim: true,
      maxlength: [MAX_INSTAGRAM_MEDIA_ID_LENGTH, 'Instagram account id is too long'],
    },
    permalink: {
      type: String,
      trim: true,
      maxlength: [MAX_INSTAGRAM_URL_LENGTH, 'Instagram permalink is too long'],
    },
    caption: {
      type: String,
      default: undefined,
      maxlength: [MAX_INSTAGRAM_CAPTION_LENGTH, 'Instagram caption is too long'],
    },
    mediaType: {
      type: String,
      enum: [...INSTAGRAM_MEDIA_TYPES],
      required: true,
    },
    mediaProductType: {
      type: String,
      enum: [...INSTAGRAM_PRODUCT_TYPES],
      default: undefined,
    },
    mediaUrl: {
      type: String,
      trim: true,
      maxlength: [MAX_INSTAGRAM_URL_LENGTH, 'Instagram media URL is too long'],
    },
    thumbnailUrl: {
      type: String,
      trim: true,
      maxlength: [MAX_INSTAGRAM_URL_LENGTH, 'Instagram thumbnail URL is too long'],
    },
    timestamp: {
      type: Date,
      default: undefined,
    },
  },
  { timestamps: true }
);

InstagramMediaSchema.index({ timestamp: -1, mediaId: -1 });

export const InstagramMedia =
  mongoose.models.InstagramMedia ||
  mongoose.model<IInstagramMediaDocument>('InstagramMedia', InstagramMediaSchema);
