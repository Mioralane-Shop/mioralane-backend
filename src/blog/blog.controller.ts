import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { sanitizeValidationMessages } from '../middleware/error.middleware';
import {
    buildActivityChanges,
    pickActivitySnapshot,
    recordActivity,
    resolveUpdateAction,
} from '../activity-log/activity-log.service';
import {
    createBlogPost,
    deleteBlogPost,
    getBlogPostById,
    getPublishedBlogPostBySlug,
    listAdminBlogPosts as serviceListAdminBlogPosts,
    listPublishedBlogPosts,
    setBlogPostStatus,
    updateBlogPost,
} from './blog.service';
import { MAX_BLOG_CATEGORY_LENGTH } from './blog.model';
import type {
    CreateBlogPostInput,
    UpdateBlogPostInput,
    UpdateBlogStatusInput,
} from './blog.schemas';

const BLOG_AUDIT_FIELDS = [
    'title',
    'slug',
    'excerpt',
    'category',
    'coverImage',
    'author',
    'seoTitle',
    'seoDescription',
    'status',
    'publishedAt',
];

const getParamId = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? value[0] : value ?? '';

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

const sendBlogError = (res: Response, error: unknown, label: string): void => {
    const err = error as { statusCode?: number; message?: string; code?: string };

    if (err.statusCode === 400 || err.statusCode === 404) {
        res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
        return;
    }

    if (error instanceof mongoose.Error.ValidationError) {
        res.status(400).json({ success: false, message: 'Validation failed', errors: sanitizeValidationMessages(error) });
        return;
    }

    if ((error as { code?: number }).code === 11000) {
        res.status(409).json({ success: false, message: 'An article with this slug already exists' });
        return;
    }

    console.error(label, error);
    res.status(500).json({ success: false, message: 'Internal server error' });
};

/* ─────────────────────────── public reads ─────────────────────────── */

export const listPublicBlogPosts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const raw = req.query.category;
    const value = Array.isArray(raw) ? raw[0] : raw;

    // Absent → the full published feed. Present but unusable → 400 rather than
    // silently returning every article, which would misrepresent the filter.
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
        res.status(400).json({ success: false, message: 'Category must be a non-empty string' });
        return;
    }

    if (typeof value === 'string' && value.trim().length > MAX_BLOG_CATEGORY_LENGTH) {
        res.status(400).json({
            success: false,
            message: `Category cannot exceed ${MAX_BLOG_CATEGORY_LENGTH} characters`,
        });
        return;
    }

    const category = typeof value === 'string' ? value.trim() : undefined;

    res.json({ success: true, posts: await listPublishedBlogPosts({ category }) });
};

export const getPublicBlogPost = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : (req.params.slug ?? '');

    if (!slug) {
        res.status(400).json({ success: false, message: 'Slug is required' });
        return;
    }

    const post = await getPublishedBlogPostBySlug(slug);

    if (!post) {
        res.status(404).json({ success: false, message: 'Article not found' });
        return;
    }

    res.json({ success: true, post });
};

/* ──────────────────────────── admin reads ─────────────────────────── */

export const listAdminBlogPosts = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.json({ success: true, posts: await serviceListAdminBlogPosts() });
};

export const getAdminBlogPost = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = getParamId(req.params.id);

    if (!isObjectId(id)) {
        res.status(400).json({ success: false, message: 'Invalid article ID' });
        return;
    }

    const post = await getBlogPostById(id);

    if (!post) {
        res.status(404).json({ success: false, message: 'Article not found' });
        return;
    }

    res.json({ success: true, post });
};

/* ──────────────────────────── admin writes ────────────────────────── */

export const createAdminBlogPost = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const post = await createBlogPost(req.body as CreateBlogPostInput);

        await recordActivity(req, {
            action: 'CREATE',
            entityType: 'ARTICLE',
            entityId: String(post._id),
            entityName: String(post.title),
            after: pickActivitySnapshot(post, BLOG_AUDIT_FIELDS),
        });

        res.status(201).json({ success: true, post });
    } catch (error) {
        sendBlogError(res, error, '[createAdminBlogPost]');
    }
};

export const updateAdminBlogPost = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = getParamId(req.params.id);

        if (!isObjectId(id)) {
            res.status(400).json({ success: false, message: 'Invalid article ID' });
            return;
        }

        const result = await updateBlogPost(id, req.body as UpdateBlogPostInput);

        if (!result) {
            res.status(404).json({ success: false, message: 'Article not found' });
            return;
        }

        const changes = buildActivityChanges(
            pickActivitySnapshot(result.before, BLOG_AUDIT_FIELDS),
            pickActivitySnapshot(result.after, BLOG_AUDIT_FIELDS)
        );

        if (changes.changedFields.length > 0) {
            await recordActivity(req, {
                action: resolveUpdateAction(changes.changedFields),
                entityType: 'ARTICLE',
                entityId: String(result.after._id),
                entityName: String(result.after.title),
                before: changes.before,
                after: changes.after,
                metadata: { changedFields: changes.changedFields },
            });
        }

        res.json({ success: true, post: result.after });
    } catch (error) {
        sendBlogError(res, error, '[updateAdminBlogPost]');
    }
};

export const updateAdminBlogStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = getParamId(req.params.id);

        if (!isObjectId(id)) {
            res.status(400).json({ success: false, message: 'Invalid article ID' });
            return;
        }

        const { status } = req.body as UpdateBlogStatusInput;
        const result = await setBlogPostStatus(id, status);

        if (!result) {
            res.status(404).json({ success: false, message: 'Article not found' });
            return;
        }

        await recordActivity(req, {
            action: 'STATUS_CHANGE',
            entityType: 'ARTICLE',
            entityId: String(result.after._id),
            entityName: String(result.after.title),
            before: pickActivitySnapshot(result.before, ['status', 'publishedAt']),
            after: pickActivitySnapshot(result.after, ['status', 'publishedAt']),
        });

        res.json({ success: true, post: result.after });
    } catch (error) {
        sendBlogError(res, error, '[updateAdminBlogStatus]');
    }
};

export const deleteAdminBlogPost = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const id = getParamId(req.params.id);

        if (!isObjectId(id)) {
            res.status(400).json({ success: false, message: 'Invalid article ID' });
            return;
        }

        const post = await deleteBlogPost(id);

        if (!post) {
            res.status(404).json({ success: false, message: 'Article not found' });
            return;
        }

        await recordActivity(req, {
            action: 'DELETE',
            entityType: 'ARTICLE',
            entityId: String(post._id),
            entityName: String(post.title),
            before: pickActivitySnapshot(post, BLOG_AUDIT_FIELDS),
        });

        res.json({ success: true, message: 'Article deleted successfully' });
    } catch (error) {
        sendBlogError(res, error, '[deleteAdminBlogPost]');
    }
};
