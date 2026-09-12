import crypto from 'crypto';
import path from 'path';
import ImageKit, { toFile } from '@imagekit/nodejs';
import type { MediaAssetType, MediaUploadResponseData } from '../media/media.types';

export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface UploadedImageFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface ImageKitConfig {
  urlEndpoint: string;
  publicKey: string;
  privateKey: string;
}

const TEST_FOLDER = '/mioralane/test';
const DEFAULT_FILENAME_PREFIX = 'mioralane-test';
const MEDIA_FOLDER_BY_TYPE: Record<MediaAssetType, string> = {
  product: '/mioralane/products',
  combo: '/mioralane/combos',
  campaign: '/mioralane/campaigns',
};
const MEDIA_FILENAME_PREFIX_BY_TYPE: Record<MediaAssetType, string> = {
  product: 'mioralane-product',
  combo: 'mioralane-combo',
  campaign: 'mioralane-campaign',
};
const MIME_TO_EXTENSION: Record<SupportedImageMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

const sanitizeBaseName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return normalized || 'image';
};

export class ImageKitService {
  private readonly client: ImageKit;

  readonly config: ImageKitConfig;

  constructor() {
    const urlEndpoint = (process.env.IMAGEKIT_URL_ENDPOINT ?? '').trim();
    const publicKey = (process.env.IMAGEKIT_PUBLIC_KEY ?? '').trim();
    const privateKey = (process.env.IMAGEKIT_PRIVATE_KEY ?? '').trim();

    if (!urlEndpoint || !publicKey || !privateKey) {
      throw new Error('ImageKit environment variables are not configured');
    }

    this.config = {
      urlEndpoint,
      publicKey,
      privateKey,
    };

    this.client = new ImageKit({
      privateKey,
    });
  }

  detectImageMimeType(buffer: Buffer): SupportedImageMimeType | null {
    if (buffer.length >= 8) {
      const pngSignature = buffer.subarray(0, 8);
      if (
        pngSignature[0] === 0x89 &&
        pngSignature[1] === 0x50 &&
        pngSignature[2] === 0x4e &&
        pngSignature[3] === 0x47 &&
        pngSignature[4] === 0x0d &&
        pngSignature[5] === 0x0a &&
        pngSignature[6] === 0x1a &&
        pngSignature[7] === 0x0a
      ) {
        return 'image/png';
      }
    }

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }

    if (buffer.length >= 12) {
      const riff = buffer.toString('ascii', 0, 4);
      const webp = buffer.toString('ascii', 8, 12);
      if (riff === 'RIFF' && webp === 'WEBP') {
        return 'image/webp';
      }
    }

    if (buffer.length >= 6) {
      const header = buffer.toString('ascii', 0, 6);
      if (header === 'GIF87a' || header === 'GIF89a') {
        return 'image/gif';
      }
    }

    return null;
  }

  buildTestFileName(originalname: string, mimeType: SupportedImageMimeType): string {
    return this.buildFileName(DEFAULT_FILENAME_PREFIX, originalname, mimeType);
  }

  buildMediaFileName(assetType: MediaAssetType, originalname: string, mimeType: SupportedImageMimeType): string {
    return this.buildFileName(MEDIA_FILENAME_PREFIX_BY_TYPE[assetType], originalname, mimeType);
  }

  buildMediaFolder(assetType: MediaAssetType): string {
    return MEDIA_FOLDER_BY_TYPE[assetType];
  }

  private buildFileName(prefix: string, originalname: string, mimeType: SupportedImageMimeType): string {
    const parsedName = path.parse(originalname).name;
    const safeBaseName = sanitizeBaseName(parsedName);
    const extension = MIME_TO_EXTENSION[mimeType] ?? '.img';
    const uniqueSuffix = `${Date.now()}-${crypto.randomUUID()}`;

    return `${prefix}-${safeBaseName}-${uniqueSuffix}${extension}`;
  }

  private mapUploadResponse(
    uploaded: ImageKit.FileUploadResponse,
    assetType: MediaAssetType,
    mimeType: SupportedImageMimeType
  ): MediaUploadResponseData {
    return {
      provider: 'imagekit',
      assetType,
      fileId: uploaded.fileId ?? null,
      url: uploaded.url ?? null,
      name: uploaded.name ?? null,
      width: typeof uploaded.width === 'number' ? uploaded.width : null,
      height: typeof uploaded.height === 'number' ? uploaded.height : null,
      size: typeof uploaded.size === 'number' ? uploaded.size : null,
      mimeType,
      fileType: uploaded.fileType ?? null,
      thumbnailUrl: uploaded.thumbnailUrl ?? null,
    };
  }

  private async uploadImageAsset(
    file: UploadedImageFile,
    detectedMimeType: SupportedImageMimeType,
    assetType: MediaAssetType,
    fileNamePrefix: string,
    folder: string
  ): Promise<MediaUploadResponseData> {
    const fileName = this.buildFileName(fileNamePrefix, file.originalname, detectedMimeType);
    const uploadable = await toFile(file.buffer, fileName, {
      type: detectedMimeType,
    });

    const uploaded = await this.client.files.upload({
      file: uploadable,
      fileName,
      folder,
      useUniqueFileName: false,
    });

    return this.mapUploadResponse(uploaded, assetType, detectedMimeType);
  }

  async uploadTestImage(
    file: UploadedImageFile,
    detectedMimeType: SupportedImageMimeType
  ): Promise<ImageKit.FileUploadResponse> {
    const fileName = this.buildTestFileName(file.originalname, detectedMimeType);
    const uploadable = await toFile(file.buffer, fileName, {
      type: detectedMimeType,
    });

    return this.client.files.upload({
      file: uploadable,
      fileName,
      folder: TEST_FOLDER,
      useUniqueFileName: false,
    });
  }

  async uploadMediaImage(
    file: UploadedImageFile,
    detectedMimeType: SupportedImageMimeType,
    assetType: MediaAssetType
  ): Promise<MediaUploadResponseData> {
    return this.uploadImageAsset(
      file,
      detectedMimeType,
      assetType,
      MEDIA_FILENAME_PREFIX_BY_TYPE[assetType],
      MEDIA_FOLDER_BY_TYPE[assetType]
    );
  }

  async deleteMediaImage(fileId: string): Promise<void> {
    await this.client.files.delete(fileId);
  }
}
