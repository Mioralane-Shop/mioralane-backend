import { Router, RequestHandler } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { objectIdParam } from '../utils/validation';
import {
    createAdminBlogPost,
    deleteAdminBlogPost,
    getAdminBlogPost,
    getPublicBlogPost,
    listAdminBlogPosts,
    listPublicBlogPosts,
    updateAdminBlogPost,
    updateAdminBlogStatus,
} from './blog.controller';
import {
    createBlogPostSchema,
    updateBlogPostSchema,
    updateBlogStatusSchema,
} from './blog.schemas';

export const blogPublicRoutes = Router();
export const adminBlogRoutes = Router();

// Public: consumed by the storefront blog listing and article pages.
blogPublicRoutes.get('/', listPublicBlogPosts as RequestHandler);
blogPublicRoutes.get('/:slug', getPublicBlogPost as RequestHandler);

// Admin: every route on this router is admin-only.
adminBlogRoutes.use(...adminGuard);

adminBlogRoutes.get('/', listAdminBlogPosts as RequestHandler);

adminBlogRoutes.post(
    '/',
    validate({ body: createBlogPostSchema }),
    createAdminBlogPost as RequestHandler
);

/**
 * ⚠️ ORDER MATTERS: `/status` is registered before `/:id` so a PATCH to
 * `/status` can never be swallowed by the id param (same pattern as brands).
 */
adminBlogRoutes.patch(
    '/:id/status',
    validate({ body: updateBlogStatusSchema }),
    validate({ params: objectIdParam('id'), message: 'Invalid article ID' }),
    updateAdminBlogStatus as RequestHandler
);

adminBlogRoutes.get(
    '/:id',
    validate({ params: objectIdParam('id'), message: 'Invalid article ID' }),
    getAdminBlogPost as RequestHandler
);

adminBlogRoutes.put(
    '/:id',
    validate({ body: updateBlogPostSchema }),
    validate({ params: objectIdParam('id'), message: 'Invalid article ID' }),
    updateAdminBlogPost as RequestHandler
);

adminBlogRoutes.delete(
    '/:id',
    validate({ params: objectIdParam('id'), message: 'Invalid article ID' }),
    deleteAdminBlogPost as RequestHandler
);
