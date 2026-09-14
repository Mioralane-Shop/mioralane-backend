import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getCrossSellSettings, upsertCrossSellSettings } from './cross-sell.service';

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
    const settings = await upsertCrossSellSettings(req.body);
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
