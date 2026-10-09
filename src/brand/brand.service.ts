import mongoose from 'mongoose';
import { slugify } from '../utils/slugify';
import { Brand, type IBrand, type IBrandDocument } from './brand.model';
import type { CreateBrandInput, ReorderBrandsInput, UpdateBrandInput } from './brand.schemas';

/**
 * Brand reads and writes. Every query lives here so the two public routes and
 * the six admin routes cannot drift apart in their filters, sort or shape.
 */

/** What a client receives. `_id`, `__v` and the raw document never leave here. */
export type BrandView = {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
  logoAlt?: string;
  logoWidth?: number;
  logoHeight?: number;
  showInNavbar: boolean;
  showInMarquee: boolean;
  visible: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Lean reads and `toObject()` both produce this; declared once so the serializer
 * has a parameter type instead of `any`, without widening it to `any` either.
 */
type BrandRecord = IBrand & { _id: mongoose.Types.ObjectId };

/** `order` first; `name` breaks ties so two brands at one position do not swap between requests. */
const BRAND_SORT: Record<string, 1> = { order: 1, name: 1 };

export const BRAND_SLUG_ERROR = 'Brand slug must contain at least one letter or number';

/** The error shape the controller maps to a status; mirrors the other modules. */
export const createBrandError = (
  statusCode: number,
  message: string,
  code: string
): Error & { statusCode: number; code: string } => {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export const serializeBrand = (brand: BrandRecord): BrandView => ({
  id: brand._id.toString(),
  name: brand.name,
  slug: brand.slug,
  // Emitted as `undefined` when absent, which `res.json` omits — "no logo" stays
  // distinguishable from `""` without a second flag.
  logoUrl: brand.logoUrl,
  logoAlt: brand.logoAlt,
  logoWidth: brand.logoWidth,
  logoHeight: brand.logoHeight,
  showInNavbar: brand.showInNavbar,
  showInMarquee: brand.showInMarquee,
  visible: brand.visible,
  order: brand.order,
  createdAt: brand.createdAt,
  updatedAt: brand.updatedAt,
});

/**
 * The audit snapshot: the editable fields only.
 *
 * `updatedAt` is deliberately excluded — including it would put a changed field
 * on every entry, so `buildActivityChanges` would report a change for a save that
 * changed nothing a reader cares about, and the diff would stop meaning anything.
 */
export const brandSnapshot = (brand: BrandView): Record<string, unknown> => ({
  name: brand.name,
  slug: brand.slug,
  logoUrl: brand.logoUrl,
  logoAlt: brand.logoAlt,
  logoWidth: brand.logoWidth,
  logoHeight: brand.logoHeight,
  showInNavbar: brand.showInNavbar,
  showInMarquee: brand.showInMarquee,
  visible: brand.visible,
  order: brand.order,
});

const toRecord = (doc: IBrandDocument): BrandRecord => doc.toObject() as unknown as BrandRecord;

/** `''` means "clear this" everywhere else in this module, never "store a blank". */
const emptyToUndefined = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return value.trim() ? value : undefined;
};

/**
 * The slug for a brand, from an optional client value or the name.
 *
 * A blank *or* absent candidate both derive from the name — that is what makes
 * `{ name: 'COSRX' }` alone a valid create, and it is the same rule the admin UI
 * relies on when it leaves the field empty.
 */
const resolveSlug = (candidate: string | undefined, name: string): string => {
  const provided = candidate?.trim();
  const slug = slugify(provided ? provided : name);

  if (!slug) {
    // Reachable: `slugify('###')` is `''`. Without this the document would fail
    // its required-slug constraint with a Mongoose message instead of a clean 400.
    throw createBrandError(400, BRAND_SLUG_ERROR, 'invalid_brand_slug');
  }

  return slug;
};

/* ─────────────────────────── public reads ─────────────────────────── */

/** Visible brands, in display order. */
export const listVisibleBrands = async (): Promise<BrandView[]> => {
  const brands = await Brand.find({ visible: true }).sort(BRAND_SORT).lean().exec();

  return (brands as unknown as BrandRecord[]).map(serializeBrand);
};

/**
 * What the homepage marquee may render: visible, opted in, **and with a logo**.
 *
 * `$exists: true` is load-bearing next to `$nin`. On its own, `$nin: [null, '']`
 * also matches documents where the field is absent — MongoDB treats a missing
 * field as "not in this list" — so a logo-less brand would pass the filter and
 * render as a blank tile in the marquee.
 */
export const listMarqueeBrands = async (): Promise<BrandView[]> => {
  const brands = await Brand.find({
    visible: true,
    showInMarquee: true,
    logoUrl: { $exists: true, $nin: [null, ''] },
  })
    .sort(BRAND_SORT)
    .lean()
    .exec();

  return (brands as unknown as BrandRecord[]).map(serializeBrand);
};

/* ──────────────────────────── admin reads ─────────────────────────── */

/**
 * Every brand, visible or not. Not paginated: this collection is a curated list
 * of a few dozen rows and the admin page renders it whole, so pagination would
 * add a parameter nobody sets and a failure mode (the second page) nobody wants.
 */
export const listAllBrands = async (): Promise<BrandView[]> => {
  const brands = await Brand.find({}).sort(BRAND_SORT).lean().exec();

  return (brands as unknown as BrandRecord[]).map(serializeBrand);
};

export const getBrandById = async (id: string): Promise<BrandView | null> => {
  const brand = await Brand.findById(id).exec();

  return brand ? serializeBrand(toRecord(brand)) : null;
};

/* ──────────────────────────── admin writes ─────────────────────────── */

export const createBrand = async (input: CreateBrandInput): Promise<BrandView> => {
  const brand = await Brand.create({
    name: input.name,
    slug: resolveSlug(input.slug, input.name),
    logoUrl: emptyToUndefined(input.logoUrl),
    logoAlt: emptyToUndefined(input.logoAlt),
    // Absent keys stay `undefined` so the model defaults apply; a duplicate slug
    // surfaces as a 11000 error, which the controller maps to 409.
    logoWidth: input.logoWidth,
    logoHeight: input.logoHeight,
    showInNavbar: input.showInNavbar,
    showInMarquee: input.showInMarquee,
    visible: input.visible,
    order: input.order,
  });

  return serializeBrand(toRecord(brand));
};

/**
 * Partial update, with PATCH semantics spelled out.
 *
 * An **absent** key means "leave it alone"; an **empty string** for `logoUrl` /
 * `logoAlt` means "clear it". Conflating the two is how a PATCH either wipes a
 * field the caller never mentioned or makes clearing one impossible.
 *
 * A rename does NOT re-derive the slug: the storefront links by name and the slug
 * is the stable handle for a row, so silently rewriting it on every edit would
 * break any link that already exists. Send `slug` to change it, or `slug: ''` to
 * re-derive it from the (possibly new) name.
 *
 * Returns `null` when the brand does not exist, so the controller can answer 404
 * without a second query.
 */
export const updateBrand = async (
  id: string,
  input: UpdateBrandInput
): Promise<{ before: BrandView; after: BrandView } | null> => {
  const brand = await Brand.findById(id).exec();

  if (!brand) {
    return null;
  }

  const before = serializeBrand(toRecord(brand));

  if (input.name !== undefined) {
    brand.name = input.name;
  }

  if (input.slug !== undefined) {
    brand.slug = resolveSlug(input.slug, brand.name);
  }

  if (input.logoUrl !== undefined) {
    // Assigning `undefined` unsets the path on save, so a cleared logo is absent
    // rather than an empty string.
    brand.logoUrl = emptyToUndefined(input.logoUrl);
  }

  if (input.logoAlt !== undefined) {
    brand.logoAlt = emptyToUndefined(input.logoAlt);
  }

  if (input.logoWidth !== undefined) {
    brand.logoWidth = input.logoWidth;
  }

  if (input.logoHeight !== undefined) {
    brand.logoHeight = input.logoHeight;
  }

  if (input.showInNavbar !== undefined) {
    brand.showInNavbar = input.showInNavbar;
  }

  if (input.showInMarquee !== undefined) {
    brand.showInMarquee = input.showInMarquee;
  }

  if (input.visible !== undefined) {
    brand.visible = input.visible;
  }

  if (input.order !== undefined) {
    brand.order = input.order;
  }

  // `save()` rather than `findByIdAndUpdate`: the model's own validators run, and
  // the previous state is already in hand for the audit entry.
  await brand.save();

  return { before, after: serializeBrand(toRecord(brand)) };
};

export const deleteBrand = async (id: string): Promise<BrandView | null> => {
  const brand = await Brand.findByIdAndDelete(id).exec();

  return brand ? serializeBrand(toRecord(brand)) : null;
};

/** How many entries a reorder expected to find, and how many it actually did. */
export type ReorderResult = { matched: number; expected: number };

/**
 * Bulk reorder in one round trip, mirroring the drag that produced it.
 *
 * `matched` is returned so the caller can notice a **stale** id: an admin who
 * drags a list while someone else deletes a row would otherwise get a 200 for a
 * partly-applied reorder. `ordered: false` lets the writes proceed independently —
 * `order` values are independent, so one bad entry should not abandon the rest.
 */
export const reorderBrands = async (entries: ReorderBrandsInput): Promise<ReorderResult> => {
  const result = await Brand.bulkWrite(
    entries.map((entry) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(entry.id) },
        update: { $set: { order: entry.order } },
      },
    })),
    { ordered: false }
  );

  return { matched: result.matchedCount ?? 0, expected: entries.length };
};
