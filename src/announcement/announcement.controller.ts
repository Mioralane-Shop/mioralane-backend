import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
    buildActivityChanges,
    recordActivity,
    resolveUpdateAction,
} from '../activity-log/activity-log.service';
import {
    getAnnouncementBarSettings,
    upsertAnnouncementBarSettings,
} from './announcement.service';
import type { AnnouncementSettingsInput } from './announcement.schemas';

/** Storefront announcement bar (top ticker) */
export const getPublicAnnouncementBar = async (_req: Request, res: Response): Promise<void> => {
    const settings = await getAnnouncementBarSettings();

    res.json({
        success: true,
        announcement: {
            enabled: settings.enabled,
            messages: settings.messages,
            animation: settings.animation,
            direction: settings.direction,
            background: settings.background,
            backgroundColor: settings.backgroundColor,
            textColor: settings.textColor,
            intervalSeconds: settings.intervalSeconds,
            speedSeconds: settings.speedSeconds,
        },
    });
};

export const getAdminAnnouncementBar = async (
    _req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    const settings = await getAnnouncementBarSettings();
    res.json({ success: true, settings });
};

export const updateAdminAnnouncementBar = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const previousSettings = await getAnnouncementBarSettings();
        // `req.body` is the parsed `announcementSettingsSchema` output; the service
        // normalizer stays the authority for blank-row dropping, the
        // "at least one message when enabled" rule and colour uppercasing.
        const settings = await upsertAnnouncementBarSettings(
            req.body as AnnouncementSettingsInput
        );

        const changes = buildActivityChanges(
            previousSettings as unknown as Record<string, unknown>,
            settings as unknown as Record<string, unknown>
        );

        if (changes.changedFields.length > 0) {
            await recordActivity(req, {
                action: resolveUpdateAction(changes.changedFields),
                entityType: 'SETTINGS',
                entityId: 'announcement-bar',
                entityName: 'Announcement bar',
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

        console.error('[updateAdminAnnouncementBar]', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
