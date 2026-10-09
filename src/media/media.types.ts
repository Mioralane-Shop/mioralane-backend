export type MediaAssetProvider = 'imagekit';
// Review images are temporarily disabled — restore 'review' to re-enable review images.
// export type MediaAssetType = 'product' | 'combo' | 'campaign' | 'review';
//
// `brand-logo` is the only member allowed to store SVG (a vector wordmark); see
// the brand-logo block in `image-upload-policy.ts` for the content check that
// comes with it.
export type MediaAssetType = 'product' | 'combo' | 'campaign' | 'brand-logo';

export interface MediaAsset {
  provider: MediaAssetProvider;
  fileId?: string | null;
  url: string;
  name?: string;
  width?: number;
  height?: number;
  size?: number;
  mimeType?: string;
  alt?: string;
  sortOrder?: number;
}

export interface MediaUploadResponseData {
  provider: MediaAssetProvider;
  assetType: MediaAssetType;
  fileId: string | null;
  url: string | null;
  name: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  mimeType: string | null;
  fileType: string | null;
  thumbnailUrl: string | null;
}
