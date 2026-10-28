import mongoose from 'mongoose';
import {
  InstagramMedia,
  IInstagramMediaDocument,
  INSTAGRAM_MEDIA_TYPES,
  INSTAGRAM_PRODUCT_TYPES,
  InstagramMediaType,
  InstagramProductType,
  InstagramMediaValue,
  MAX_INSTAGRAM_CAPTION_LENGTH,
} from './instagram-media.model';
import {
  DEFAULT_INSTAGRAM_SETTINGS,
  InstagramSettings,
  InstagramSettingsValue,
  MAX_FEATURED_INSTAGRAM_VIDEOS,
  MIN_FEATURED_INSTAGRAM_VIDEOS,
} from './instagram-settings.model';
import { InstagramSelectionInput } from './instagram.schemas';

type HttpError = Error & { statusCode?: number; code?: string };

const createInstagramError = (statusCode: number, message: string, code?: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

// ─── Credentials ───────────────────────────────────────────────────────────
//
// The token is read from the environment at call time and used ONLY to build
// this server's own outgoing request to Meta. It is never returned, stored in
// MongoDB, or written to the log. Error paths below log status codes and Meta's
// error message text, never the request URL (which carries the token).

const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v21.0';
const INSTAGRAM_FETCH_TIMEOUT_MS = 15000;
const INSTAGRAM_SYNC_DEFAULT_LIMIT = 25;

type InstagramCredentials = {
  token: string;
  accountId: string;
};

export const hasInstagramCredentials = (): boolean => Boolean(readInstagramCredentials());

const readInstagramCredentials = (): InstagramCredentials | null => {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? '';
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim() ?? '';

  // The placeholder shipped in .env.example means "not configured", same as absent.
  if (!token || token === 'your_generated_token_here' || !accountId) {
    return null;
  }

  return { token, accountId };
};

// ─── Meta API mapping ──────────────────────────────────────────────────────

type InstagramGraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
  };
};

/**
 * Rate-limit / throttling codes Meta uses across the Graph APIs. 4/17/32 are
 * user/media limits, 613 is "Calls to this api have exceeded the rate limit",
 * 80000/80004 are the business account throttling family.
 */
const INSTAGRAM_THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80004]);

const isTokenExpired = (status: number, body: InstagramGraphErrorBody | null): boolean => {
  const code = body?.error?.code;
  const message = (body?.error?.message ?? '').toLowerCase();
  const type = (body?.error?.type ?? '').toLowerCase();

  // 190 = expired/invalid OAuth token, 463 = expired access token.
  return (
    code === 190 ||
    code === 463 ||
    type === 'oauthaccessdeniedexception' ||
    (message.includes('token') &&
      (message.includes('expired') || message.includes('invalid') || message.includes('revoked')))
  );
};

const isRateLimited = (status: number, body: InstagramGraphErrorBody | null): boolean => {
  if (status === 429) {
    return true;
  }

  const code = body?.error?.code;
  return typeof code === 'number' && INSTAGRAM_THROTTLE_CODES.has(code);
};

const sanitizeInstagramGraphMessage = (body: InstagramGraphErrorBody | null): string => {
  const message = (body?.error?.error_user_msg ?? body?.error?.message ?? '').trim();
  if (!message) {
    return 'Instagram API error';
  }

  return message.slice(0, 300);
};

const mapInstagramGraphError = (status: number, body: InstagramGraphErrorBody | null): never => {
  if (isTokenExpired(status, body)) {
    throw createInstagramError(
      401,
      'The connected Instagram access token has expired or been revoked. Generate a new token and update INSTAGRAM_ACCESS_TOKEN.',
      'instagram_token_expired'
    );
  }

  if (isRateLimited(status, body)) {
    throw createInstagramError(
      429,
      'Instagram is rate-limiting requests right now. Wait a minute and try again.',
      'instagram_rate_limited'
    );
  }

  throw createInstagramError(
    502,
    sanitizeInstagramGraphMessage(body),
    'instagram_api_error'
  );
};

