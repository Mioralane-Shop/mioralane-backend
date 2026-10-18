import { slugify } from '../utils/slugify';
import { BlogPost, IBlogPostDocument } from './blog.model';
import type { CreateBlogPostInput, UpdateBlogPostInput } from './blog.schemas';

/** A service error the controller maps to a specific HTTP status. */
interface BlogServiceError extends Error {
    statusCode?: number;
    code?: string;
}

const blogError = (statusCode: number, message: string, code?: string): BlogServiceError => {
    const error = new Error(message) as BlogServiceError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const toInput = (value: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = {};

    for (const [key, field] of Object.entries(value)) {
        if (field !== undefined) {
            next[key] = field;
        }
    }

    return next;
};

const resolveSlug = (input: CreateBlogPostInput | UpdateBlogPostInput, fallbackTitle?: string): string => {
    if (typeof input.slug === 'string' && input.slug.trim()) {
        return slugify(input.slug);
    }

    if (typeof input.title === 'string' && input.title.trim()) {
        return slugify(input.title);
    }

    return fallbackTitle ?? '';
};

const applyStatus = (doc: IBlogPostDocument, status: 'draft' | 'published'): void => {
    doc.status = status;

    if (status === 'published' && !doc.publishedAt) {
        doc.publishedAt = new Date();
    }
};

/* ───────────────────────────── public reads ───────────────────────────── */

/**
 * The slug a category is addressed by, e.g. `Routine` → `routine`,
 * `Skin Care Tips` → `skin-care-tips`. Derived on the fly so the storefront can
 * filter by a stable, URL-friendly identifier without a second taxonomy.
 */
const categorySlug = (value: unknown): string =>
    typeof value === 'string' ? slugify(value) : '';

/**
 * Storefront: published articles, newest first, without the full document.
 * `category` accepts either the stored label (`Routine`) or its slug
 * (`routine`) — both are normalised through `slugify` before comparing.
 */
export const listPublishedBlogPosts = async (filter: { category?: string } = {}) => {
    const docs = await BlogPost.find({ status: 'published' })
        .sort({ publishedAt: -1, createdAt: -1 })
        .select('-content')
        .lean();

    const requestedCategory = categorySlug(filter.category);

    // Filter on the raw documents so the category stays available before the
    // `_id` → `id` reshape narrows the object type.
    const visible = requestedCategory
        ? docs.filter(
              (doc) => categorySlug((doc as unknown as Record<string, unknown>).category) === requestedCategory
          )
        : docs;

    return visible.map((doc) => {
        const { _id, __v, ...rest } = doc as unknown as Record<string, unknown>;
        return { ...rest, id: String(_id) };
    });
};

/** Storefront: one published article by slug, including the full document. */
export const getPublishedBlogPostBySlug = async (slug: string): Promise<Record<string, unknown> | null> => {
    const doc = await BlogPost.findOne({ slug, status: 'published' });

    if (!doc) {
        return null;
    }

    return doc.toJSON() as unknown as Record<string, unknown>;
};

/* ────────────────────────────── admin reads ───────────────────────────── */

export const listAdminBlogPosts = async () => {
    const docs = await BlogPost.find().sort({ updatedAt: -1 }).select('-content').lean();

    return docs.map((doc) => {
        const { _id, __v, ...rest } = doc as unknown as Record<string, unknown>;
        return { ...rest, id: String(_id) };
    });
};

export const getBlogPostById = async (id: string): Promise<Record<string, unknown> | null> => {
    const doc = await BlogPost.findById(id);
    return doc ? (doc.toJSON() as unknown as Record<string, unknown>) : null;
};

/* ────────────────────────────── admin writes ──────────────────────────── */

export const createBlogPost = async (input: CreateBlogPostInput): Promise<Record<string, unknown>> => {
    const slug = resolveSlug(input);

    if (!slug) {
        throw blogError(400, 'A title is required to generate a slug');
    }

    const body = toInput(input as unknown as Record<string, unknown>);
    delete body.slug;

    const doc = await BlogPost.create({
        ...body,
        slug,
        status: input.status ?? 'draft',
    });

    applyStatus(doc, input.status ?? 'draft');
    if (input.status) {
        await doc.save();
    }

    return doc.toJSON() as unknown as Record<string, unknown>;
};

export const updateBlogPost = async (
    id: string,
    input: UpdateBlogPostInput
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> => {
    const doc = await BlogPost.findById(id);

    if (!doc) {
        return null;
    }

    const before = doc.toJSON() as unknown as Record<string, unknown>;
    const nextSlug = resolveSlug(input, doc.title);

    const body = toInput(input as unknown as Record<string, unknown>);
    delete body.slug;

    doc.set({ ...body, slug: nextSlug });

    applyStatus(doc, input.status ?? doc.status);

    await doc.save();

    return { before, after: doc.toJSON() as unknown as Record<string, unknown> };
};

export const setBlogPostStatus = async (
    id: string,
    status: 'draft' | 'published'
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> => {
    const doc = await BlogPost.findById(id);

    if (!doc) {
        return null;
    }

    const before = doc.toJSON() as unknown as Record<string, unknown>;
    applyStatus(doc, status);
    await doc.save();

    return { before, after: doc.toJSON() as unknown as Record<string, unknown> };
};

export const deleteBlogPost = async (id: string): Promise<Record<string, unknown> | null> => {
    const doc = await BlogPost.findByIdAndDelete(id);
    return doc ? (doc.toJSON() as unknown as Record<string, unknown>) : null;
};
