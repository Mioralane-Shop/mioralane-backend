import { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { sanitizeErrorMessage } from './error.middleware';

/**
 * The one multipart upload pipeline (P1.2, closing G6).
 *
 * Before this, `media.routes.ts` and `imagekit.module.ts` each carried their own
 * copy of the same four things — `multer({ storage: memoryStorage(), limits,
 * fileFilter })`, the `MulterError` → status mapping, the `sanitizeErrorMessage`
 * fallback, and the `upload.single('file')` call. They differed only in the size
 * limit and its message, which is exactly the kind of difference that is easiest
 * to get wrong later: a fix applied to one copy would silently miss the other.
 *
 * Callers now pass what genuinely differs and share everything else.
 *
 * ## The `fileFilter` accepts everything on purpose
 *
 * It is not a weakened check — it is not a check at all, and it cannot be one.
 * With `memoryStorage()` multer calls `fileFilter` **before** the body is read,
 * so at that point there is no buffer to inspect and `file.mimetype` is just the
 * client's claim. Content is decided in `upload-validator.middleware.ts`, on the
 * bytes, after multer has them. It stays explicit (rather than being deleted) so
 * the next reader sees that accepting everything here is deliberate.
 */

/**
 * The multipart field name. Both routes use `file`, and the admin client sends
 * it that way (`formData.append("file", file)` in `services/media.service.ts`).
 */
export const MULTIPART_FILE_FIELD = 'file';

/** The subset of multer's file object this codebase reads. */
export type UploadedFile = {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
};

export type SingleFileUploadOptions = {
    /** Ceiling passed straight to multer's `limits.fileSize`. */
    maxBytes: number;
    /**
     * Exact 413 message. Route-specific and passed in rather than generated, so
     * each route keeps the wording it has always returned (`'8MB'` on the media
     * route, `'temporary 5MB'` on the dev-only test route).
     */
    tooLargeMessage: string;
};

/**
 * Returns the request handler that runs multer and normalises its errors.
 *
 * Without this mapping a `MulterError` would reach the terminal error handler,
 * which answers a generic 400/413 — so the size breach would lose its specific
 * message. `sanitizeErrorMessage` guards the fallback: a file-system or
 * body-parser error must not leak its internal wording.
 */
export const createSingleFileUpload = (options: SingleFileUploadOptions): RequestHandler => {
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: options.maxBytes,
        },
        // See the module header: this runs before the body exists, so it accepts
        // everything and the bytes are judged later.
        fileFilter: (
            _req: Request,
            _file: unknown,
            callback: (error: Error | null, acceptFile?: boolean) => void
        ) => {
            callback(null, true);
        },
    });

    return (req: Request, res: Response, next: NextFunction): void => {
        const onUploadComplete: NextFunction = (error) => {
            if (!error) {
                next();
                return;
            }

            const uploadError = error as Error & { code?: string };

            if (uploadError instanceof multer.MulterError) {
                if (uploadError.code === 'LIMIT_FILE_SIZE') {
                    res.status(413).json({
                        success: false,
                        message: options.tooLargeMessage,
                    });
                    return;
                }

                res.status(400).json({
                    success: false,
                    message: uploadError.message,
                });
                return;
            }

            const message = sanitizeErrorMessage(uploadError, 'Invalid upload request');
            res.status(400).json({
                success: false,
                message,
            });
        };

        upload.single(MULTIPART_FILE_FIELD)(req, res, onUploadComplete);
    };
};
