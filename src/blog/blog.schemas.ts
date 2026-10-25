import { z } from 'zod';
import { safeUrlSchema } from '../utils/validation';
import {
    MAX_BLOG_AUTHOR_LENGTH,
    MAX_BLOG_CATEGORY_LENGTH,
    MAX_BLOG_EXCERPT_LENGTH,
    MAX_BLOG_SEO_DESCRIPTION_LENGTH,
    MAX_BLOG_SEO_TITLE_LENGTH,
    MAX_BLOG_SLUG_LENGTH,
    MAX_BLOG_TITLE_LENGTH,
} from './blog.model';

/**
 * Body schemas for the blog mutations and the admin status change.
 *
 * `content` is the Tiptap JSON document, validated structurally rather than
 * exhaustively: every node and mark type must be on the allowlist, the tree is
 * bounded, and image `src` values go through `safeUrlSchema`. The storefront
 * renderer applies the same allowlist again at render time, so a value that
 * sneaks through here still cannot become arbitrary HTML.
 */

/** The slug a client may send. Empty is not valid here — the service derives one. */
const slugShape = z
    .string()
    .trim()
    .min(1, 'Slug is required')
    .max(MAX_BLOG_SLUG_LENGTH, `Slug cannot exceed ${MAX_BLOG_SLUG_LENGTH} characters`)
    // Unicode-aware so a Bangla title produces a readable Bangla slug. `\p{M}`
    // is needed for the vowel signs; the hyphen is the only separator.
    .regex(/^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$/u, 'Slug may only contain letters, numbers and hyphens');

const ALLOWED_NODE_TYPES = new Set([
    'doc',
    'paragraph',
    'heading',
    'bulletList',
    'orderedList',
    'listItem',
    'blockquote',
    'horizontalRule',
    'image',
    'text',
    'hardBreak',
]);

const ALLOWED_MARK_TYPES = new Set([
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'link',
]);

const MAX_CONTENT_DEPTH = 30;
const MAX_CONTENT_NODES = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk the Tiptap tree and return an error string, or null when it is acceptable.
 * Pure and dependency-free so the frontend could reuse the same rules.
 */
export function validateTiptapDoc(value: unknown): string | null {
    if (!isObject(value) || value.type !== 'doc') {
        return 'Content must be a Tiptap document';
    }

    let nodeCount = 0;

    const walk = (node: unknown, depth: number): string | null => {
        if (depth > MAX_CONTENT_DEPTH) {
            return 'Content is nested too deeply';
        }

        if (!isObject(node) || typeof node.type !== 'string') {
            return 'Every content node needs a type';
        }

        if (!ALLOWED_NODE_TYPES.has(node.type)) {
            return `Unsupported content node: ${node.type}`;
        }

        nodeCount += 1;
        if (nodeCount > MAX_CONTENT_NODES) {
            return 'Content has too many nodes';
        }

        const attrs = isObject(node.attrs) ? node.attrs : {};

        if (node.type === 'text') {
            if (node.text !== undefined && typeof node.text !== 'string') {
                return 'Text nodes must carry a string';
            }

            if (node.marks !== undefined) {
                if (!Array.isArray(node.marks)) {
                    return 'Text marks must be an array';
                }

                for (const mark of node.marks) {
                    if (!isObject(mark) || typeof mark.type !== 'string') {
                        return 'Every text mark needs a type';
                    }

                    if (!ALLOWED_MARK_TYPES.has(mark.type)) {
                        return `Unsupported text mark: ${mark.type}`;
                    }

                    if (mark.type === 'link') {
                        const markAttrs = isObject(mark.attrs) ? mark.attrs : {};
                        const href = markAttrs.href;
                        if (typeof href !== 'string' || href.length === 0 || href.length > 2048) {
                            return 'Links need a valid href';
                        }
                    }
                }
            }
        }

        if (node.type === 'image') {
            const src = attrs.src;
            if (typeof src !== 'string' || src.length === 0 || src.length > 2048) {
                return 'Images need a valid src';
            }
            // A safe URL shape: https URL or site-relative path. Nothing else is
            // renderable by the storefront, so refusing it here keeps the contract.
            if (!safeUrlSchema().safeParse(src).success) {
                return 'Image src is not a safe URL';
            }

            for (const field of ['alt', 'title', 'caption']) {
                const value = attrs[field];
                if (value !== undefined && value !== null && typeof value !== 'string') {
                    return `Image ${field} must be a string`;
                }
            }

            for (const field of ['width', 'height']) {
                const value = attrs[field];
                if (value !== undefined && value !== null && (!Number.isFinite(value) || Number(value) <= 0)) {
                    return `Image ${field} must be a positive number`;
                }
            }
        }

        if (node.type === 'heading') {
            const level = attrs.level;
            if (level !== undefined && (typeof level !== 'number' || level < 1 || level > 3)) {
                return 'Heading level must be between 1 and 3';
            }
        }

        if (node.content !== undefined) {
            if (!Array.isArray(node.content)) {
                return 'Node content must be an array';
            }

            for (const child of node.content) {
                const error = walk(child, depth + 1);
                if (error) {
                    return error;
                }
            }
        }

        return null;
    };

    const content = value.content;
    if (content !== undefined) {
        if (!Array.isArray(content)) {
            return 'Document content must be an array';
        }

        for (const child of content) {
            const error = walk(child, 1);
            if (error) {
                return error;
            }
        }
    }

    return null;
}

