import { Schema } from 'mongoose';
import type { MediaAsset } from './media.types';

export const MediaAssetSchema = new Schema<MediaAsset>(
  {
    provider: {
      type: String,
      default: 'imagekit',
      enum: ['imagekit'],
      required: true,
      trim: true,
    },
    fileId: {
      type: String,
      default: null,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      default: '',
      trim: true,
    },
    width: {
      type: Number,
      default: null,
    },
    height: {
      type: Number,
      default: null,
    },
    size: {
      type: Number,
      default: null,
      min: 0,
    },
    mimeType: {
      type: String,
      default: '',
      trim: true,
    },
    alt: {
      type: String,
      default: '',
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  {
    _id: false,
    id: false,
  }
);

export const extractMediaUrls = (media?: MediaAsset[] | null): string[] =>
  (media ?? [])
    .map((asset) => asset.url)
    .filter((url): url is string => typeof url === 'string' && url.trim().length > 0);

export const normalizeMediaAssets = (value: unknown): MediaAsset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Partial<MediaAsset>;
    const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
    const fileId = typeof candidate.fileId === 'string' ? candidate.fileId.trim() : '';

    if (!url) {
      return [];
    }

    return [
      {
        provider: candidate.provider === 'imagekit' ? 'imagekit' : 'imagekit',
        fileId: fileId || null,
        url,
        name: typeof candidate.name === 'string' ? candidate.name.trim() : undefined,
        width: typeof candidate.width === 'number' && Number.isFinite(candidate.width) ? candidate.width : undefined,
        height: typeof candidate.height === 'number' && Number.isFinite(candidate.height) ? candidate.height : undefined,
        size: typeof candidate.size === 'number' && Number.isFinite(candidate.size) ? candidate.size : undefined,
        mimeType: typeof candidate.mimeType === 'string' ? candidate.mimeType.trim() : undefined,
        alt: typeof candidate.alt === 'string' ? candidate.alt.trim() : undefined,
        sortOrder:
          typeof candidate.sortOrder === 'number' && Number.isFinite(candidate.sortOrder)
            ? candidate.sortOrder
            : index,
      },
    ];
  });
};
