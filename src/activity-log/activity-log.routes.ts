import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
    getActivityActors,
    getAdminActivity,
    getParticipantActivity,
    listAdminActivity,
    listParticipantActivity,
} from './activity-log.controller';

/**
 * Activity logs are an audit surface, so every route — including the
 * participant feed — is admin-only. Participants can never read their own
 * activity through this API; menu visibility is not relied upon.
 */
export const activityLogRoutes = Router();

// Every route on this router is admin-only.
activityLogRoutes.use(...adminGuard);

activityLogRoutes.get('/actors', getActivityActors as RequestHandler);

activityLogRoutes.get('/admin', listAdminActivity as RequestHandler);
// Both `:id` routes take an ObjectId. `getActivityLogById` already refuses a
// malformed one with 'A valid activity id is required'; `message` reproduces that
// wording verbatim so the param schema is invisible to clients (P1.6.1).
activityLogRoutes.get(
    '/admin/:id',
    validate({ params: objectIdParam('id'), message: 'A valid activity id is required' }),
    getAdminActivity as RequestHandler
);

activityLogRoutes.get('/participants', listParticipantActivity as RequestHandler);
activityLogRoutes.get(
    '/participants/:id',
    validate({ params: objectIdParam('id'), message: 'A valid activity id is required' }),
    getParticipantActivity as RequestHandler
);
