import crypto from 'crypto';
import path from 'path';
import type { MediaAssetType } from './media.types';

/**
 * The image upload policy, in one place (P1.2).
 *
 * Every rule about what may be uploaded and what it may be called lives here, so
 * the guard that rejects a file, the name builder that stores it, and the
 * provider-side check that backs them up cannot disagree with each other. Before
 * this module the sniffer lived on `ImageKitService` (whose constructor throws
 * unless three ImageKit env vars are set, which made it awkward to reach from a
 * middleware or a test), and the 8MB limit was declared twice.
 *
 * The module deliberately imports **only Node builtins** (`crypto`, `path`) — no
 * ImageKit client, no env, no Express — so it can be unit-tested and used as
 * middleware without a network, a database or credentials.
 *
 * ## Why the allowlist is three formats, not four
 *
 * The sniffer can recognise GIF, but `POST /api/media/images` has always
 * answered `'Only JPEG, PNG, and WebP images are allowed'` — so accepting a GIF
 * meant the message contradicted the behaviour, and the behaviour contradicted
 * the admin UI (which only ever offers those three: `lib/image-optimizer.ts`
 * sniffs magic bytes client-side and `accept="image/jpeg,image/png,image/webp"`
 * on the inputs). P1.2 aligned the behaviour to the message rather than the
 * message to the behaviour, so a GIF is now refused. GIF detection was deleted
 * rather than merely unlisted: an unreachable branch is a branch nobody
 * maintains.
 *
 * ## What this is not
 *
 * A signature check is not a decoder. These functions read the leading bytes, so
 * a truncated or corrupt file whose header is correct passes here and is
 * decoded — or rejected — by ImageKit, which is the component that actually
 * understands the format. This module's job is to make sure the bytes are a
 * format we intend to store, not to prove they are a valid image.
 */

/** Formats the API accepts. A GIF or SVG is deliberately not a member. */
export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Single source of truth for "may this be stored". Typed so the array cannot be
 * widened without the type changing too.
 */
export const MEDIA_IMAGE_MIME_ALLOWLIST: readonly SupportedImageMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

/**
 * Extension per accepted format. The extension written to ImageKit always comes
 * from here — never from the uploaded file's name — so `file.jpg.php` cannot
 * produce a `.php`, and a WebP sent as `photo.jpg` is stored as `.webp`.
 */
export const MIME_TO_EXTENSION: Record<SupportedImageMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Ceiling for `POST /api/media/images`. Enforced by multer and re-checked by the controller. */
export const MAX_MEDIA_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

/** PNG: the full 8-byte signature, so a partial match cannot pass. */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const detectImageMimeType = (buffer: Buffer): SupportedImageMimeType | null => {
  if (buffer.length >= PNG_SIGNATURE.length) {
    const isPng = PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);

    if (isPng) {
      return 'image/png';
    }
  }

  // JPEG has no fixed header length; the start-of-image marker is the check.
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP is a RIFF container: 'RIFF' <4-byte size> 'WEBP'.
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
};

/** Narrowing helper for a value that came from somewhere unchecked. */
export const isAllowedImageMimeType = (value: unknown): value is SupportedImageMimeType =>
  typeof value === 'string' && (MEDIA_IMAGE_MIME_ALLOWLIST as readonly string[]).includes(value);

/**
 * Longest base name kept. `prefix` + base + `-<13>-<36>` + extension must stay
 * comfortably inside ImageKit's documented `fileName` character rules, and a
 * client-supplied name should not inflate the stored key.
 */
const MAX_BASE_NAME_LENGTH = 100;

/**
 * Reduces a name to what ImageKit's `fileName` field accepts (`a-z`, `A-Z`,
 * `0-9`, `.`, `-` — anything else is replaced by `_` on their side). Doing it
 * here means the stored name is what we chose, not what they fixed up for us.
 *
 * This function does **not** remove path traversal on its own — that is
 * `path.parse()` in {@link buildImageFileName}, which discards every directory
 * component before this runs. A separator reaching here becomes a `-`
 * (`../../../etc/passwd` -> its last segment by the time it arrives).
 *
 * The leading-dot strip matters: a name like `..` would otherwise survive as
 * dots and produce a hidden or ambiguous file name. The cap is applied before
 * the trailing strip for the same reason — truncating can leave a separator
 * dangling, so the name can never end in `.` or `-`.
 */
export const sanitizeImageBaseName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .slice(0, MAX_BASE_NAME_LENGTH)
    .replace(/[.-]+$/, '');

  return normalized || 'image';
};

/**
 * Builds the stored file name: `prefix-<sanitized base>-<unique><ext>`.
 *
 * `path.parse(...).name` discards every directory component, so a traversal
 * attempt cannot survive, and the extension comes from the **detected** type.
 * The `Date.now()`-`randomUUID()` suffix compensates for the uploads being sent
 * with `useUniqueFileName: false` — without it two files named `photo.jpg` would
 * silently replace each other.
 */
export const buildImageFileName = (
  prefix: string,
  originalname: string,
  mimeType: BrandLogoMimeType,
  assetType: MediaAssetType
): string => {
  const parsedName = path.parse(originalname).name;
  const safeBaseName = sanitizeImageBaseName(parsedName);
  const extension = extensionForAssetType(mimeType, assetType);
  const uniqueSuffix = `${Date.now()}-${crypto.randomUUID()}`;

  return `${prefix}-${safeBaseName}-${uniqueSuffix}${extension}`;
};

