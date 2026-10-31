import mongoose, { Document, Schema } from 'mongoose';

/**
 * A homepage hero slide.
 *
 * Each slide is a **pre-designed poster image** plus the URL it should navigate to.
 * There is no copy on this model on purpose: the storefront renders the artwork as
 * it was exported, so nothing here can disagree with the pixels.
 *
 * Deliberately a collection rather than a singleton document (the shape the mega
 * menu and the announcement bar use). Slides are added and removed one at a time,
 * and a single document would let two concurrent editors overwrite each other's
 * work while one malformed row refused a save that had nothing to do with it.
 */

/** URL ceiling. Long enough for a signed ImageKit URL with transformations. */
export const MAX_HERO_SLIDE_URL_LENGTH = 2048;
/** Alt-text ceiling, in line with the other media alt fields. */
export const MAX_HERO_SLIDE_ALT_LENGTH = 200;
/** Guard rail on the automatic order: a slide list this long is a misconfiguration. */
export const MAX_HERO_SLIDE_ORDER = 9999;

export interface IHeroSlide {
  /** Poster image. An absolute `https://` URL or a site-relative path. */
  imageUrl: string;
  /** Where clicking the poster goes. Same two shapes as `imageUrl`. */
  targetUrl: string;
  /** Alternative text for screen readers and search engines. */
  altText?: string;
  /** Ascending display order; ties fall back to creation time. */
  order: number;
  /** `false` keeps the slide out of the storefront without deleting it. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IHeroSlideDocument extends IHeroSlide, Document {}

const HeroSlideSchema = new Schema<IHeroSlideDocument>(
  {
    imageUrl: {
      type: String,
      required: [true, 'Image URL is required'],
      trim: true,
      maxlength: [MAX_HERO_SLIDE_URL_LENGTH, `Image URL cannot exceed ${MAX_HERO_SLIDE_URL_LENGTH} characters`],
    },
    targetUrl: {
      type: String,
      required: [true, 'Target URL is required'],
      trim: true,
      maxlength: [MAX_HERO_SLIDE_URL_LENGTH, `Target URL cannot exceed ${MAX_HERO_SLIDE_URL_LENGTH} characters`],
    },
    altText: {
      type: String,
      trim: true,
      default: undefined,
      maxlength: [MAX_HERO_SLIDE_ALT_LENGTH, `Alt text cannot exceed ${MAX_HERO_SLIDE_ALT_LENGTH} characters`],
    },
    order: {
      type: Number,
      default: 0,
      min: [0, 'Order cannot be negative'],
      validate: {
        validator: (value: number) => Number.isInteger(value),
        message: 'Order must be a whole number',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { timestamps: true }
);

/**
 * The public read is `{ isActive: true }` sorted by `order`, so that is the index
 * worth having. It also covers the admin list, which sorts by the same key.
 */
HeroSlideSchema.index({ isActive: 1, order: 1 });

HeroSlideSchema.set('toJSON', {
  transform(_doc, ret) {
    const r = ret as unknown as Record<string, unknown> & {
      _id?: { toString: () => string };
      __v?: unknown;
    };
    r.id = r._id?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const HeroSlide: mongoose.Model<IHeroSlideDocument> =
  mongoose.models.HeroSlide || mongoose.model<IHeroSlideDocument>('HeroSlide', HeroSlideSchema);

export default HeroSlide;
