import { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UploadedFile } from './multipart-upload';
import {
    detectBrandLogoMimeType,
    detectImageMimeType,
    isAllowedImageMimeType,
    isAllowedImageMimeTypeForAssetType,
    type BrandLogoMimeType,
} from '../media/image-upload-policy';

/**
 * The upload content guard (P1.2).
 *
 * Mounted after {@link createSingleFileUpload} and before the controller, so the
 * decision about *what may be uploaded* belongs to the route rather than to a
 * service method that each new route has to remember to call. That is the same
 * reasoning as `adminGuard` (P0-2): a control that lives in a helper is a control
 * a future route can skip.
 *
 * The detected type is written onto the request, and the controllers read it from
 * there instead of re-detecting. Two consequences worth stating, because both are
 * deliberate:
 *
 *   1. **One detection, one decision.** The type that gets validated is the same
 *      value that names the stored file, so the check and the outcome cannot
 *      disagree.
 *   2. **A route that forgets this middleware fails closed.** The controllers
 *      answer 400 when the type is absent, so a forgotten mount produces a
 *      refused upload — never an unchecked one.
 *
 * Size is *not* checked here: `limits.fileSize` in {@link createSingleFileUpload}
 * is the authority, and it aborts the request before the body is buffered. The
 * controllers retain their post-hoc byte-size assertion as the existing second
 * layer.
 *
 * ## Asset-type branching (brand-logo SVG)
 *
 * `brand-logo` is the one asset type allowed to store SVG, so the decision is a
 * function of `req.body.assetType`. It is read here rather than passed as a
 * parameter, because multer has already parsed the body by the time this runs and
 * a parameter is one more thing a route can forget.
 *
 * The branch **fails closed**: only the exact string `'brand-logo'` selects the
 * wider predicate, so a request that omits, mistypes or invents an `assetType` is
 * judged by the strict product/combo/campaign rule and can never reach the SVG
 * branch by leaving a field out.
 */

/** Shared wording. The media route has returned this exact sentence since before P1.2. */
export const UNSUPPORTED_IMAGE_MESSAGE = 'Only JPEG, PNG, and WebP images are allowed';

/**
 * The same rejection for a `brand-logo` upload, which additionally accepts SVG.
 *
 * A separate sentence rather than a widened one: the product/combo/campaign
 * wording is asserted verbatim by `tests/verify-file-upload.ts`, and it is what
 * the admin UI promises — a brand logo is the only place an SVG is ever on
 * offer, so only that path gets the longer list.
 */
export const UNSUPPORTED_BRAND_LOGO_MESSAGE = 'Only JPEG, PNG, WebP, and SVG images are allowed';

export const MISSING_IMAGE_MESSAGE = 'file is required';

export const EMPTY_IMAGE_MESSAGE = 'Invalid or empty upload';

/** Request carrying what the guard decided. */
export type ImageUploadRequest = Request & {
    file?: UploadedFile;
    /** Narrow to `SupportedImageMimeType` unless the route declared `brand-logo`. */
    imageMimeType?: BrandLogoMimeType;
};

/** The parsed upload, if multer produced one. */
export const readUploadedFile = (req: Request): UploadedFile | undefined =>
    (req as ImageUploadRequest).file;

/**
 * The type the guard established. `undefined` means the guard did not run (or the
 * file was rejected), which callers must treat as "refuse", never as "allow".
 */
export const readImageMimeType = (req: Request): BrandLogoMimeType | undefined =>
    (req as ImageUploadRequest).imageMimeType;

/**
 * The asset type the route declared, read from the already-parsed body.
 *
 * Typed `unknown` on purpose: this is an unchecked value on its way to a
 * comparison, and narrowing it to `MediaAssetType` before checking would be an
 * assertion the compiler cannot back.
 */
const readAssetType = (req: Request): unknown =>
    (req.body as { assetType?: unknown } | null | undefined)?.assetType;

/**
 * Rejects an upload whose bytes are not an accepted image format.
 *
 * Order matters and mirrors the previous controller logic exactly: missing file,
 * then empty file, then content. Each keeps its existing status and wording.
 */
export const requireImageUpload = (): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const file = readUploadedFile(req);

        if (!file) {
            res.status(400).json({
                success: false,
                message: MISSING_IMAGE_MESSAGE,
            });
            return;
        }

        const byteLength = file.buffer?.length ?? 0;

        if (byteLength <= 0) {
            res.status(400).json({
                success: false,
                message: EMPTY_IMAGE_MESSAGE,
            });
            return;
        }

        // Fail closed. Only the exact string widens the rule; everything else —
        // absent, misspelled, a different asset type — keeps the strict pair.
        const isBrandLogo = readAssetType(req) === 'brand-logo';

        const detectedMimeType = isBrandLogo
            ? detectBrandLogoMimeType(file.buffer)
            : detectImageMimeType(file.buffer);

        // Belt and braces: detection already implies membership today, but the
        // allowlist is the rule and the sniffer is the implementation. Checking
        // both means widening the sniffer — as it once was, for GIF — cannot by
        // itself widen what is accepted.
        const allowed = isBrandLogo
            ? isAllowedImageMimeTypeForAssetType(detectedMimeType, 'brand-logo')
            : isAllowedImageMimeType(detectedMimeType);

        if (detectedMimeType === null || !allowed) {
            // The declared `file.mimetype` is deliberately not consulted: it is a
            // client claim, and the stored extension is derived from these bytes.
            res.status(400).json({
                success: false,
                message: isBrandLogo ? UNSUPPORTED_BRAND_LOGO_MESSAGE : UNSUPPORTED_IMAGE_MESSAGE,
            });
            return;
        }

        (req as ImageUploadRequest).imageMimeType = detectedMimeType;
        next();
    };
};
