import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
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

const guard = [protect as RequestHandler, adminOnly as RequestHandler];

activityLogRoutes.get('/actors', ...guard, getActivityActors as RequestHandler);

activityLogRoutes.get('/admin', ...guard, listAdminActivity as RequestHandler);
activityLogRoutes.get('/admin/:id', ...guard, getAdminActivity as RequestHandler);

activityLogRoutes.get('/participants', ...guard, listParticipantActivity as RequestHandler);
activityLogRoutes.get('/participants/:id', ...guard, getParticipantActivity as RequestHandler);
