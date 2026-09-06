import { Response, Request } from 'express';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ImageKitError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@imagekit/nodejs';
import { ImageKitService, UploadedImageFile, SupportedImageMimeType } from './imagekit.service';

type MulterFile = UploadedImageFile & {
  fieldname?: string;
  encoding?: string;
  destination?: string;
  filename?: string;
  path?: string;
};

const getStatusCode = (error: unknown): number => {
  if (error instanceof BadRequestError) return 400;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof PermissionDeniedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (error instanceof UnprocessableEntityError) return 422;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof InternalServerError) return 502;
  if (error instanceof APIConnectionTimeoutError) return 504;
  if (error instanceof APIConnectionError) return 502;
  if (error instanceof APIError && typeof error.status === 'number') {
    return error.status >= 500 ? 502 : error.status;
  }

  return 500;
};

const getSafeMessage = (error: unknown): string => {
  if (error instanceof ImageKitError) {
    return 'ImageKit upload failed';
  }

  return 'Internal server error';
};

export class ImageKitController {
  constructor(private readonly imageKitService: ImageKitService) {}

  /**
   * @deprecated Use POST /api/media/images instead.
   */
  async testUpload(req: Request, res: Response): Promise<void> {
    try {
      const file = (req as Request & { file?: MulterFile }).file;

      if (!file) {
        res.status(400).json({
          success: false,
          message: 'file is required',
        });
        return;
      }

      const actualByteSize = file.buffer?.length ?? file.size ?? 0;

      if (actualByteSize <= 0) {
        res.status(400).json({
          success: false,
          message: 'Invalid or empty upload',
        });
        return;
      }

      if (actualByteSize > 5 * 1024 * 1024) {
        res.status(413).json({
          success: false,
          message: 'File exceeds the temporary 5MB limit',
        });
        return;
      }

      const detectedMimeType = this.imageKitService.detectImageMimeType(file.buffer);

      if (process.env.NODE_ENV !== 'production') {
        console.log('[ImageKit test upload] file metadata:', {
          originalname: file.originalname,
          clientMimeType: file.mimetype,
          detectedMimeType: detectedMimeType ?? 'unknown',
          byteSize: actualByteSize,
        });
      }

      if (!detectedMimeType) {
        res.status(400).json({
          success: false,
          message: 'Only JPEG, PNG, WebP, and GIF images are allowed',
        });
        return;
      }

      const uploaded = await this.imageKitService.uploadTestImage(
        file,
        detectedMimeType as SupportedImageMimeType
      );

      res.status(201).json({
        success: true,
        data: {
          fileId: uploaded.fileId ?? null,
          name: uploaded.name ?? null,
          url: uploaded.url ?? null,
          thumbnailUrl: uploaded.thumbnailUrl ?? null,
        },
      });
    } catch (error) {
      console.error('ImageKit test upload failed:', error);

      res.status(getStatusCode(error)).json({
        success: false,
        message: getSafeMessage(error),
      });
    }
  }
}
