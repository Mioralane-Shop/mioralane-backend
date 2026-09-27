import { z } from 'zod';
import type { MediaAssetType } from './media.types';

/**
 * Runtime counterpart of `MediaAssetType` (`media.types.ts`). `satisfies` turns a
 * typo here into a compile error and makes it obvious when `MediaAssetType` gains a
 * member (e.g. the currently-disabled `'review'`) without this list being updated.
 *
 * NOTE: this file is `media.schemas.ts`; the Mongoose asset subdocument lives in
 * `media.schema.ts`. The names are one letter apart — check the path when importing.
 */
export const MEDIA_ASSET_TYPES = [
    'product',
    'combo',
    'campaign',
] as const satisfies readonly MediaAssetType[];

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
