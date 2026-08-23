import mongoose, { Schema, Document, Model } from 'mongoose';
import { slugify } from '../utils/slugify';

const integerStockValidator = {
  validator: Number.isInteger,
  message: 'Stock must be a non-negative integer',
};

// ─── Types ────────────────────────────────────────────────────────────────

export interface IProduct {
  title: string;
  slug: string;
  brand: string;
  category: string;
  description: string;
  skinType: string[];
  skinConcern: string[];
  price: number;
  salePrice?: number;
  badge?: 'Sale' | 'Best' | 'New';
  images: string[];
  hoverImage?: string;
  volume?: string;
  discountPrice?: number;
  productname?: string;
  stock: number;
  isBestSeller: boolean;
  isNewArrival: boolean;
  isTrending: boolean;
  rating: number;
  numReviews: number;
}

export interface IProductDocument extends IProduct, Document {
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────

const ProductSchema = new Schema<IProductDocument>(
  {
    title: {
      type: String,
      required: [true, 'Product title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },

    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
    },

    brand: {
      type: String,
      required: [true, 'Brand is required'],
      trim: true,
      index: true,
    },

    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
      index: true,
    },

    description: {
      type: String,
      default: '',
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },

    skinType: {
      type: [String],
      default: [],
    },

    skinConcern: {
      type: [String],
      default: [],
    },

    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },

    salePrice: {
      type: Number,
      min: [0, 'Sale price cannot be negative'],
      validate: {
        validator(this: IProductDocument, v: number) {
          return v === undefined || v < this.price;
        },
        message: 'Sale price must be less than the original price',
      },
    },

    badge: {
      type: String,
      default: '',
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
    },

    volume: {
      type: String,
      default: '',
    },

    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock cannot be negative'],
      validate: integerStockValidator,
    },

    isBestSeller: {
      type: Boolean,
      default: false,
    },

    isNewArrival: {
      type: Boolean,
      default: false,
    },

    isTrending: {
      type: Boolean,
      default: false,
    },

    rating: {
      type: Number,
      default: 5.0,
      min: [0, 'Rating cannot be below 0'],
      max: [5, 'Rating cannot exceed 5'],
    },

    numReviews: {
      type: Number,
      default: 0,
      min: [0, 'Review count cannot be negative'],
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
        r.name = r.title;                             // ProductCard renders product.name
        r.concerns = r.skinConcern;                   // ProductCard renders product.concerns
        r.reviewCount = r.numReviews;                 // ProductCard expects reviewCount
        r.description = r.description || '';          // ensure string

        // Derive tag for badge rendering (best > new > sale)
        if (r.isBestSeller || r.badge === 'Best') {
          r.tag = 'best';
        } else if (r.isNewArrival || r.badge === 'New') {
          r.tag = 'new';
        } else {
          r.tag = null;
        }

        // ── Price mapping: if salePrice exists, swap ──
        //    price → discounted selling price, compareAtPrice → original
        if (r.salePrice != null) {
          r.compareAtPrice = r.price;       // original (higher) price
          r.price = r.salePrice;            // current selling price
        } else {
          // Fallback: compute compareAtPrice as ~20% above price
          // so discount badge & strikethrough always render
          r.compareAtPrice = Math.round(r.price * 1.25);
        }
        delete r.salePrice;

        return r;
      },
    },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────

ProductSchema.index({ isBestSeller: 1 });
ProductSchema.index({ isNewArrival: 1 });
ProductSchema.index({ isTrending: 1 });
ProductSchema.index({ brand: 1, category: 1 });
ProductSchema.index({ skinType: 1 });
ProductSchema.index({ skinConcern: 1 });
// Text index for search
ProductSchema.index({ title: 'text', brand: 'text', category: 'text' });

// ─── Pre-save hook: auto-generate slug ────────────────────────────────────

ProductSchema.pre<IProductDocument>('save', async function () {
  if (this.isModified('title') || !this.slug) {
    let baseSlug = slugify(this.title);
    let candidate = baseSlug;
    let counter = 1;

    // Ensure uniqueness
    const Product = mongoose.model('Product') as Model<IProductDocument>;
    while (await Product.findOne({ slug: candidate, _id: { $ne: this._id } })) {
      candidate = `${baseSlug}-${counter}`;
      counter++;
    }

    this.slug = candidate;
  }
});

// ─── Model ────────────────────────────────────────────────────────────────

export const Product: Model<IProductDocument> =
  mongoose.models.Product || mongoose.model<IProductDocument>('Product', ProductSchema);

export default Product;
