import { Router, RequestHandler } from 'express';
import { adminOnly, protect } from '../middleware/auth.middleware';
import {
    getAdminAnnouncementBar,
    getPublicAnnouncementBar,
    updateAdminAnnouncementBar,
} from './announcement.controller';

export const announcementPublicRoutes = Router();
export const adminAnnouncementRoutes = Router();

// Public: consumed by the storefront top bar
announcementPublicRoutes.get('/', getPublicAnnouncementBar as RequestHandler);

// Admin: the single place the announcement bar is managed from
adminAnnouncementRoutes.get(
    '/',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    getAdminAnnouncementBar as RequestHandler
);
adminAnnouncementRoutes.put(
    '/',
    protect as RequestHandler,
    adminOnly as RequestHandler,
    updateAdminAnnouncementBar as RequestHandler
);
