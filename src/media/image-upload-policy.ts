import crypto from 'crypto';
import path from 'path';

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
  mimeType: SupportedImageMimeType
): string => {
  const parsedName = path.parse(originalname).name;
  const safeBaseName = sanitizeImageBaseName(parsedName);
  const extension = MIME_TO_EXTENSION[mimeType];
  const uniqueSuffix = `${Date.now()}-${crypto.randomUUID()}`;

  return `${prefix}-${safeBaseName}-${uniqueSuffix}${extension}`;
};
