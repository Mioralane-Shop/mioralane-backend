import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ActivityActorType, ActivityAction, ActivityEntityType } from './activity-log.model';
import {
    getActivityLogById,
    listActivityActors,
    listActivityLogs,
    normalizeActivityAction,
    normalizeActivityEntityType,
    normalizeActivitySort,
} from './activity-log.service';

const respondWithActivityError = (res: Response, error: unknown, fallback: string): void => {
    const err = error as { statusCode?: number; message?: string; code?: string };

    if ((err.statusCode ?? 500) >= 500) {
        console.error('[activity-log]', error);
    }

    res.status((err.statusCode ?? 400) >= 500 ? 500 : err.statusCode ?? 400).json({
        success: false,
        message: err.message ?? fallback,
        code: err.code ?? 'activity_log_request_failed',
    });
};

const readQueryString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const readEnumList = <T>(value: unknown, normalize: (entry: unknown) => T): T[] | undefined => {
    if (value === undefined) {
        return undefined;
    }

    const raw = Array.isArray(value) ? value : String(value).split(',');

    return raw
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalize(entry));
};

const listActivityFeed =
    (actorType: ActivityActorType, label: string) =>
        async (req: AuthenticatedRequest, res: Response): Promise<void> => {
            try {
                const result = await listActivityLogs(actorType, {
                    actorId: readQueryString(req.query.actorId),
                    action: readEnumList<ActivityAction>(req.query.action, normalizeActivityAction),
                    entityType: readEnumList<ActivityEntityType>(
                        req.query.entityType,
                        normalizeActivityEntityType
                    ),
                    entityId: readQueryString(req.query.entityId),
                    from: readQueryString(req.query.from),
                    to: readQueryString(req.query.to),
                    search: readQueryString(req.query.search),
                    sort: normalizeActivitySort(req.query.sort),
                    page: req.query.page,
                    limit: req.query.limit,
                });

                res.status(200).json({ success: true, ...result });
            } catch (error) {
                respondWithActivityError(res, error, `Unable to load ${label} activity`);
            }
        };

const getActivityDetail =
    (actorType: ActivityActorType, label: string) =>
        async (req: AuthenticatedRequest, res: Response): Promise<void> => {
            try {
                const rawId = req.params.id;
                const activityId = Array.isArray(rawId) ? rawId[0] : rawId;
                const activity = await getActivityLogById(activityId, actorType);

                res.status(200).json({ success: true, activity });
            } catch (error) {
                respondWithActivityError(res, error, `Unable to load this ${label} activity entry`);
            }
        };

/** GET /api/activity-logs/admin */
export const listAdminActivity = listActivityFeed('admin', 'admin');

/** GET /api/activity-logs/admin/:id */
export const getAdminActivity = getActivityDetail('admin', 'admin');

/** GET /api/activity-logs/participants */
export const listParticipantActivity = listActivityFeed('participant', 'participant');

/** GET /api/activity-logs/participants/:id */
export const getParticipantActivity = getActivityDetail('participant', 'participant');

/** GET /api/activity-logs/actors?actorType=admin — filter options for the UI. */
export const getActivityActors = async (
    req: AuthenticatedRequest,
    res: Response
): Promise<void> => {
    try {
        const actorType: ActivityActorType = req.query.actorType === 'participant' ? 'participant' : 'admin';
        const actors = await listActivityActors(actorType);

        res.status(200).json({ success: true, actorType, actors });
    } catch (error) {
        respondWithActivityError(res, error, 'Unable to load activity actors');
    }
};
