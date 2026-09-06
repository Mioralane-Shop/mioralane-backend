import type { MediaAsset, MediaAssetType } from './media.types';
import { extractMediaUrls, normalizeMediaAssets } from './media.schema';

export const MEDIA_FOLDER_BY_TYPE: Record<MediaAssetType, string> = {
  product: '/mioralane/products',
  combo: '/mioralane/combos',
};

export { extractMediaUrls, normalizeMediaAssets };

export const hasMediaAssets = (media?: MediaAsset[] | null): boolean =>
  Array.isArray(media) && media.length > 0;

export const resolveMediaFolder = (assetType: MediaAssetType): string => MEDIA_FOLDER_BY_TYPE[assetType];
