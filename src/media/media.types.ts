export type MediaAssetProvider = 'imagekit';
export type MediaAssetType = 'product' | 'combo' | 'campaign';

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
