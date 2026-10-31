import mongoose from 'mongoose';
import { HeroSlide, MAX_HERO_SLIDE_ORDER, type IHeroSlide } from './hero-slide.model';
import type {
    CreateHeroSlideInput,
    ReorderHeroSlidesInput,
    UpdateHeroSlideInput,
} from './hero-slide.schemas';

/**
 * Hero-slide reads and writes. Every query lives here so the public route and the
 * admin routes cannot drift apart in their filter, sort or shape.
 */

/** What a client receives. `_id`, `__v` and the raw document never leave here. */
export type HeroSlideView = {
  id: string;
  imageUrl: string;
  targetUrl: string;
  altText?: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type HeroSlideRecord = IHeroSlide & { _id: mongoose.Types.ObjectId };

/**
 * `order` first, `createdAt` as the tiebreaker so two slides saved at the same
 * position keep a stable sequence between requests instead of swapping.
 */
const HERO_SLIDE_SORT: Record<string, 1> = { order: 1, createdAt: 1 };

/** The error shape the controller maps to a status; mirrors the other modules. */
export const createHeroSlideError = (
  statusCode: number,
  message: string,
  code: string
): Error & { statusCode: number; code: string } => {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export const serializeHeroSlide = (slide: HeroSlideRecord): HeroSlideView => ({
  id: slide._id.toString(),
  imageUrl: slide.imageUrl,
  targetUrl: slide.targetUrl,
  // `undefined` is omitted by `res.json`, which keeps "no alt text" distinct from `""`.
  altText: slide.altText,
  order: slide.order ?? 0,
  isActive: slide.isActive !== false,
  createdAt: slide.createdAt,
  updatedAt: slide.updatedAt,
});

/* ─────────────────────────── public reads ─────────────────────────── */

/** Storefront: the active slides, in display order. */
export const listActiveHeroSlides = async (): Promise<HeroSlideView[]> => {
  const slides = await HeroSlide.find({ isActive: true }).sort(HERO_SLIDE_SORT).lean().exec();

  return (slides as unknown as HeroSlideRecord[]).map(serializeHeroSlide);
};

/* ──────────────────────────── admin reads ─────────────────────────── */

/**
 * Every slide, active or not. Not paginated: this is a hand-curated list of a few
 * banners and the admin page renders it whole.
 */
export const listAllHeroSlides = async (): Promise<HeroSlideView[]> => {
  const slides = await HeroSlide.find({}).sort(HERO_SLIDE_SORT).lean().exec();

  return (slides as unknown as HeroSlideRecord[]).map(serializeHeroSlide);
};

export const getHeroSlideById = async (id: string): Promise<HeroSlideView | null> => {
  const slide = await HeroSlide.findById(id).lean().exec();

  return slide ? serializeHeroSlide(slide as unknown as HeroSlideRecord) : null;
};

/* ──────────────────────────── admin writes ────────────────────────── */

/**
 * The order a new slide gets when the admin leaves the field blank: one past the
 * current highest, so a new banner lands at the end of the rotation rather than
 * jumping in front of the ones already curated.
 *
 * Capped at `MAX_HERO_SLIDE_ORDER` so a runaway list cannot store an order the
 * schema would then refuse to write back.
 */
const nextHeroSlideOrder = async (): Promise<number> => {
  const highest = await HeroSlide.findOne({}).sort({ order: -1 }).select('order').lean().exec();
  const next = Number((highest as { order?: number } | null)?.order ?? -1) + 1;

  return Math.min(Math.max(next, 0), MAX_HERO_SLIDE_ORDER);
};

export const createHeroSlide = async (input: CreateHeroSlideInput): Promise<HeroSlideView> => {
  const order = input.order ?? (await nextHeroSlideOrder());

  const slide = await HeroSlide.create({
    imageUrl: input.imageUrl,
    targetUrl: input.targetUrl,
    altText: input.altText,
    order,
    isActive: input.isActive ?? true,
  });

  return serializeHeroSlide(slide.toObject() as unknown as HeroSlideRecord);
};

export const updateHeroSlide = async (
  id: string,
  input: UpdateHeroSlideInput
): Promise<HeroSlideView | null> => {
  const slide = await HeroSlide.findById(id).exec();

  if (!slide) {
    return null;
  }

  // Only the keys the caller sent are written: `undefined` means "leave it alone",
  // which is what makes the form's partial submissions safe.
  if (input.imageUrl !== undefined) slide.imageUrl = input.imageUrl;
  if (input.targetUrl !== undefined) slide.targetUrl = input.targetUrl;
  if (input.altText !== undefined) slide.altText = input.altText || undefined;
  if (input.order !== undefined) slide.order = input.order;
  if (input.isActive !== undefined) slide.isActive = input.isActive;

  await slide.save();

  return serializeHeroSlide(slide.toObject() as unknown as HeroSlideRecord);
};

/** `true` when a row was removed, `false` when the id did not exist. */
export const deleteHeroSlide = async (id: string): Promise<boolean> => {
  const result = await HeroSlide.deleteOne({ _id: id }).exec();

  return result.deletedCount > 0;
};

export type HeroSlideReorderResult = { matched: number; modified: number };

/**
 * Applies every `{ id, order }` entry in one `bulkWrite`.
 *
 * `matched` is returned so the caller can notice a **stale** id: an admin who
 * moves a list while someone else deletes a row would otherwise get a 200 for a
 * partly-applied reorder. `ordered: false` lets the writes proceed independently,
 * because the entries are independent of each other.
 */
export const reorderHeroSlides = async (
  entries: ReorderHeroSlidesInput
): Promise<HeroSlideReorderResult> => {
  const result = await HeroSlide.bulkWrite(
    entries.map((entry) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(entry.id) },
        update: { $set: { order: entry.order } },
      },
    })),
    { ordered: false }
  );

  return { matched: result.matchedCount, modified: result.modifiedCount };
};
