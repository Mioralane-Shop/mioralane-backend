import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  getAdminInstagramFeed,
  getPublicInstagramFeed,
  syncAdminInstagramFeed,
  updateAdminInstagramSelection,
} from './instagram.controller';
import { instagramSelectionSchema, instagramSyncQuerySchema } from './instagram.schemas';

export const instagramPublicRoutes = Router();
export const adminInstagramRoutes = Router();

// Public: consumed by the storefront homepage showcase.
instagramPublicRoutes.get('/', getPublicInstagramFeed as RequestHandler);

// Admin: sync + selection management. Every route on this router is admin-only.
adminInstagramRoutes.use(...adminGuard);

adminInstagramRoutes.get('/', getAdminInstagramFeed as RequestHandler);

adminInstagramRoutes.post(
  '/sync',
  validate({ query: instagramSyncQuerySchema }),
  syncAdminInstagramFeed as RequestHandler
);

adminInstagramRoutes.put(
  '/selection',
  validate({ body: instagramSelectionSchema }),
  updateAdminInstagramSelection as RequestHandler
);
