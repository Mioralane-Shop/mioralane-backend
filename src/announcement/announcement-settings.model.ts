import mongoose, { Document, Schema } from 'mongoose';

export type AnnouncementAnimation = 'slide' | 'fade' | 'marquee';
export type AnnouncementDirection = 'ltr' | 'rtl';
/** Colour treatment of the strip itself. */
export type AnnouncementBackground = 'solid' | 'sheen' | 'gradient';

export type AnnouncementMessage = {
    text: string;
    url?: string;
};

export type AnnouncementBarSettingsValue = {
    singletonKey: 'announcement_bar';
    enabled: boolean;
    messages: AnnouncementMessage[];
    animation: AnnouncementAnimation;
    direction: AnnouncementDirection;
    background: AnnouncementBackground;
    backgroundColor: string;
    textColor: string;
    intervalSeconds: number;
    speedSeconds: number;
};

export interface IAnnouncementBarSettingsDocument extends AnnouncementBarSettingsValue, Document {
    createdAt: Date;
    updatedAt: Date;
}

export const DEFAULT_ANNOUNCEMENT_BAR_SETTINGS: AnnouncementBarSettingsValue = {
    singletonKey: 'announcement_bar',
    enabled: true,
    messages: [
        { text: 'discount on up to 2000 taka purchase', url: '' },
        { text: 'Cash on Delivery available', url: '' },
    ],
    animation: 'marquee',
    direction: 'rtl',
    background: 'sheen',
    backgroundColor: '#006400',
    textColor: '#FFEE32',
    intervalSeconds: 4,
    speedSeconds: 18,
};

/** Six digit hex colours only — the storefront feeds these straight into CSS. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const MAX_MESSAGE_LENGTH = 220;

const AnnouncementMessageSchema = new Schema<AnnouncementMessage>(
    {
        text: {
            type: String,
            required: true,
            trim: true,
            maxlength: [MAX_MESSAGE_LENGTH, `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`],
        },
        url: { type: String, trim: true, default: '' },
    },
    { _id: false }
);

const AnnouncementBarSettingsSchema = new Schema<IAnnouncementBarSettingsDocument>(
    {
        singletonKey: {
            type: String,
            enum: ['announcement_bar'],
            default: 'announcement_bar',
            unique: true,
            index: true,
            immutable: true,
        },
        enabled: {
            type: Boolean,
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.enabled,
            required: true,
        },
        messages: {
            type: [AnnouncementMessageSchema],
            default: () => DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.messages.map((message) => ({ ...message })),
        },
        animation: {
            type: String,
            enum: ['slide', 'fade', 'marquee'],
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.animation,
            required: true,
        },
        direction: {
            type: String,
            enum: ['ltr', 'rtl'],
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.direction,
            required: true,
        },
        background: {
            type: String,
            enum: ['solid', 'sheen', 'gradient'],
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.background,
            required: true,
        },
        backgroundColor: {
            type: String,
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.backgroundColor,
            required: true,
            match: [HEX_COLOR_PATTERN, 'Background colour must be a six digit hex value'],
        },
        textColor: {
            type: String,
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.textColor,
            required: true,
            match: [HEX_COLOR_PATTERN, 'Text colour must be a six digit hex value'],
        },
        intervalSeconds: {
            type: Number,
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.intervalSeconds,
            required: true,
            min: [2, 'Rotate interval must be at least 2 seconds'],
            max: [60, 'Rotate interval must be 60 seconds or fewer'],
        },
        speedSeconds: {
            type: Number,
            default: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.speedSeconds,
            required: true,
            min: [6, 'Scroll speed must be at least 6 seconds'],
            max: [60, 'Scroll speed must be 60 seconds or fewer'],
        },
    },
    { timestamps: true }
);

// A row that was left blank in the admin form should never reach the storefront.
AnnouncementBarSettingsSchema.pre('validate', function dropBlankMessages() {
    const kept = (this.messages ?? []).filter((message) => message?.text?.trim());

    if (kept.length === 0 && this.enabled) {
        throw new Error('Add at least one message before enabling the bar');
    }

    this.set({ messages: kept });
});

export const AnnouncementBarSettings =
    mongoose.models.AnnouncementBarSettings ||
    mongoose.model<IAnnouncementBarSettingsDocument>(
        'AnnouncementBarSettings',
        AnnouncementBarSettingsSchema
    );
