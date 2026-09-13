import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getInventorySettings, upsertInventorySettings } from './inventory.service';

export const getAdminInventorySettings = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const settings = await getInventorySettings();
  res.json({ success: true, settings });
};

export const updateAdminInventorySettings = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const settings = await upsertInventorySettings(req.body);
    res.json({ success: true, settings });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to update inventory settings',
      code: err.code ?? 'inventory_settings_update_failed',
    });
  }
};