// ─── Normalization ─────────────────────────────────────────────────────────

const isHttpsUrl = (value: string): boolean => /^https:\/\//i.test(value);

const isInstagramPermalink = (value: string): boolean =>
  /^https:\/\/www\.instagram\.com\/(p|reel|tv)\//i.test(value);

const readOptionalUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed && isHttpsUrl(trimmed) ? trimmed : undefined;
};

const toInstagramMediaType = (value: unknown): InstagramMediaType | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const upper = value.toUpperCase();
  return (INSTAGRAM_MEDIA_TYPES as readonly string[]).includes(upper)
    ? (upper as InstagramMediaType)
    : null;
};

const toInstagramProductType = (value: unknown): InstagramProductType | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const upper = value.toUpperCase();
  return (INSTAGRAM_PRODUCT_TYPES as readonly string[]).includes(upper)
    ? (upper as InstagramProductType)
    : undefined;
};

/** A media row is feature-able when the homepage can actually play it. */
export const isFeatureableInstagramMedia = (media: {
  mediaType: InstagramMediaType;
  mediaProductType?: InstagramProductType;
} | null | undefined): boolean => {
  if (!media) {
    return false;
  }

  return media.mediaType === 'VIDEO' || media.mediaProductType === 'REELS';
};

const normalizeInstagramMediaRow = (raw: unknown): InstagramMediaValue | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const mediaId = typeof item.id === 'string' ? item.id.trim() : '';
  const mediaType = toInstagramMediaType(item.media_type);

  // Rows the account cannot use (deleted post, exotic type) are skipped
  // silently — a sync must not fail the whole batch for one bad row.
  if (!mediaId || !mediaType) {
    return null;
  }

  // Videos only: the homepage showcase plays Reels. Photos and carousels are
  // dropped here so they are never stored, listed, or feature-able.
  if (mediaType !== 'VIDEO') {
    return null;
  }

  const permalink = readOptionalUrl(item.permalink);
  const caption =
    typeof item.caption === 'string'
      ? item.caption.slice(0, MAX_INSTAGRAM_CAPTION_LENGTH)
      : undefined;

  const timestampRaw = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
  const timestamp = Number.isFinite(timestampRaw) ? new Date(timestampRaw) : undefined;

  return {
    mediaId: mediaId.slice(0, 64),
    mediaType,
    mediaProductType: toInstagramProductType(item.media_product_type),
    permalink: permalink && isInstagramPermalink(permalink) ? permalink : undefined,
    caption,
    mediaUrl: readOptionalUrl(item.media_url),
    thumbnailUrl: readOptionalUrl(item.thumbnail_url),
    timestamp,
  };
};

// ─── Meta fetching ─────────────────────────────────────────────────────────

type InstagramPage = {
  items: InstagramMediaValue[];
  nextAfter?: string;
};

/**
 * One GET against the Graph API. All failure modes are mapped to a typed
 * `HttpError` (`instagram_token_expired` / `instagram_rate_limited` /
 * `instagram_api_error`) or a timeout, so the controller can respond without
 * ever leaking the token.
 */
