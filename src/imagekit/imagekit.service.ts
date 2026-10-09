import ImageKit, { toFile } from '@imagekit/nodejs';
import type { MediaAssetType, MediaUploadResponseData } from '../media/media.types';
import { buildImageFileName, type SupportedImageMimeType } from '../media/image-upload-policy';

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
/**
 * The ImageKit destination folder per asset type.
 *
 * Exported because `media/media.utils.ts` used to carry a second, identical copy
 * (removed 2026-10-10) — nothing kept the two in step, and only the fact that both
 * were exhaustive `Record<MediaAssetType, string>`s made a divergence a compile
 * error rather than a silent one-folder-vs-another bug.
 */
export const MEDIA_FOLDER_BY_TYPE: Record<MediaAssetType, string> = {
  product: '/mioralane/products',
  combo: '/mioralane/combos',
  campaign: '/mioralane/campaigns',
  'brand-logo': '/mioralane/brand-logos',
  // Review images are temporarily disabled.
  // review: '/mioralane/reviews',
};
const MEDIA_FILENAME_PREFIX_BY_TYPE: Record<MediaAssetType, string> = {
  product: 'mioralane-product',
  combo: 'mioralane-combo',
  campaign: 'mioralane-campaign',
  'brand-logo': 'mioralane-brand-logo',
  // Review images are temporarily disabled.
  // review: 'mioralane-review',
};

/**
 * The ImageKit `checks` clause was removed here in P1.2a.
 *
 * P1.2 sent `checks: "'file.mime' IN [...] AND 'file.size' <= 8388608"` as a
 * provider-side second layer. The syntax matched ImageKit's documentation but was
 * never exercised against the live API, and the failure mode was severe: an
 * invalid clause makes ImageKit reject the upload, so **every** upload would
 * answer 400 `'ImageKit upload failed'`.
 *
 * The local guard (`middleware/upload-validator.middleware.ts`) is the tested
 * control — 65 harness checks plus negative controls, no network, no credentials
 * — so the unverified layer was not worth that blast radius.
 *
 * Re-adding it is tracked as a P1.6 chore: smoke-test the clause in dev with real
 * credentials first, then reintroduce it generated from
 * `MEDIA_IMAGE_MIME_ALLOWLIST` / `MAX_MEDIA_UPLOAD_SIZE_BYTES` rather than typed
 * out. Git history (commit before P1.2a) has the exact string.
 */

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

  buildTestFileName(originalname: string, mimeType: SupportedImageMimeType): string {
    return buildImageFileName(DEFAULT_FILENAME_PREFIX, originalname, mimeType);
  }

  buildMediaFileName(assetType: MediaAssetType, originalname: string, mimeType: SupportedImageMimeType): string {
    return buildImageFileName(MEDIA_FILENAME_PREFIX_BY_TYPE[assetType], originalname, mimeType);
  }

  buildMediaFolder(assetType: MediaAssetType): string {
    return MEDIA_FOLDER_BY_TYPE[assetType];
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
    const fileName = buildImageFileName(fileNamePrefix, file.originalname, detectedMimeType);
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
