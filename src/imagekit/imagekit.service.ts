import ImageKit, { toFile } from '@imagekit/nodejs';
import type { MediaAssetType, MediaUploadResponseData } from '../media/media.types';
import {
  MAX_MEDIA_UPLOAD_SIZE_BYTES,
  MEDIA_IMAGE_MIME_ALLOWLIST,
  buildImageFileName,
  type SupportedImageMimeType,
} from '../media/image-upload-policy';

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
  // Review images are temporarily disabled.
  // review: '/mioralane/reviews',
};
const MEDIA_FILENAME_PREFIX_BY_TYPE: Record<MediaAssetType, string> = {
  product: 'mioralane-product',
  combo: 'mioralane-combo',
  campaign: 'mioralane-campaign',
  // Review images are temporarily disabled.
  // review: 'mioralane-review',
};

/**
 * ImageKit-side upload checks — a second, independent layer (P1.2, decision ⑦).
 *
 * ImageKit is a store, not a validator: its API accepts `non-image` files, so
 * this asks it to refuse anything outside the same allowlist the local guard
 * uses, and anything above the media ceiling. The string is **generated** from
 * `MEDIA_IMAGE_MIME_ALLOWLIST` / `MAX_MEDIA_UPLOAD_SIZE_BYTES` rather than typed
 * out, because a duplicated allowlist is a list that eventually disagrees with
 * itself — the same reason the CORS and CSRF header lists are single-sourced.
 *
 * Two things to be clear about:
 *  - This can never be the primary control. It only runs once the bytes have
 *    already been sent to a third party, and it is unavailable in tests.
 *  - The ceiling here is the shared media ceiling (8MB). The dev-only test route
 *    enforces its own tighter 5MB locally in `imagekit.module.ts`; this bound is
 *    the wider one on purpose, so it cannot reject a legitimate media upload.
 *
 * If this syntax were ever rejected by the API, every upload would fail with a
 * 400 and `'ImageKit upload failed'` in the log, so it is one line to drop.
 */
const buildUploadChecks = (): string => {
  const mimeList = MEDIA_IMAGE_MIME_ALLOWLIST.map((mime) => `'${mime}'`).join(', ');

  return `'file.mime' IN [${mimeList}] AND 'file.size' <= ${MAX_MEDIA_UPLOAD_SIZE_BYTES}`;
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
      checks: buildUploadChecks(),
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
      checks: buildUploadChecks(),
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
