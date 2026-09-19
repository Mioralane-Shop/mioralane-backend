import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getCrossSellSettings, upsertCrossSellSettings } from './cross-sell.service';
import {
  buildActivityChanges,
  recordActivity,
  resolveUpdateAction,
} from '../activity-log/activity-log.service';

export const getAdminCrossSellSettings = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const settings = await getCrossSellSettings();
  res.json({ success: true, settings });
};

export const updateAdminCrossSellSettings = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const previousSettings = await getCrossSellSettings();
    const settings = await upsertCrossSellSettings(req.body);

    const changes = buildActivityChanges(
      previousSettings as unknown as Record<string, unknown>,
      settings as unknown as Record<string, unknown>
    );

    if (changes.changedFields.length > 0) {
      await recordActivity(req, {
        action: resolveUpdateAction(changes.changedFields),
        entityType: 'SETTINGS',
        entityId: 'cross-sell',
        entityName: 'Cross-sell settings',
        before: changes.before,
        after: changes.after,
        metadata: { changedFields: changes.changedFields },
      });
    }

    res.json({ success: true, settings });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to update cross-sell settings',
      code: err.code ?? 'cross_sell_settings_update_failed',
    });
  }
};