/**
 * ── Brand logos: the ONE asset type that may store SVG ────────────────────────
 *
 * A brand logo is a vector wordmark — the six in `mioralane-frontend/public/brands`
 * are SVGs — so rasterising them would be a visible quality regression.
 * `brand-logo` is therefore the only asset type allowed to store `image/svg+xml`.
 *
 * The global allowlist above is deliberately NOT widened, and neither are
 * `SupportedImageMimeType` / `MIME_TO_EXTENSION` (which the whole upload pipeline
 * is typed against): `tests/verify-file-upload.ts` asserts the
 * product/combo/campaign allowlist is exactly JPEG, PNG and WebP, and an SVG sent
 * as a product is still refused. Everything brand-logo-specific lives in this
 * block, so the answer is a function of `assetType` rather than a loosened rule.
 *
 * ## Why SVG also needs a content check
 *
 * Inside `<img src>` an SVG is a static image — browsers do not run its scripts.
 * The stored file is also reachable by **direct navigation**, and a top-level SVG
 * document *does* execute its scripts, so an uploaded logo would be stored XSS on
 * our own CDN origin. Refusing script-bearing markup costs nothing legitimate
 * (Illustrator and Figma exports contain none), so this refuses rather than tries
 * to sanitise. `AssetType` is threaded in as a type-only import: this module stays
 * runtime-dependency-free, as its header promises.
 */
export type BrandLogoMimeType = SupportedImageMimeType | 'image/svg+xml';

/** `brand-logo` accepts the global three plus SVG. */
export const BRAND_LOGO_MIME_ALLOWLIST: readonly BrandLogoMimeType[] = [
  ...MEDIA_IMAGE_MIME_ALLOWLIST,
  'image/svg+xml',
];

/** Extension per format, for brand logos only. Separated so `MIME_TO_EXTENSION` stays SVG-free. */
export const BRAND_LOGO_MIME_TO_EXTENSION: Record<BrandLogoMimeType, string> = {
  ...MIME_TO_EXTENSION,
  'image/svg+xml': '.svg',
};

/**
 * An SVG document's root element, allowing the optional prolog an exporter writes
 * before it (BOM, XML declaration, comments, doctype). Matched against the first
 * few hundred bytes, which is all a signature sniff needs.
 */
const SVG_ROOT_ELEMENT = /^(?:\uFEFF)?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?<svg[\s>]/i;

/** Markup that must never be stored, however it is later rendered. */
const SVG_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /<script/i,
  /<foreignobject/i,
  /on\w+\s*=/i,
  /javascript:/i,
];

/** The single message the controller returns for a refused SVG body. */
export const SVG_SANITIZE_REJECTION_MESSAGE = 'SVG contains scripts or event handlers';

/**
 * `true` when the SVG body is free of scripts and event handlers.
 *
 * A rejection, not a rewrite: editing markup to remove a vector is how a
 * sanitiser gets bypassed, and there is no legitimate export to preserve.
 */
export const sanitizeSvgContent = (bytes: Buffer): boolean => {
  const source = bytes.toString('utf8');

  return !SVG_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(source));
};

/**
 * Brand-logo sniffer: the raster signatures first, then SVG.
 *
 * Deliberately a separate function rather than a widening of
 * `detectImageMimeType`, so a product upload cannot accidentally reach the SVG
 * branch.
 */
export const detectBrandLogoMimeType = (buffer: Buffer): BrandLogoMimeType | null => {
  const raster = detectImageMimeType(buffer);

  if (raster) {
    return raster;
  }

  // latin1 so a stray high byte can neither throw nor mis-align the match.
  return SVG_ROOT_ELEMENT.test(buffer.toString('latin1', 0, 512)) ? 'image/svg+xml' : null;
};

/** MIME allowlist as a function of the asset type — the middleware's decision. */
export const isAllowedImageMimeTypeForAssetType = (
  value: unknown,
  assetType: MediaAssetType
): value is BrandLogoMimeType => {
  if (typeof value !== 'string') {
    return false;
  }

  return (
    assetType === 'brand-logo'
      ? (BRAND_LOGO_MIME_ALLOWLIST as readonly string[]).includes(value)
      : (MEDIA_IMAGE_MIME_ALLOWLIST as readonly string[]).includes(value)
  );
};

/**
 * The stored extension for a detected type, as a function of the asset type.
 *
 * Exists because `MIME_TO_EXTENSION` alone is not enough once SVG is reachable:
 * `image/svg+xml` is absent from it, so looking an SVG up there yields
 * `undefined` and the stored file name would lose its extension entirely. That
 * was a real latent bug in the first cut of the brand-logo path, caught while
 * wiring it rather than in production.
 *
 * The fallback is only a safety net: an SVG can only reach here with
 * `assetType === 'brand-logo'`, because the upload guard refuses it for every
 * other asset type.
 */
export const extensionForAssetType = (
  mimeType: BrandLogoMimeType | SupportedImageMimeType,
  assetType: MediaAssetType
): string => {
  if (assetType === 'brand-logo' && mimeType in BRAND_LOGO_MIME_TO_EXTENSION) {
    return BRAND_LOGO_MIME_TO_EXTENSION[mimeType as BrandLogoMimeType];
  }

  return (
    MIME_TO_EXTENSION[mimeType as SupportedImageMimeType] ??
    BRAND_LOGO_MIME_TO_EXTENSION[mimeType as BrandLogoMimeType]
  );
};
