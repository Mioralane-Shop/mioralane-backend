import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
    buildActivityChanges,
    recordActivity,
    resolveUpdateAction,
} from '../activity-log/activity-log.service';
import {
    getMegaMenu,
    serializeMegaMenuForStorefront,
    upsertMegaMenuSettings,
} from './mega-menu.service';
import type { MegaMenuSettingsInput } from './mega-menu.schemas';

/** Storefront "Shop" mega menu (desktop navbar panel) */
export const getPublicMegaMenu = async (_req: Request, res: Response): Promise<void> => {
    const settings = await getMegaMenu();

    res.json({
        success: true,
        menu: serializeMegaMenuForStorefront(settings),
    });
};

export const getAdminMegaMenu = async (
    _req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    const settings = await getMegaMenu();
    res.json({ success: true, settings });
};

export const updateAdminMegaMenu = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const previousSettings = await getMegaMenu();
        // `req.body` is the parsed `megaMenuSettingsSchema` output; the service
        // normalizer stays the authority for dropping blank rows, deriving item
        // ids and merging absent tabs back to the seeded defaults.
        const settings = await upsertMegaMenuSettings(req.body as MegaMenuSettingsInput);

        const changes = buildActivityChanges(
            previousSettings as unknown as Record<string, unknown>,
            settings as unknown as Record<string, unknown>
        );

        if (changes.changedFields.length > 0) {
            await recordActivity(req, {
                action: resolveUpdateAction(changes.changedFields),
                entityType: 'SETTINGS',
                entityId: 'mega-menu',
                entityName: 'Mega menu',
                before: changes.before,
                after: changes.after,
                metadata: { changedFields: changes.changedFields },
            });
        }

        res.json({ success: true, settings });
    } catch (error) {
        const err = error as { statusCode?: number; message?: string; code?: string };

        if (err.statusCode === 400) {
            res.status(400).json({ success: false, message: err.message, code: err.code });
            return;
        }

        console.error('[updateAdminMegaMenu]', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
