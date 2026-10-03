import { z } from 'zod';
import type { MediaAssetType } from './media.types';
import { safeUrlSchema } from '../utils/validation';

/**
 * Runtime counterpart of `MediaAssetType` (`media.types.ts`). `satisfies` turns a
 * typo here into a compile error and makes it obvious when `MediaAssetType` gains a
 * member (e.g. the currently-disabled `'review'`) without this list being updated.
 *
 * NOTE: this file is `media-upload.schemas.ts`; the Mongoose asset subdocument lives
 * in `media.schema.ts`. It was renamed from `media.schemas.ts` (P0-3.8 follow-up) so
 * the two file names are no longer one letter apart.
 */
export const MEDIA_ASSET_TYPES = [
    'product',
    'combo',
    'campaign',
] as const satisfies readonly MediaAssetType[];

/**
 * One stored media asset, mirroring `MediaAsset` / `MediaAssetSchema`. Single
 * source of truth for every request body that carries a `media` array (products,
 * combos), so the shape cannot drift between modules.
 *
 * Every field is optional because the controllers run the array through
 * `normalizeMediaAssets()` (`media.schema.ts`), which discards non-objects and
 * entries without a string `url`, coerces every other field, and **rebuilds each
 * asset from scratch** — so no client-supplied key can reach a document. The shape
 * still has to be declared concretely (rather than `z.unknown()`) because
 * `Product.create()` / `Combo.set()` are typed against the model and would reject a
 * loosely typed body. Declaring the field at all is also what stops Zod from
 * stripping `media` and silently breaking image uploads.
 */
export const mediaAssetSchema = z.object({
    provider: z.literal('imagekit').optional(),
    fileId: z.string().nullable().optional(),
    url: safeUrlSchema().optional(),
    name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    alt: z.string().optional(),
    sortOrder: z.number().optional(),
});

/**
 * Body of `POST /api/media/images` (multipart). `assetType` is the only field a
 * client may influence; the file itself is handled by multer.
 *
 * ORDERING: `validate()` for this route MUST run AFTER `handleSingleUpload`.
 * Multer is what populates `req.body` for a multipart request, so a body check
 * placed before it would see `assetType === undefined` and reject every upload.
 *
 * The preprocess is a 1:1 port of the controller's former `parseAssetType`: a
 * string is trimmed and lower-cased before the enum check, and a non-string is
 * passed through so the enum rejects it. That preserves every value the endpoint
 * has always accepted (`'PRODUCT'`, `' combo '`, …) instead of silently narrowing
 * the contract. Tightening to a strict lower-case enum is a one-line change.
 *
 * Deliberately absent, so Zod's strip behaviour removes it from `req.body`:
 *  - `folder` / `fileName` / `fileNamePrefix`
 *      → the ImageKit destination comes from `MEDIA_FOLDER_BY_TYPE` and
 *        `MEDIA_FILENAME_PREFIX_BY_TYPE` in `imagekit.service.ts`; a client must
 *        never choose where its own file is written.
 *  - `isPrivate` / `useUniqueFileName` / `tags`
 *      → upload options are generated server-side per asset type.
 */
export const mediaUploadSchema = z.object({
    assetType: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        z.enum(MEDIA_ASSET_TYPES)
    ),
});

export type MediaUploadInput = z.infer<typeof mediaUploadSchema>;
