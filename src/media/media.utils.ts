import type { MediaAsset, MediaAssetType } from './media.types';
import { extractMediaUrls, normalizeMediaAssets } from './media.schema';
// One definition, owned by its primary consumer. `media.utils.ts` carried a
// byte-identical copy until 2026-10-10; importing the original is what guarantees
// the folder a file is written to and the folder reported here cannot disagree.
// No import cycle: `imagekit.service.ts` imports only the ImageKit SDK, the media
// types and the upload policy — and its client is built in the constructor, not at
// module scope, so this import pulls in no env requirements.
import { MEDIA_FOLDER_BY_TYPE } from '../imagekit/imagekit.service';

// Re-exported so this module's public surface is unchanged by the collapse.
export { MEDIA_FOLDER_BY_TYPE };

export { extractMediaUrls, normalizeMediaAssets };

export const hasMediaAssets = (media?: MediaAsset[] | null): boolean =>
  Array.isArray(media) && media.length > 0;

export const resolveMediaFolder = (assetType: MediaAssetType): string => MEDIA_FOLDER_BY_TYPE[assetType];