export const fetchInstagramMediaPage = async (input: {
  limit?: number;
  after?: string;
}): Promise<InstagramPage> => {
  const credentials = readInstagramCredentials();

  if (!credentials) {
    throw createInstagramError(
      403,
      'Instagram integration is not configured on the server.',
      'instagram_not_configured'
    );
  }

  const limit = input.limit ?? INSTAGRAM_SYNC_DEFAULT_LIMIT;
  const fields = [
    'id',
    'caption',
    'media_type',
    'media_product_type',
    'media_url',
    'thumbnail_url',
    'permalink',
    'timestamp',
  ].join(',');

  const params = new URLSearchParams({
    fields,
    limit: String(limit),
    access_token: credentials.token,
  });

  if (input.after) {
    params.set('after', input.after);
  }

  // The token lives only inside this URL object; nothing about it is logged.
  const url = `${INSTAGRAM_GRAPH_BASE_URL}/${credentials.accountId}/media?${params.toString()}`;

  let response: Response;

  try {
    response = await fetch(url, { signal: AbortSignal.timeout(INSTAGRAM_FETCH_TIMEOUT_MS) });
  } catch {
    // Deliberately no error detail here: fetch/undici failure messages can carry
    // fragments of the request, and the URL contains the access token.
    throw createInstagramError(
      504,
      'Instagram did not answer in time. Try again in a moment.',
      'instagram_timeout'
    );
  }

  type InstagramGraphPage = InstagramGraphErrorBody & {
    data?: unknown[];
    paging?: { cursors?: { after?: string; before?: string } };
  };

  let body: InstagramGraphPage | null = null;

  try {
    body = (await response.json()) as InstagramGraphPage;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw mapInstagramGraphError(response.status, body);
  }

  const rows = Array.isArray(body?.data) ? body.data : [];
  const items = rows
    .map(normalizeInstagramMediaRow)
    .filter((item): item is InstagramMediaValue => item !== null)
    .map((item) => ({ ...item, accountId: credentials.accountId }));

  const nextAfter = body?.paging?.cursors?.after?.slice(0, 500) || undefined;

  return { items, nextAfter };
};

// ─── Expiring media URLs ───────────────────────────────────────────────────
//
// `media_url`, `thumbnail_url` and `permalink` come back as SIGNED links on
// Meta's CDN and stop working after a few days (the `oe` query parameter is the
// expiry, in hex seconds). A row synced on Monday therefore 403s by Friday: the
// storefront then shows a broken poster and the inline player cannot load.
//
// So the URLs are treated as a CACHE with a lifetime, not as permanent data.
// The read paths below refresh the rows they are about to serve once the cached
// copy is older than `META_MEDIA_URL_TTL_MS`, rate-limited by a DB-backed
// cooldown so storefront traffic cannot turn into Graph API traffic. Every step
// is best-effort: if Meta is unavailable the stored URLs are served unchanged,
// which is strictly better than failing the feed.

/** Cached URLs older than this are re-fetched before they are served. */
const META_MEDIA_URL_TTL_MS = 24 * 60 * 60 * 1000;

/** At most one refresh attempt per window, across all serverless instances. */
const META_URL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/** Refresh is on the request path, so it gets a shorter budget than a sync. */
const META_URL_REFRESH_TIMEOUT_MS = 4000;

/** Bounded so one read can never fan out into an unbounded number of calls. */
const MAX_URL_REFRESH_PER_READ = 10;

const isMediaUrlStale = (doc: IInstagramMediaDocument): boolean => {
  const refreshedAt = doc.updatedAt ? doc.updatedAt.getTime() : 0;
  return Date.now() - refreshedAt > META_MEDIA_URL_TTL_MS;
};

/**
 * Re-reads ONE media item to obtain fresh URLs.
 *
 * Returns null on anything unexpected — a refresh must never surface an error to
 * a storefront visitor, and the URL (which carries the token) is never logged.
 */
const fetchInstagramMediaById = async (mediaId: string): Promise<InstagramMediaValue | null> => {
  const credentials = readInstagramCredentials();

  if (!credentials) {
    return null;
  }

  const params = new URLSearchParams({
    fields: [
      'id',
      'caption',
      'media_type',
      'media_product_type',
      'media_url',
      'thumbnail_url',
      'permalink',
      'timestamp',
    ].join(','),
    access_token: credentials.token,
  });

  try {
    const response = await fetch(
      `${INSTAGRAM_GRAPH_BASE_URL}/${encodeURIComponent(mediaId)}?${params.toString()}`,
      { signal: AbortSignal.timeout(META_URL_REFRESH_TIMEOUT_MS) }
    );

    if (!response.ok) {
      return null;
    }

    const item = normalizeInstagramMediaRow(await response.json());

    return item ? { ...item, accountId: credentials.accountId } : null;
  } catch {
    return null;
  }
};

