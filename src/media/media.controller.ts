import { Request, Response } from 'express';
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
import { ImageKitService, SupportedImageMimeType } from '../imagekit/imagekit.service';
import { MediaAssetType } from './media.types';

type MulterFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

const MAX_MEDIA_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

const ALLOWED_ASSET_TYPES: MediaAssetType[] = ['product', 'combo', 'campaign'];

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

const parseAssetType = (value: unknown): MediaAssetType | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return ALLOWED_ASSET_TYPES.includes(normalized as MediaAssetType) ? (normalized as MediaAssetType) : null;
};

export class MediaController {
  constructor(private readonly imageKitService: ImageKitService) {}

  async uploadImage(req: Request, res: Response): Promise<void> {
    try {
      const file = (req as Request & { file?: MulterFile }).file;
      const assetType = parseAssetType(req.body?.assetType);

      if (!assetType) {
        res.status(400).json({
          success: false,
          message: 'assetType must be product, combo, or campaign',
        });
        return;
      }

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

      if (actualByteSize > MAX_MEDIA_UPLOAD_SIZE_BYTES) {
        res.status(413).json({
          success: false,
          message: 'File exceeds the 8MB upload limit',
        });
        return;
      }

      const detectedMimeType = this.imageKitService.detectImageMimeType(file.buffer);

      if (!detectedMimeType) {
        res.status(400).json({
          success: false,
          message: 'Only JPEG, PNG, and WebP images are allowed',
        });
        return;
      }

      const uploaded = await this.imageKitService.uploadMediaImage(
        {
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: actualByteSize,
        },
        detectedMimeType as SupportedImageMimeType,
        assetType
      );

      res.status(201).json({
        success: true,
        data: uploaded,
      });
    } catch (error) {
      console.error('Media image upload failed:', error);

      res.status(getStatusCode(error)).json({
        success: false,
        message: getSafeMessage(error),
      });
    }
  }

  async deleteImage(req: Request, res: Response): Promise<void> {
    try {
      const { fileId } = req.params as { fileId: string };
      const safeFileId = typeof fileId === 'string' ? fileId.trim() : '';

      if (!safeFileId) {
        res.status(400).json({
          success: false,
          message: 'fileId is required',
        });
        return;
      }

      await this.imageKitService.deleteMediaImage(safeFileId);

      res.status(200).json({
        success: true,
        message: 'Media image deleted successfully',
      });
    } catch (error) {
      console.error('Media image delete failed:', error);

      res.status(getStatusCode(error)).json({
        success: false,
        message: getSafeMessage(error),
      });
    }
  }
}
