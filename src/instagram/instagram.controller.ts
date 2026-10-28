import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  buildActivityChanges,
  recordActivity,
  resolveUpdateAction,
} from '../activity-log/activity-log.service';
import {
  getInstagramFeedForStorefront,
  getInstagramMediaForAdmin,
  getInstagramSettings,
  hasInstagramCredentials,
  syncInstagramMedia,
  updateInstagramSelection,
} from './instagram.service';
import type { InstagramSelectionInput, InstagramSyncQueryInput } from './instagram.schemas';
import {
  MAX_FEATURED_INSTAGRAM_VIDEOS,
  MIN_FEATURED_INSTAGRAM_VIDEOS,
} from './instagram-settings.model';

/** Storefront homepage showcase — only the admin's featured reels, in order. */
export const getPublicInstagramFeed = async (_req: Request, res: Response): Promise<void> => {
  const videos = await getInstagramFeedForStorefront();

  res.json({ success: true, videos });
};

/** Admin view: synced media + the current selection. */
export const getAdminInstagramFeed = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const [media, settings] = await Promise.all([getInstagramMediaForAdmin(), getInstagramSettings()]);

  res.json({
    success: true,
    media,
    settings: {
      featuredMediaIds: settings.featuredMediaIds,
      lastSyncAt: settings.lastSyncAt,
      minFeatured: MIN_FEATURED_INSTAGRAM_VIDEOS,
      maxFeatured: MAX_FEATURED_INSTAGRAM_VIDEOS,
      configured: hasInstagramCredentials(),
    },
  });
};

/** Pulls one page of recent media from the connected Instagram account. */
export const syncAdminInstagramFeed = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const query = req.query as InstagramSyncQueryInput;
    const result = await syncInstagramMedia({
      limit: typeof query.limit === 'number' ? query.limit : undefined,
      after: typeof query.after === 'string' ? query.after : undefined,
    });

    await recordActivity(req, {
      action: 'UPDATE',
      entityType: 'SETTINGS',
      entityId: 'instagram-feed',
      entityName: 'Instagram feed',
      actionLabel: 'Synced Instagram media',
      metadata: {
        fetchedCount: result.totalFetched,
        newCount: result.newCount,
        refreshedCount: result.refreshedCount,
      },
    });

    res.json({ success: true, sync: result });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };

    res.status(err.statusCode ?? 502).json({
      success: false,
      message: err.message ?? 'Unable to sync Instagram media',
      code: err.code ?? 'instagram_sync_failed',
    });
  }
};

/** Saves the admin's ordered homepage selection. */
export const updateAdminInstagramSelection = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const previousSettings = await getInstagramSettings();
    const result = await updateInstagramSelection(req.body as InstagramSelectionInput);

    const changes = buildActivityChanges(
      previousSettings as unknown as Record<string, unknown>,
      { featuredMediaIds: result.featuredMediaIds } as unknown as Record<string, unknown>,
      ['featuredMediaIds']
    );

    if (changes.changedFields.length > 0) {
      await recordActivity(req, {
        action: resolveUpdateAction(changes.changedFields),
        entityType: 'SETTINGS',
        entityId: 'instagram-feed',
        entityName: 'Instagram feed',
        before: changes.before,
        after: changes.after,
        metadata: { changedFields: changes.changedFields },
      });
    }

    res.json({
      success: true,
      settings: {
        featuredMediaIds: result.featuredMediaIds,
        featuredMedia: result.featuredMedia,
        eligibleReelCount: result.eligibleReelCount,
      },
    });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };

    if (err.statusCode === 400) {
      res.status(400).json({ success: false, message: err.message, code: err.code });
      return;
    }

    console.error('[updateAdminInstagramSelection]', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
