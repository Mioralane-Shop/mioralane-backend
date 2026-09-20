import {
    AnnouncementAnimation,
    AnnouncementBackground,
    AnnouncementBarSettings,
    AnnouncementBarSettingsValue,
    AnnouncementDirection,
    AnnouncementMessage,
    DEFAULT_ANNOUNCEMENT_BAR_SETTINGS,
    HEX_COLOR_PATTERN,
} from './announcement-settings.model';

type HttpError = Error & { statusCode?: number; code?: string };

const createAnnouncementError = (statusCode: number, message: string, code?: string): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const ANIMATIONS: AnnouncementAnimation[] = ['slide', 'fade', 'marquee'];
const DIRECTIONS: AnnouncementDirection[] = ['ltr', 'rtl'];
const BACKGROUNDS: AnnouncementBackground[] = ['solid', 'sheen', 'gradient'];
const MAX_MESSAGE_LENGTH = 220;

/** Six digit hex colours only — they are fed straight into the storefront CSS. */
const normalizeColor = (value: unknown, label: string): string => {
    const color = typeof value === 'string' ? value.trim().toUpperCase() : '';

    if (!HEX_COLOR_PATTERN.test(color)) {
        throw createAnnouncementError(
            400,
            `${label} must be a six digit hex value, for example #006400`,
            'invalid_announcement_color'
        );
    }

    return color;
};

const serialize = (
    settings: Partial<AnnouncementBarSettingsValue> | null
): AnnouncementBarSettingsValue => ({
    singletonKey: 'announcement_bar',
    enabled: settings?.enabled ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.enabled,
    messages: (settings?.messages ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.messages).map((message) => ({
        text: message.text,
        url: message.url ?? '',
    })),
    animation: settings?.animation ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.animation,
    direction: settings?.direction ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.direction,
    background: settings?.background ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.background,
    backgroundColor:
        settings?.backgroundColor ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.backgroundColor,
    textColor: settings?.textColor ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.textColor,
    intervalSeconds:
        settings?.intervalSeconds ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.intervalSeconds,
    speedSeconds: settings?.speedSeconds ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.speedSeconds,
});

/** Reads the singleton, creating it with the storefront defaults on first access. */
export const getAnnouncementBarSettings = async (): Promise<AnnouncementBarSettingsValue> => {
    const settings = await AnnouncementBarSettings.findOneAndUpdate(
        { singletonKey: 'announcement_bar' },
        { $setOnInsert: DEFAULT_ANNOUNCEMENT_BAR_SETTINGS },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    )
        .lean()
        .exec();

    return serialize(settings);
};

export const normalizeAnnouncementBarPayload = (
    payload: unknown
): AnnouncementBarSettingsValue => {
    const body = (payload ?? {}) as Partial<AnnouncementBarSettingsValue>;

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: AnnouncementMessage[] = rawMessages
        .map((message) => ({
            text: typeof message?.text === 'string' ? message.text.trim() : '',
            url: typeof message?.url === 'string' ? message.url.trim() : '',
        }))
        .filter((message) => message.text.length > 0);

    if (messages.some((message) => message.text.length > MAX_MESSAGE_LENGTH)) {
        throw createAnnouncementError(
            400,
            `Each message must be ${MAX_MESSAGE_LENGTH} characters or fewer`,
            'invalid_announcement_message'
        );
    }

    if (enabled && messages.length === 0) {
        throw createAnnouncementError(
            400,
            'Add at least one message before enabling the bar',
            'missing_announcement_message'
        );
    }

    const animation = body.animation ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.animation;
    if (!ANIMATIONS.includes(animation)) {
        throw createAnnouncementError(
            400,
            'Animation must be one of slide, fade or marquee',
            'invalid_announcement_animation'
        );
    }

    const direction = body.direction ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.direction;
    if (!DIRECTIONS.includes(direction)) {
        throw createAnnouncementError(
            400,
            'Direction must be ltr or rtl',
            'invalid_announcement_direction'
        );
    }

    const background = body.background ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.background;
    if (!BACKGROUNDS.includes(background)) {
        throw createAnnouncementError(
            400,
            'Background must be one of solid, sheen or gradient',
            'invalid_announcement_background'
        );
    }

    const backgroundColor = normalizeColor(
        body.backgroundColor ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.backgroundColor,
        'Background colour'
    );

    const textColor = normalizeColor(
        body.textColor ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.textColor,
        'Text colour'
    );

    const intervalSeconds = Number(
        body.intervalSeconds ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.intervalSeconds
    );
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 2 || intervalSeconds > 60) {
        throw createAnnouncementError(
            400,
            'Rotate interval must be between 2 and 60 seconds',
            'invalid_announcement_interval'
        );
    }

    const speedSeconds = Number(
        body.speedSeconds ?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.speedSeconds
    );
    if (!Number.isFinite(speedSeconds) || speedSeconds < 6 || speedSeconds > 60) {
        throw createAnnouncementError(
            400,
            'Scroll speed must be between 6 and 60 seconds',
            'invalid_announcement_speed'
        );
    }

    return {
        singletonKey: 'announcement_bar',
        enabled,
        messages,
        animation,
        direction,
        background,
        backgroundColor,
        textColor,
        intervalSeconds,
        speedSeconds,
    };
};

export const upsertAnnouncementBarSettings = async (
    payload: unknown
): Promise<AnnouncementBarSettingsValue> => {
    const normalized = normalizeAnnouncementBarPayload(payload);

    const settings = await AnnouncementBarSettings.findOneAndUpdate(
        { singletonKey: 'announcement_bar' },
        {
            $set: {
                enabled: normalized.enabled,
                messages: normalized.messages,
                animation: normalized.animation,
                direction: normalized.direction,
                background: normalized.background,
                backgroundColor: normalized.backgroundColor,
                textColor: normalized.textColor,
                intervalSeconds: normalized.intervalSeconds,
                speedSeconds: normalized.speedSeconds,
            },
            $setOnInsert: { singletonKey: 'announcement_bar' },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    )
        .lean()
        .exec();

    return serialize(settings);
};
