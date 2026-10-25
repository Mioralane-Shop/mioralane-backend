import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
    getAdminMegaMenu,
    getPublicMegaMenu,
    updateAdminMegaMenu,
} from './mega-menu.controller';
import { megaMenuSettingsSchema } from './mega-menu.schemas';

export const megaMenuPublicRoutes = Router();
export const adminMegaMenuRoutes = Router();

// Public: consumed by the storefront navbar.
megaMenuPublicRoutes.get('/', getPublicMegaMenu as RequestHandler);

// Admin: the single place the mega menu is managed from.
// Every route on this router is admin-only.
adminMegaMenuRoutes.use(...adminGuard);

adminMegaMenuRoutes.get('/', getAdminMegaMenu as RequestHandler);
adminMegaMenuRoutes.put(
    '/',
    validate({ body: megaMenuSettingsSchema }),
    updateAdminMegaMenu as RequestHandler
);