/**
 * Claims the refresh window. The settings singleton already exists (every read
 * upserts it), so this is a plain conditional update — an `upsert` here would
 * race on the unique `singletonKey` when the cooldown is still active.
 */
const claimUrlRefreshWindow = async (): Promise<boolean> => {
  const cutoff = new Date(Date.now() - META_URL_REFRESH_COOLDOWN_MS);

  const claimed = await InstagramSettings.findOneAndUpdate(
    {
      singletonKey: 'instagram_feed',
      $or: [
        { lastUrlRefreshAt: { $exists: false } },
        { lastUrlRefreshAt: null },
        { lastUrlRefreshAt: { $lte: cutoff } },
      ],
    },
    { $set: { lastUrlRefreshAt: new Date() } },
    { returnDocument: 'after' }
  )
    .lean()
    .exec();

  return claimed !== null;
};

/**
 * Refreshes the URLs of the given rows when they are stale.
 *
 * Returns true when at least one row was updated, so the caller knows to re-read
 * what it is about to serve.
 */
const refreshStaleInstagramUrls = async (
  docs: IInstagramMediaDocument[]
): Promise<boolean> => {
  const stale = docs.filter(isMediaUrlStale).slice(0, MAX_URL_REFRESH_PER_READ);

  if (stale.length === 0 || !hasInstagramCredentials()) {
    return false;
  }

  if (!(await claimUrlRefreshWindow())) {
    return false;
  }

  const refreshed = await Promise.all(
    stale.map(async (doc) => ({ doc, item: await fetchInstagramMediaById(doc.mediaId) }))
  );

  const updates = refreshed
    .filter((entry): entry is { doc: IInstagramMediaDocument; item: InstagramMediaValue } =>
      entry.item !== null
    )
    // A response with no URLs would only bump `updatedAt` and postpone the next
    // real attempt by a full TTL, so it is treated as "nothing to refresh".
    .filter(({ item }) => Boolean(item.mediaUrl || item.thumbnailUrl));

  if (updates.length === 0) {
    return false;
  }

  await InstagramMedia.bulkWrite(
    updates.map(({ doc, item }) => ({
      updateOne: {
        filter: { mediaId: doc.mediaId },
        update: {
          $set: {
            permalink: item.permalink,
            caption: item.caption,
            mediaUrl: item.mediaUrl,
            thumbnailUrl: item.thumbnailUrl,
            mediaProductType: item.mediaProductType,
            timestamp: item.timestamp,
          },
        },
      },
    })),
    { ordered: false }
  );

  return true;
};

// ─── Sync (admin-only) ─────────────────────────────────────────────────────

export type InstagramSyncResult = {
  totalFetched: number;
  newCount: number;
  refreshedCount: number;
  nextAfter?: string;
};

/**
 * Pulls one page from the Graph API and upserts it into MongoDB.
 *
 * Upsert key = Instagram media id, so repeated syncs refresh metadata instead
 * of duplicating rows. The featured selection is never read or written here —
 * syncing new posts never changes what the homepage shows.
 */
