import mongoose, { Document, Schema } from 'mongoose';

/**
 * A storefront brand — an independent entity, not a settings singleton.
 *
 * Deliberately CRUD rather than one whole-document PUT (the shape the mega menu
 * and the other singletons use): 32 brands exist, each with its own logo,
 * ordering and two visibility flags, and they are edited one at a time. A single
 * document would let two concurrent editors overwrite each other's work, and one
 * malformed row would refuse a save that had nothing to do with it.
 *
 * ## Why `slug` exists when links carry the name
 *
 * The storefront filters products with `?brand=COSRX`, a case-insensitive exact
 * match on the product's `brand` string (`buildExactMatchCondition` in
 * `product.controller.ts`), and that is what the navbar and the mega menu send.
 * The slug is therefore **not** a routing key today — it is the stable, unique
 * handle a brand row can be addressed by if a path-based brand page is ever
 * added, and it is what makes "the same brand twice" a database error rather
 * than a duplicate that only shows up as two identical nav entries.
 */

/** Name ceiling. Mirrors the model constraint and the request schema. */
export const MAX_BRAND_NAME_LENGTH = 80;
/** Alt-text ceiling, in line with the other media alt fields. */
export const MAX_BRAND_LOGO_ALT_LENGTH = 160;
/** Slug ceiling — a slug longer than this is not a slug anyone can read. */
export const MAX_BRAND_SLUG_LENGTH = 100;

export interface IBrand {
  /** Display name, e.g. `"COSRX"`. Matched case-insensitively against products. */
  name: string;
  /** Unique, lower-case handle derived from `name` when the client omits it. */
  slug: string;
  /** ImageKit URL of the logo. Absent for most brands — only a few have artwork. */
  logoUrl?: string;
  /** Alt text for the logo, for SEO and screen readers. */
  logoAlt?: string;
  /**
   * Intrinsic pixel dimensions of the logo, stored so the storefront can set
   * `width`/`height` and reserve the box before the image loads. A logo grid that
   * reflows once the images arrive is the layout shift this prevents.
   */
  logoWidth?: number;
  logoHeight?: number;
  /** Show in the storefront's brand dropdown. */
  showInNavbar: boolean;
  /** Show in the homepage's auto-scrolling logo marquee. */
  showInMarquee: boolean;
  /** Master switch. `false` hides the brand everywhere without deleting it. */
  visible: boolean;
  /** Manual ordering, ascending. Ties fall back to `name`. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export type IBrandDocument = IBrand & Document;

const BrandSchema = new Schema<IBrandDocument>(
  {
    name: {
      type: String,
      required: [true, 'Brand name is required'],
      trim: true,
      maxlength: [
        MAX_BRAND_NAME_LENGTH,
        `Brand name cannot exceed ${MAX_BRAND_NAME_LENGTH} characters`,
      ],
    },
    slug: {
      type: String,
      required: [true, 'Brand slug is required'],
      trim: true,
      lowercase: true,
      maxlength: [
        MAX_BRAND_SLUG_LENGTH,
        `Brand slug cannot exceed ${MAX_BRAND_SLUG_LENGTH} characters`,
      ],
    },
    /**
     * The URL *shape* is enforced by `createBrandSchema` / `updateBrandSchema`
     * through `safeUrlSchema()` — an `https://` URL or a site-relative path, which
     * is what keeps `javascript:` out of a value the storefront binds to `src`.
     * The model only trims, so "absent" has a single representation and a
     * whitespace-only string cannot masquerade as a logo.
     */
    logoUrl: {
      type: String,
      trim: true,
    },
    logoAlt: {
      type: String,
      trim: true,
      maxlength: [
        MAX_BRAND_LOGO_ALT_LENGTH,
        `Logo alt text cannot exceed ${MAX_BRAND_LOGO_ALT_LENGTH} characters`,
      ],
    },
    logoWidth: {
      type: Number,
      min: [1, 'Logo width must be a positive number'],
    },
    logoHeight: {
      type: Number,
      min: [1, 'Logo height must be a positive number'],
    },
    showInNavbar: {
      type: Boolean,
      default: false,
    },
    showInMarquee: {
      type: Boolean,
      default: false,
    },
    visible: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

/**
 * One brand per slug, enforced by the database rather than by a read-then-write
 * check: two concurrent creates would both pass a pre-check and both insert. The
 * controller maps the resulting duplicate-key error to 409.
 */
BrandSchema.index({ slug: 1 }, { unique: true });

/**
 * Every read sorts by `order` first — the public list, the marquee list and the
 * admin list — so it is indexed. `name` is the tiebreaker in the sort, which no
 * index covers on its own; with 32 rows that costs nothing, and a compound
 * `{ order: 1, name: 1 }` would only be worth it if this collection grew.
 */
BrandSchema.index({ order: 1 });

BrandSchema.set('toJSON', {
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

export const Brand: mongoose.Model<IBrandDocument> =
  mongoose.models.Brand || mongoose.model<IBrandDocument>('Brand', BrandSchema);

export default Brand;
