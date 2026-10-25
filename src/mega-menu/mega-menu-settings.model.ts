import mongoose, { Document, Schema } from 'mongoose';

/**
 * Storefront "Shop" mega menu — a single admin-curated document.
 *
 * The menu is deliberately NOT derived from product data: `category`,
 * `skinConcern` and friends are free-form strings on the product/combo models
 * (see `product.schemas.ts`), so there is no taxonomy to group by. This singleton
 * is the editor's content, not a view over the catalog.
 *
 * Tabs are a fixed set of three (`MEGA_MENU_TAB_IDS`); only their label, cap and
 * item list are editable. Items carry a structured `target` rather than a raw
 * href so the storefront can compose (and encode) the URL and an admin can pick
 * a destination from a list instead of typing a query string.
 */

export const MEGA_MENU_TAB_IDS = ['product', 'concern', 'ingredient'] as const;
export type MegaMenuTabId = (typeof MEGA_MENU_TAB_IDS)[number];

export const MEGA_MENU_TARGET_KINDS = [
  'category',
  'concern',
  'ingredient',
  'skinType',
  'brand',
  'search',
] as const;
export type MegaMenuTargetKind = (typeof MEGA_MENU_TARGET_KINDS)[number];

export type MegaMenuTarget = {
  kind: MegaMenuTargetKind;
  value: string;
};

export type MegaMenuItem = {
  id: string;
  label: string;
  target: MegaMenuTarget;
  /** Optional grouping label (routine step, benefit, A–Z bucket). */
  group?: string;
  visible: boolean;
};

export type MegaMenuTab = {
  id: MegaMenuTabId;
  label: string;
  maxItems: number;
  grouped: boolean;
  items: MegaMenuItem[];
};

export type MegaMenuSettingsValue = {
  singletonKey: 'mega_menu';
  tabs: MegaMenuTab[];
};

