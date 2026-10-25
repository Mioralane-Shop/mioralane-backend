import mongoose, { Document, Schema } from 'mongoose';

/**
 * A blog article — an independent entity, not a settings singleton.
 *
 * `content` stores the editor's structured Tiptap JSON document, never HTML.
 * The storefront renders it through a node-type allowlist (`blog-renderer.tsx`
 * in the frontend), so an unknown node type stored by a future editor version
 * degrades to "not rendered" rather than becoming arbitrary markup. The request
 * schema (`blog.schemas.ts`) validates the same structure on the way in.
 */

/** Title ceiling, in characters. */
export const MAX_BLOG_TITLE_LENGTH = 160;
/** Excerpt ceiling. */
export const MAX_BLOG_EXCERPT_LENGTH = 300;
/** Category ceiling. */
export const MAX_BLOG_CATEGORY_LENGTH = 60;
/** Author display-name ceiling. */
export const MAX_BLOG_AUTHOR_LENGTH = 80;
/** SEO title ceiling (a good page title). */
export const MAX_BLOG_SEO_TITLE_LENGTH = 70;
/** SEO meta description ceiling. */
export const MAX_BLOG_SEO_DESCRIPTION_LENGTH = 200;
/** Slug ceiling. */
export const MAX_BLOG_SLUG_LENGTH = 200;

export type BlogStatus = 'draft' | 'published';

/** The loose shape of a Tiptap JSON node. */
export interface TiptapMark {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface TiptapNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: TiptapNode[];
    text?: string;
    marks?: TiptapMark[];
}

export interface TiptapDoc {
    type: 'doc';
    content?: TiptapNode[];
}

export interface IBlogPost {
    title: string;
    /** Unique, lower-case handle. Derived from `title` when the client omits it. */
    slug: string;
    /** Short summary shown on cards and in meta descriptions when none is set. */
    excerpt: string;
    category: string;
    /** ImageKit URL shown as the article's social/cover image. Optional. */
    coverImage?: string;
    /** The structured Tiptap JSON document. */
    content: TiptapDoc;
    /** Display name, e.g. "Mioralane Team". */
    author: string;
    /** Optional page `<title>`. Falls back to `title` when absent. */
    seoTitle?: string;
    /** Optional meta description. Falls back to `excerpt` when absent. */
    seoDescription?: string;
    status: BlogStatus;
    /** Set when first published; kept when unpublished so re-publishing is stable. */
    publishedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

export type IBlogPostDocument = IBlogPost & Document;

const BlogPostSchema = new Schema<IBlogPostDocument>(
    {
        title: {
            type: String,
            required: [true, 'Title is required'],
            trim: true,
            maxlength: [MAX_BLOG_TITLE_LENGTH, `Title cannot exceed ${MAX_BLOG_TITLE_LENGTH} characters`],
        },
        slug: {
            type: String,
            required: [true, 'Slug is required'],
            trim: true,
            lowercase: true,
            maxlength: [MAX_BLOG_SLUG_LENGTH, `Slug cannot exceed ${MAX_BLOG_SLUG_LENGTH} characters`],
        },
        excerpt: {
            type: String,
            required: [true, 'Excerpt is required'],
            trim: true,
            maxlength: [MAX_BLOG_EXCERPT_LENGTH, `Excerpt cannot exceed ${MAX_BLOG_EXCERPT_LENGTH} characters`],
        },
        category: {
            type: String,
            required: [true, 'Category is required'],
            trim: true,
            maxlength: [MAX_BLOG_CATEGORY_LENGTH, `Category cannot exceed ${MAX_BLOG_CATEGORY_LENGTH} characters`],
        },
        coverImage: {
            type: String,
            trim: true,
            default: '',
        },
        content: {
            type: Schema.Types.Mixed,
            default: { type: 'doc', content: [] },
        },
        author: {
            type: String,
            trim: true,
            default: 'Mioralane Team',
            maxlength: [MAX_BLOG_AUTHOR_LENGTH, `Author cannot exceed ${MAX_BLOG_AUTHOR_LENGTH} characters`],
        },
        seoTitle: {
            type: String,
            trim: true,
            maxlength: [MAX_BLOG_SEO_TITLE_LENGTH, `SEO title cannot exceed ${MAX_BLOG_SEO_TITLE_LENGTH} characters`],
        },
        seoDescription: {
            type: String,
            trim: true,
            maxlength: [MAX_BLOG_SEO_DESCRIPTION_LENGTH, `SEO description cannot exceed ${MAX_BLOG_SEO_DESCRIPTION_LENGTH} characters`],
        },
        status: {
            type: String,
            enum: ['draft', 'published'],
            default: 'draft',
            index: true,
        },
        publishedAt: {
            type: Date,
        },
    },
    { timestamps: true }
);

/** One article per slug, enforced by the database. */
BlogPostSchema.index({ slug: 1 }, { unique: true });

BlogPostSchema.set('toJSON', {
    transform(_doc, ret) {
        const r = ret as unknown as Record<string, unknown> & {
            _id?: { toString: () => string };
            __v?: unknown;
        };
        r.id = r._id?.toString();
        delete r._id;
        delete r.__v;
        return r;
    },
});

export const BlogPost: mongoose.Model<IBlogPostDocument> =
    mongoose.models.BlogPost ||
    mongoose.model<IBlogPostDocument>('BlogPost', BlogPostSchema);

export default BlogPost;