export const syncInstagramMedia = async (input: {
  limit?: number;
  after?: string;
}): Promise<InstagramSyncResult> => {
  const page = await fetchInstagramMediaPage(input);

  let newCount = 0;
  let refreshedCount = 0;

  if (page.items.length > 0) {
    const result = await InstagramMedia.bulkWrite(
      page.items.map((item) => ({
        updateOne: {
          filter: { mediaId: item.mediaId },
          update: {
            $set: {
              accountId: item.accountId,
              permalink: item.permalink,
              caption: item.caption,
              mediaType: item.mediaType,
              mediaProductType: item.mediaProductType,
              mediaUrl: item.mediaUrl,
              thumbnailUrl: item.thumbnailUrl,
              timestamp: item.timestamp,
            },
            $setOnInsert: { mediaId: item.mediaId },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    newCount = result.upsertedCount ?? 0;
    refreshedCount = result.modifiedCount ?? 0;
  }

  await InstagramSettings.findOneAndUpdate(
    { singletonKey: 'instagram_feed' },
    { $set: { lastSyncAt: new Date() }, $setOnInsert: DEFAULT_INSTAGRAM_SETTINGS },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return {
    totalFetched: page.items.length,
    newCount,
    refreshedCount,
    nextAfter: page.nextAfter,
  };
};

// ─── Settings singleton ────────────────────────────────────────────────────

export const getInstagramSettings = async (): Promise<InstagramSettingsValue> => {
  const settings = await InstagramSettings.findOneAndUpdate(
    { singletonKey: 'instagram_feed' },
    { $setOnInsert: DEFAULT_INSTAGRAM_SETTINGS },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  return {
    singletonKey: 'instagram_feed',
    featuredMediaIds: settings?.featuredMediaIds?.slice() ?? [],
    lastSyncAt: settings?.lastSyncAt ?? null,
  };
};

// ─── Serialization ─────────────────────────────────────────────────────────

export type SerializedInstagramMedia = {
  mediaId: string;
  permalink?: string;
  caption?: string;
  mediaType: InstagramMediaType;
  mediaProductType?: InstagramProductType;
  mediaUrl?: string;
  thumbnailUrl?: string;
  timestamp?: string;
  featured: boolean;
  syncedAt?: string;
};

const serializeMediaDoc = (
  doc: IInstagramMediaDocument,
  featuredMediaIds: Set<string>
): SerializedInstagramMedia => ({
  mediaId: doc.mediaId,
  permalink: doc.permalink,
  caption: doc.caption,
  mediaType: doc.mediaType,
  mediaProductType: doc.mediaProductType,
  mediaUrl: doc.mediaUrl,
  thumbnailUrl: doc.thumbnailUrl,
  timestamp: doc.timestamp ? doc.timestamp.toISOString() : undefined,
  featured: featuredMediaIds.has(doc.mediaId),
  syncedAt: doc.updatedAt ? doc.updatedAt.toISOString() : undefined,
});

/** Admin list: every synced row, newest first, with the featured flags applied. */
export const getInstagramMediaForAdmin = async (): Promise<SerializedInstagramMedia[]> => {
  const settings = await getInstagramSettings();

  let docs = await getSyncedMediaDocs();

  if (await refreshStaleInstagramUrls(docs)) {
    docs = await getSyncedMediaDocs();
  }

  const featuredMediaIds = new Set(settings.featuredMediaIds);

  return docs.map((doc) => serializeMediaDoc(doc, featuredMediaIds));
};

const getSyncedMediaDocs = async (): Promise<IInstagramMediaDocument[]> => {
  const docs = await InstagramMedia.find({ mediaType: 'VIDEO' })
    .sort({ timestamp: -1, mediaId: -1 })
    .lean()
    .exec();

  return docs as unknown as IInstagramMediaDocument[];
};

// ─── Selection (admin-only) ────────────────────────────────────────────────

export type InstagramSelectionResult = {
  featuredMediaIds: string[];
  featuredMedia: SerializedInstagramMedia[];
  eligibleReelCount: number;
};

/**
 * Validates and stores the admin's ordered selection.
 *
 * Rules enforced here (the hard ones):
 *  - at most `MAX_FEATURED_INSTAGRAM_VIDEOS` ids (already capped by the schema);
 *  - every id must be a synced media row — unknown ids are refused;
 *  - every id must be a playable video/reel — photos cannot be featured.
 *
 * The soft minimum of `MIN_FEATURED_INSTAGRAM_VIDEOS` is NOT enforced: when the
 * connected account has fewer eligible reels than that, the admin UI shows a
 * helpful message instead of being blocked from saving anything.
 */
export const updateInstagramSelection = async (
  payload: InstagramSelectionInput
): Promise<InstagramSelectionResult> => {
  const rawIds = (payload.featuredMediaIds ?? []).map((id) => id.trim()).filter(Boolean);

  const featuredMediaIds = Array.from(new Set(rawIds));

  if (featuredMediaIds.length > MAX_FEATURED_INSTAGRAM_VIDEOS) {
    throw createInstagramError(
      400,
      `At most ${MAX_FEATURED_INSTAGRAM_VIDEOS} Reels can be featured on the homepage`,
      'too_many_featured_instagram_videos'
    );
  }

  const docs = await getSyncedMediaDocs();

  const byMediaId = new Map(docs.map((doc) => [doc.mediaId, doc]));

  for (const mediaId of featuredMediaIds) {
    const doc = byMediaId.get(mediaId);

    if (!doc) {
      throw createInstagramError(
        400,
        'One or more selected Reels are no longer in the synced library. Sync again and retry.',
        'unknown_instagram_media'
      );
    }

    if (!isFeatureableInstagramMedia(doc)) {
      throw createInstagramError(
        400,
        'Only Reels (videos) can be featured on the homepage. Photos cannot be featured.',
        'instagram_media_not_featureable'
      );
    }
  }

  const updated = await InstagramSettings.findOneAndUpdate(
    { singletonKey: 'instagram_feed' },
    { $set: { featuredMediaIds }, $setOnInsert: { singletonKey: 'instagram_feed' } },
    { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  const storedIds: string[] =
    (updated?.featuredMediaIds as string[] | undefined)?.slice() ?? featuredMediaIds;
  const featuredSet = new Set(storedIds);

  const featuredMedia = storedIds
    .map((mediaId) => byMediaId.get(mediaId))
    .filter((doc): doc is IInstagramMediaDocument => Boolean(doc))
    .map((doc) => serializeMediaDoc(doc, featuredSet));

  const eligibleReelCount = docs.filter((doc) => isFeatureableInstagramMedia(doc)).length;

  return { featuredMediaIds: storedIds, featuredMedia, eligibleReelCount };
};

// ─── Storefront payload ────────────────────────────────────────────────────

export type StorefrontInstagramVideo = {
  id: string;
  permalink?: string;
  caption?: string;
  thumbnailUrl?: string;
  mediaUrl?: string;
  timestamp?: string;
};

/**
 * Public payload: only the featured items, in the saved order, and only the
 * fields the storefront renders. Rows that were deleted from the DB (or are no
 * longer videos) are skipped rather than surfacing as broken players.
 *
 * Only the featured rows are refreshed, because those are the only rows this
 * payload can contain — a visitor must never trigger a refresh of the whole
 * library.
 */
export const getInstagramFeedForStorefront = async (): Promise<StorefrontInstagramVideo[]> => {
  const settings = await getInstagramSettings();

  const pickFeatured = (
    docs: IInstagramMediaDocument[]
  ): IInstagramMediaDocument[] => {
    const byMediaId = new Map(docs.map((doc) => [doc.mediaId, doc]));

    return settings.featuredMediaIds
      .map((mediaId) => byMediaId.get(mediaId))
      .filter(
        (doc): doc is IInstagramMediaDocument =>
          Boolean(doc) && isFeatureableInstagramMedia(doc)
      );
  };

  let featured = pickFeatured(await getSyncedMediaDocs());

  if (await refreshStaleInstagramUrls(featured)) {
    featured = pickFeatured(await getSyncedMediaDocs());
  }

  return featured.map((doc) => ({
    id: doc.mediaId,
    permalink: doc.permalink,
    caption: doc.caption,
    thumbnailUrl: doc.thumbnailUrl,
    mediaUrl: doc.mediaUrl,
    timestamp: doc.timestamp ? doc.timestamp.toISOString() : undefined,
  }));
};
