import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
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
activityLogRoutes.get('/admin/:id', getAdminActivity as RequestHandler);

activityLogRoutes.get('/participants', listParticipantActivity as RequestHandler);
activityLogRoutes.get('/participants/:id', getParticipantActivity as RequestHandler);
