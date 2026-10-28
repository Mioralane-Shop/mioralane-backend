import { z } from 'zod';
import { numericField, optionalNumericField } from '../utils/validation';
import { MAX_INSTAGRAM_MEDIA_ID_LENGTH } from './instagram-media.model';
import {
  MAX_FEATURED_INSTAGRAM_VIDEOS,
} from './instagram-settings.model';

/**
 * Request schemas for the Instagram feed endpoints.
 *
 * `featuredMediaIds` is capped at the hard maximum here (shape-level); the
 * service additionally verifies each id refers to a synced reel and preserves
 * the submitted order as the display order. The soft minimum of
 * `MIN_FEATURED_INSTAGRAM_VIDEOS` is deliberately NOT enforced here — see the
 * singleton model for why.
 */

export const instagramSelectionSchema = z.object({
  featuredMediaIds: z
    .array(z.string().trim().min(1).max(MAX_INSTAGRAM_MEDIA_ID_LENGTH))
    .max(
      MAX_FEATURED_INSTAGRAM_VIDEOS,
      `At most ${MAX_FEATURED_INSTAGRAM_VIDEOS} Reels can be featured on the homepage`
    ),
});

export type InstagramSelectionInput = z.infer<typeof instagramSelectionSchema>;

/** Sync query: how many rows to pull from the Graph API this page. */
export const instagramSyncQuerySchema = z.object({
  limit: optionalNumericField(numericField(z.coerce.number().int().min(1).max(50))),
  after: z.string().trim().max(500).optional(),
});

export type InstagramSyncQueryInput = z.infer<typeof instagramSyncQuerySchema>;
