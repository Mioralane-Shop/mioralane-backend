import mongoose, { Schema, Document, Model } from 'mongoose';
import { slugify } from '../utils/slugify';

const integerStockValidator = {
    validator: Number.isInteger,
    message: 'Stock must be a non-negative integer',
};

// ─── Types ────────────────────────────────────────────────────────────────

export interface ICombo {
    title: string;
    slug: string;
    badge: string;                // Image badge label — e.g. "MORNING PACK", "ACNE COMBO", "TRAVEL KIT"
    description: string;
    price: number;                // Bundle price (discounted)
    compareAtPrice: number;       // Original total if bought separately
    savings: number;              // Amount saved — stored but also computed on output
    includedItems: string[];      // e.g. ["Cleanser", "Toner", "Serum", "Moisturizer", "Sunscreen"]
    routineTag: string;           // e.g. "For Glass Skin", "For Acne Care"
    category: string;             // Always "combo" — for frontend filtering
    brand: string;                // "Mioralane Bundle"
    images: string[];
    hoverImage?: string;         // Alternate image shown on hover — same as Product model
    size: string;                 // e.g. "5-piece set" — used by comboSetLabel on the frontend
    volume: string;               // Same as size, aliased for frontend compatibility
    stock: number;
    rating: number;
    numReviews: number;
    concerns: string[];           // e.g. ["Complete Routine", "Best Value"]
    skinType: string;             // e.g. "All skin types", "Oily / Acne-prone"
    isBestSeller: boolean;
    isNewArrival: boolean;
}

export interface IComboDocument extends ICombo, Document {
    createdAt: Date;
    updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────

const ComboSchema = new Schema<IComboDocument>(
    {
        title: {
            type: String,
            required: [true, 'Combo title is required'],
            trim: true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
        },

        slug: {
            type: String,
            unique: true,
            lowercase: true,
            trim: true,
        },

        badge: {
            type: String,
            default: '',
            trim: true,
        },

        description: {
            type: String,
            default: '',
            maxlength: [2000, 'Description cannot exceed 2000 characters'],
        },

        price: {
            type: Number,
            required: [true, 'Price is required'],
            min: [0, 'Price cannot be negative'],
        },

        compareAtPrice: {
            type: Number,
            min: [0, 'Compare-at price cannot be negative'],
            default: 0,
        },

        savings: {
            type: Number,
            min: [0, 'Savings cannot be negative'],
            default: 0,
        },

        includedItems: {
            type: [String],
            default: [],
        },

        routineTag: {
            type: String,
            default: '',
            trim: true,
        },

        category: {
            type: String,
            default: 'combo',
            trim: true,
            index: true,
        },

        brand: {
            type: String,
            default: 'Mioralane Bundle',
            trim: true,
        },

        images: {
            type: [String],
            required: [true, 'At least one image is required'],
            validate: {
                validator: (v: string[]) => v.length > 0,
                message: 'At least one image URL is required',
            },
        },

        hoverImage: {
            type: String,
            default: '',
            trim: true,
        },

        size: {
            type: String,
            default: '',
            trim: true,
        },

        volume: {
            type: String,
            default: '',
            trim: true,
        },

        stock: {
            type: Number,
            default: 0,
            min: [0, 'Stock cannot be negative'],
            validate: integerStockValidator,
        },

        rating: {
            type: Number,
            default: 0,
            min: [0, 'Rating cannot be below 0'],
            max: [5, 'Rating cannot exceed 5'],
        },

        numReviews: {
            type: Number,
            default: 0,
            min: [0, 'Review count cannot be negative'],
        },

        concerns: {
            type: [String],
            default: [],
        },

        skinType: {
            type: String,
            default: 'All skin types',
            trim: true,
        },

        isBestSeller: {
            type: Boolean,
            default: false,
        },

        isNewArrival: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const r = ret as any;

                // Standard ID mapping
                r.id = r._id.toString();
                delete r._id;
                delete r.__v;

                // ── Field aliases for frontend ProductCard compatibility ──
                r.name = r.title;                            // ProductCard renders product.name
                r.reviewCount = r.numReviews;                // ProductCard expects reviewCount

                // Volume: fall back to size if volume is empty
                if (!r.volume && r.size) {
                    r.volume = r.size;
                }
                if (!r.size && r.volume) {
                    r.size = r.volume;
                }

                // Savings: compute from compareAtPrice if not explicitly stored
                if (!r.savings && r.compareAtPrice > r.price) {
                    r.savings = r.compareAtPrice - r.price;
                }

                if (!r.compareAtPrice && r.savings > 0) {
                    r.compareAtPrice = r.price + r.savings;
                }

                // Derive tag for badge rendering
                if (r.isBestSeller) {
                    r.tag = 'best';
                } else if (r.isNewArrival) {
                    r.tag = 'new';
                } else {
                    r.tag = null;
                }

                return r;
            },
        },
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────

ComboSchema.index({ title: 'text', brand: 'text', category: 'text' });

// ─── Pre-save hook: auto-generate slug ────────────────────────────────────

ComboSchema.pre<IComboDocument>('save', async function () {
    if (this.isModified('title') || !this.slug) {
        let baseSlug = slugify(this.title);
        let candidate = baseSlug;
        let counter = 1;

        const Combo = mongoose.model('Combo') as Model<IComboDocument>;
        while (await Combo.findOne({ slug: candidate, _id: { $ne: this._id } })) {
            candidate = `${baseSlug}-${counter}`;
            counter++;
        }

        this.slug = candidate;
    }
});

// ─── Model ────────────────────────────────────────────────────────────────

export const Combo: Model<IComboDocument> =
    mongoose.models.Combo || mongoose.model<IComboDocument>('Combo', ComboSchema);

export default Combo;