export interface IMegaMenuSettingsDocument extends MegaMenuSettingsValue, Document {
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_MEGA_MENU_ITEM_LABEL_LENGTH = 80;
export const MAX_MEGA_MENU_GROUP_LENGTH = 80;
export const MAX_MEGA_MENU_TARGET_VALUE_LENGTH = 120;
export const MAX_MEGA_MENU_ITEMS_PER_TAB = 100;
export const MAX_MEGA_MENU_MAX_ITEMS = 30;

/**
 * Seeded with the storefront's previous hard-coded menu, so switching to the
 * dynamic version is visually a no-op. `group` values are pre-filled for the
 * product tab (routine step) but inert until `grouped` is switched on.
 */
export const DEFAULT_MEGA_MENU_TABS: MegaMenuTab[] = [
  {
    id: 'product',
    label: 'By Product',
    maxItems: 6,
    grouped: false,
    items: [
      { id: 'cleansers', label: 'Cleansers', target: { kind: 'category', value: 'cleansers' }, group: 'Cleanse', visible: true },
      { id: 'toners', label: 'Toners', target: { kind: 'category', value: 'toners' }, group: 'Tone', visible: true },
      { id: 'treatments', label: 'Treatments', target: { kind: 'category', value: 'serums' }, group: 'Treat', visible: true },
      { id: 'moisturizers', label: 'Moisturizers', target: { kind: 'category', value: 'moisturizers' }, group: 'Moisturize', visible: true },
      { id: 'sunscreens', label: 'Sunscreens', target: { kind: 'category', value: 'sun-care' }, group: 'Protect', visible: true },
      { id: 'masks', label: 'Masks', target: { kind: 'category', value: 'masks' }, group: 'Treat', visible: true },
    ],
  },
  {
    id: 'concern',
    label: 'By Concern',
    maxItems: 6,
    grouped: false,
    items: [
      { id: 'acne', label: 'Acne', target: { kind: 'concern', value: 'acne' }, visible: true },
      { id: 'anti-aging', label: 'Anti-Aging', target: { kind: 'concern', value: 'anti-aging' }, visible: true },
      { id: 'hyperpigmentation', label: 'Hyperpigmentation', target: { kind: 'concern', value: 'hyperpigmentation' }, visible: true },
      { id: 'dry-skin', label: 'Dry Skin', target: { kind: 'concern', value: 'dry-skin' }, visible: true },
      { id: 'oily-skin', label: 'Oily Skin', target: { kind: 'concern', value: 'oily-skin' }, visible: true },
      { id: 'sensitive-skin', label: 'Sensitive Skin', target: { kind: 'concern', value: 'sensitive' }, visible: true },
    ],
  },
  {
    id: 'ingredient',
    label: 'By Ingredient',
    maxItems: 6,
    grouped: false,
    items: [
      { id: 'snail-mucin', label: 'Snail Mucin', target: { kind: 'ingredient', value: 'snail mucin' }, visible: true },
      { id: 'centella', label: 'Centella', target: { kind: 'ingredient', value: 'centella' }, visible: true },
      { id: 'hyaluronic-acid', label: 'Hyaluronic Acid', target: { kind: 'ingredient', value: 'hyaluronic acid' }, visible: true },
      { id: 'aha-bha-pha', label: 'AHA BHA PHA', target: { kind: 'ingredient', value: 'aha bha pha' }, visible: true },
      { id: 'retinol', label: 'Retinol', target: { kind: 'ingredient', value: 'retinol' }, visible: true },
      { id: 'vitamin-c', label: 'Vitamin C', target: { kind: 'ingredient', value: 'vitamin c' }, visible: true },
    ],
  },
];

export const DEFAULT_MEGA_MENU_SETTINGS: MegaMenuSettingsValue = {
  singletonKey: 'mega_menu',
  tabs: DEFAULT_MEGA_MENU_TABS,
};

/** Deep clone so a caller can never mutate the module-level defaults. */
export const cloneMegaMenuTab = (tab: MegaMenuTab): MegaMenuTab => ({
  id: tab.id,
  label: tab.label,
  maxItems: tab.maxItems,
  grouped: tab.grouped,
  items: tab.items.map((item) => ({
    id: item.id,
    label: item.label,
    target: { kind: item.target.kind, value: item.target.value },
    group: item.group,
    visible: item.visible,
  })),
});

const MegaMenuTargetSchema = new Schema<MegaMenuTarget>(
  {
    kind: {
      type: String,
      enum: [...MEGA_MENU_TARGET_KINDS],
      required: true,
    },
    value: {
      type: String,
      required: true,
      trim: true,
      maxlength: [MAX_MEGA_MENU_TARGET_VALUE_LENGTH, 'Destination value is too long'],
    },
  },
  { _id: false }
);

const MegaMenuItemSchema = new Schema<MegaMenuItem>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: [MAX_MEGA_MENU_ITEM_LABEL_LENGTH, 'Item id is too long'],
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: [MAX_MEGA_MENU_ITEM_LABEL_LENGTH, 'Item label is too long'],
    },
    target: {
      type: MegaMenuTargetSchema,
      required: true,
    },
    group: {
      type: String,
      trim: true,
      default: undefined,
      maxlength: [MAX_MEGA_MENU_GROUP_LENGTH, 'Group label is too long'],
    },
    visible: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  { _id: false }
);

const MegaMenuTabSchema = new Schema<MegaMenuTab>(
  {
    id: {
      type: String,
      enum: [...MEGA_MENU_TAB_IDS],
      required: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: [MAX_MEGA_MENU_ITEM_LABEL_LENGTH, 'Tab label is too long'],
    },
    maxItems: {
      type: Number,
      required: true,
      default: 6,
      min: [1, 'Max items must be at least 1'],
      max: [MAX_MEGA_MENU_MAX_ITEMS, `Max items must be ${MAX_MEGA_MENU_MAX_ITEMS} or fewer`],
      validate: {
        validator: Number.isInteger,
        message: 'Max items must be a whole number',
      },
    },
    grouped: {
      type: Boolean,
      default: false,
      required: true,
    },
    items: {
      type: [MegaMenuItemSchema],
      default: [],
    },
  },
  { _id: false }
);

const MegaMenuSettingsSchema = new Schema<IMegaMenuSettingsDocument>(
  {
    singletonKey: {
      type: String,
      enum: ['mega_menu'],
      default: 'mega_menu',
      unique: true,
      index: true,
      immutable: true,
    },
    tabs: {
      type: [MegaMenuTabSchema],
      default: () => DEFAULT_MEGA_MENU_TABS.map(cloneMegaMenuTab),
    },
  },
  { timestamps: true }
);

export const MegaMenuSettings =
  mongoose.models.MegaMenuSettings ||
  mongoose.model<IMegaMenuSettingsDocument>('MegaMenuSettings', MegaMenuSettingsSchema);
