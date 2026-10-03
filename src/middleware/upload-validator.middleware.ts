import { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UploadedFile } from './multipart-upload';
import {
    detectImageMimeType,
    type SupportedImageMimeType,
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
 */

/** Shared wording. The media route has returned this exact sentence since before P1.2. */
export const UNSUPPORTED_IMAGE_MESSAGE = 'Only JPEG, PNG, and WebP images are allowed';

export const MISSING_IMAGE_MESSAGE = 'file is required';

export const EMPTY_IMAGE_MESSAGE = 'Invalid or empty upload';

/** Request carrying what the guard decided. */
export type ImageUploadRequest = Request & {
    file?: UploadedFile;
    imageMimeType?: SupportedImageMimeType;
};

/** The parsed upload, if multer produced one. */
export const readUploadedFile = (req: Request): UploadedFile | undefined =>
    (req as ImageUploadRequest).file;

/**
 * The type the guard established. `undefined` means the guard did not run (or the
 * file was rejected), which callers must treat as "refuse", never as "allow".
 */
export const readImageMimeType = (req: Request): SupportedImageMimeType | undefined =>
    (req as ImageUploadRequest).imageMimeType;

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

        const detectedMimeType = detectImageMimeType(file.buffer);

        if (detectedMimeType === null) {
            // The declared `file.mimetype` is deliberately not consulted: it is a
            // client claim, and the stored extension is derived from these bytes.
            res.status(400).json({
                success: false,
                message: UNSUPPORTED_IMAGE_MESSAGE,
            });
            return;
        }

        (req as ImageUploadRequest).imageMimeType = detectedMimeType;
        next();
    };
};
