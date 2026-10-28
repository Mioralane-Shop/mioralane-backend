import { Product } from './product.model';
import { slugify } from '../utils/slugify';

/**
 * Advisory duplicate detection for the admin's product form.
 *
 * The ENFORCED rule stays elsewhere: the `slug` field is unique, and
 * `createProduct`/`updateProduct` answer 409 when a save would collide on a
 * normalized name (the 11000 path). This module is the softer, earlier warning —
 * it surfaces exact-normalized matches AND near matches so the admin can decide
 * before saving, without ever rejecting a legitimate size/variant on its own.
 */

/** A product as the duplicate list shows it. */
export interface DuplicateMatch {
  id: string;
  title: string;
  brand: string;
  image: string | null;
  volume: string | null;
  slug: string;
}

/** How many candidates to score, and how many to return. */
const CANDIDATE_CAP = 500;
const MAX_MATCHES = 8;

/**
 * Similarity below which two titles are considered unrelated. Chosen so that a
 * missing word or a swapped token still reads "similar" while "Snail Essence"
 * and "Hyaluronic Toner" do not.
 */
const SIMILARITY_THRESHOLD = 0.75;

/**
 * Case, accents, punctuation, spacing and hyphen differences all collapse here.
 * `&` becomes the word "and" so "Oil & Blemish" matches "oil and blemish".
 */
export function normalizeProductTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/** Classic Levenshtein distance — no dependency, fine for a few hundred rows. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = row;
  }

  return previous[b.length];
}

/** 0..1 — 1 is identical, 0 shares nothing. */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function firstImage(product: {
  media?: Array<{ url?: string }> | null;
  images?: string[] | null;
}): string | null {
  const media = product.media;
  if (Array.isArray(media)) {
    for (const entry of media) {
      if (entry?.url) return entry.url;
    }
  }

  const images = product.images;
  if (Array.isArray(images) && images.length > 0) {
    return images[0];
  }

  return null;
}

/**
 * Exact-normalized and similar products for `title`, excluding `excludeId`.
 *
 * The candidate pool is a bounded read of the whole collection — bounded rather
 * than indexed because the catalogue is small and a text index is a schema
 * change this advisory path does not need. Exact matches are returned first,
 * then near matches by descending similarity, capped at MAX_MATCHES.
 */
export async function findDuplicateProducts(
  title: string,
  excludeId?: string,
): Promise<DuplicateMatch[]> {
  const normalized = normalizeProductTitle(title);
  if (!normalized) return [];

  const filter: Record<string, unknown> = {};
  if (excludeId) filter._id = { $ne: excludeId };

  const candidates = await Product.find(filter)
    .select('title shortName brand images media volume slug')
    .lean()
    .limit(CANDIDATE_CAP);

  const targetSlug = slugify(title);
  const scored: Array<{ match: DuplicateMatch; exact: boolean; score: number }> = [];

  for (const candidate of candidates) {
    const candidateTitle = typeof candidate.title === 'string' ? candidate.title : '';
    const candidateNorm = normalizeProductTitle(candidateTitle);
    const candidateSlug = typeof candidate.slug === 'string' && candidate.slug ? candidate.slug : slugify(candidateTitle);

    const isExact = candidateNorm.length > 0 && (candidateNorm === normalized || candidateSlug === targetSlug);
    const score = isExact
      ? 1
      : Math.max(similarity(candidateNorm, normalized), similarity(candidateSlug, targetSlug));

    if (!isExact && score < SIMILARITY_THRESHOLD) continue;

    scored.push({
      exact: isExact,
      score,
      match: {
        id: candidate._id.toString(),
        title: candidateTitle,
        brand: typeof candidate.brand === 'string' ? candidate.brand : '',
        image: firstImage(candidate),
        volume: typeof candidate.volume === 'string' ? candidate.volume : null,
        slug: candidateSlug,
      },
    });
  }

  scored.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return b.score - a.score;
  });

  return scored.slice(0, MAX_MATCHES).map((entry) => entry.match);
}
