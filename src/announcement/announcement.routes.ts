import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import {
    getAdminAnnouncementBar,
    getPublicAnnouncementBar,
    updateAdminAnnouncementBar,
} from './announcement.controller';

export const announcementPublicRoutes = Router();
export const adminAnnouncementRoutes = Router();

// Public: consumed by the storefront top bar
announcementPublicRoutes.get('/', getPublicAnnouncementBar as RequestHandler);

// Admin: the single place the announcement bar is managed from.
// Every route on this router is admin-only.
adminAnnouncementRoutes.use(...adminGuard);

adminAnnouncementRoutes.get('/', getAdminAnnouncementBar as RequestHandler);
adminAnnouncementRoutes.put('/', updateAdminAnnouncementBar as RequestHandler);