export const blogContentSchema = z
    .unknown()
    .refine((value) => validateTiptapDoc(value) === null, {
        message: 'Invalid article content structure',
    });

const blogFields = {
    title: z
        .string()
        .trim()
        .min(1, 'Title is required')
        .max(MAX_BLOG_TITLE_LENGTH, `Title cannot exceed ${MAX_BLOG_TITLE_LENGTH} characters`),
    slug: slugShape.optional(),
    excerpt: z
        .string()
        .trim()
        .min(1, 'Excerpt is required')
        .max(MAX_BLOG_EXCERPT_LENGTH, `Excerpt cannot exceed ${MAX_BLOG_EXCERPT_LENGTH} characters`),
    category: z
        .string()
        .trim()
        .min(1, 'Category is required')
        .max(MAX_BLOG_CATEGORY_LENGTH, `Category cannot exceed ${MAX_BLOG_CATEGORY_LENGTH} characters`),
    coverImage: safeUrlSchema().optional(),
    author: z
        .string()
        .trim()
        .max(MAX_BLOG_AUTHOR_LENGTH, `Author cannot exceed ${MAX_BLOG_AUTHOR_LENGTH} characters`)
        .optional(),
    seoTitle: z
        .string()
        .trim()
        .max(MAX_BLOG_SEO_TITLE_LENGTH, `SEO title cannot exceed ${MAX_BLOG_SEO_TITLE_LENGTH} characters`)
        .optional(),
    seoDescription: z
        .string()
        .trim()
        .max(MAX_BLOG_SEO_DESCRIPTION_LENGTH, `SEO description cannot exceed ${MAX_BLOG_SEO_DESCRIPTION_LENGTH} characters`)
        .optional(),
    status: z.enum(['draft', 'published']).optional(),
    publishedAt: z.coerce.date().optional(),
};

/** `POST /api/admin/blog`. */
export const createBlogPostSchema = z.object({
    ...blogFields,
    content: blogContentSchema,
});

/** `PUT /api/admin/blog/:id` — a partial patch. */
export const updateBlogPostSchema = z.object({
    title: blogFields.title.optional(),
    slug: blogFields.slug,
    excerpt: blogFields.excerpt.optional(),
    category: blogFields.category.optional(),
    coverImage: blogFields.coverImage,
    author: blogFields.author,
    seoTitle: blogFields.seoTitle,
    seoDescription: blogFields.seoDescription,
    status: blogFields.status,
    publishedAt: blogFields.publishedAt,
    content: blogContentSchema.optional(),
});

/** `PATCH /api/admin/blog/:id/status` — publish/unpublish. */
export const updateBlogStatusSchema = z.object({
    status: z.enum(['draft', 'published']),
});

export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>;
export type UpdateBlogPostInput = z.infer<typeof updateBlogPostSchema>;
export type UpdateBlogStatusInput = z.infer<typeof updateBlogStatusSchema>;
