import { slugify } from '../utils/slugify';
import {
    DEFAULT_MEGA_MENU_SETTINGS,
    MAX_MEGA_MENU_GROUP_LENGTH,
    MAX_MEGA_MENU_ITEMS_PER_TAB,
    MAX_MEGA_MENU_ITEM_LABEL_LENGTH,
    MAX_MEGA_MENU_MAX_ITEMS,
    MAX_MEGA_MENU_TARGET_VALUE_LENGTH,
    MEGA_MENU_TAB_IDS,
    MEGA_MENU_TARGET_KINDS,
    MegaMenuItem,
    MegaMenuSettings,
    MegaMenuSettingsValue,
    MegaMenuTab,
    MegaMenuTabId,
    MegaMenuTargetKind,
    cloneMegaMenuTab,
} from './mega-menu-settings.model';

type HttpError = Error & { statusCode?: number; code?: string };

const createMegaMenuError = (statusCode: number, message: string, code?: string): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const isTabId = (value: unknown): value is MegaMenuTabId =>
    typeof value === 'string' && (MEGA_MENU_TAB_IDS as readonly string[]).includes(value);

const isTargetKind = (value: unknown): value is MegaMenuTargetKind =>
    typeof value === 'string' && (MEGA_MENU_TARGET_KINDS as readonly string[]).includes(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * A stable, unique id within the tab. The admin always sends one; this only
 * rescues hand-rolled clients that omit it, without ever producing duplicates
 * that would break React keys or reorder operations.
 */
const resolveItemId = (candidate: unknown, label: string, usedIds: Set<string>): string => {
    let base =
        typeof candidate === 'string' && candidate.trim()
            ? candidate.trim()
            : slugify(label) || 'item';

    base = base.slice(0, MAX_MEGA_MENU_ITEM_LABEL_LENGTH);

    let id = base;
    let suffix = 2;

    while (usedIds.has(id)) {
        const suffixText = `-${suffix}`;
        id = `${base.slice(0, MAX_MEGA_MENU_ITEM_LABEL_LENGTH - suffixText.length)}${suffixText}`;
        suffix += 1;
    }

    usedIds.add(id);
    return id;
};

/**
 * Returns `null` for a row that is genuinely empty (blank label), matching the
 * announcement bar's "blank rows are dropped, not rejected" rule. A row with a
 * label but no usable destination IS an error: it would render a dead link.
 */
const normalizeItem = (
    rawItem: unknown,
    usedIds: Set<string>
): MegaMenuItem | null => {
    const item = asRecord(rawItem);
    const label = typeof item.label === 'string' ? item.label.trim() : '';

    if (!label) return null;

    if (label.length > MAX_MEGA_MENU_ITEM_LABEL_LENGTH) {
        throw createMegaMenuError(
            400,
            `Item label must be ${MAX_MEGA_MENU_ITEM_LABEL_LENGTH} characters or fewer`,
            'invalid_mega_menu_item_label'
        );
    }

    const target = asRecord(item.target);
    const kind = target.kind;
    const value = typeof target.value === 'string' ? target.value.trim() : '';

    if (!isTargetKind(kind)) {
        throw createMegaMenuError(
            400,
            `Item "${label}" must pick a destination type`,
            'invalid_mega_menu_item_target'
        );
    }

    if (!value) {
        throw createMegaMenuError(
            400,
            `Item "${label}" must have a destination`,
            'missing_mega_menu_item_target'
        );
    }

    if (value.length > MAX_MEGA_MENU_TARGET_VALUE_LENGTH) {
        throw createMegaMenuError(
            400,
            `Item "${label}" destination must be ${MAX_MEGA_MENU_TARGET_VALUE_LENGTH} characters or fewer`,
            'invalid_mega_menu_item_target'
        );
    }

    const rawGroup = typeof item.group === 'string' ? item.group.trim() : '';

    if (rawGroup.length > MAX_MEGA_MENU_GROUP_LENGTH) {
        throw createMegaMenuError(
            400,
            `Item "${label}" group must be ${MAX_MEGA_MENU_GROUP_LENGTH} characters or fewer`,
            'invalid_mega_menu_item_group'
        );
    }

    return {
        id: resolveItemId(item.id, label, usedIds),
        label,
        target: { kind, value },
        group: rawGroup || undefined,
        visible: typeof item.visible === 'boolean' ? item.visible : true,
    };
};

const normalizeTab = (id: MegaMenuTabId, rawTab: unknown, fallback: MegaMenuTab): MegaMenuTab => {
    // A tab the client did not send keeps its seeded contents entirely. Only an
    // explicitly-sent tab (even with `items: []`) is treated as an edit, so a
    // partial payload can never silently empty the storefront menu.
    if (rawTab === undefined) {
        return cloneMegaMenuTab(fallback);
    }

    const tab = asRecord(rawTab);

    const label = typeof tab.label === 'string' && tab.label.trim() ? tab.label.trim() : fallback.label;

    if (label.length > MAX_MEGA_MENU_ITEM_LABEL_LENGTH) {
        throw createMegaMenuError(
            400,
            `Tab label must be ${MAX_MEGA_MENU_ITEM_LABEL_LENGTH} characters or fewer`,
            'invalid_mega_menu_tab_label'
        );
    }

    const maxItems = tab.maxItems === undefined ? fallback.maxItems : Number(tab.maxItems);

    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_MEGA_MENU_MAX_ITEMS) {
        throw createMegaMenuError(
            400,
            `Max items must be a whole number between 1 and ${MAX_MEGA_MENU_MAX_ITEMS}`,
            'invalid_mega_menu_max_items'
        );
    }

    if (tab.items !== undefined && !Array.isArray(tab.items)) {
        throw createMegaMenuError(400, 'Tab items must be an array', 'invalid_mega_menu_items');
    }

    const rawItems = Array.isArray(tab.items) ? tab.items : [];

    if (rawItems.length > MAX_MEGA_MENU_ITEMS_PER_TAB) {
        throw createMegaMenuError(
            400,
            `A tab can hold at most ${MAX_MEGA_MENU_ITEMS_PER_TAB} items`,
            'too_many_mega_menu_items'
        );
    }

    const usedIds = new Set<string>();
    const items = rawItems
        .map((rawItem) => normalizeItem(rawItem, usedIds))
        .filter((item): item is MegaMenuItem => item !== null);

    return {
        id,
        label,
        maxItems,
        grouped: typeof tab.grouped === 'boolean' ? tab.grouped : fallback.grouped,
        items,
    };
};

/**
 * Turns a request body into the full settings document.
 *
 * A payload that omits `tabs` (or a tab) resets that part to the seeded defaults,
 * so a partial payload can never leave the storefront menu empty. An unknown or
 * duplicated tab id is refused rather than silently ignored.
 */
export const normalizeMegaMenuPayload = (payload: unknown): MegaMenuSettingsValue => {
    const body = asRecord(payload);

    if (body.tabs === undefined) {
        return {
            singletonKey: 'mega_menu',
            tabs: DEFAULT_MEGA_MENU_SETTINGS.tabs.map(cloneMegaMenuTab),
        };
    }

    if (!Array.isArray(body.tabs)) {
        throw createMegaMenuError(400, 'Tabs must be an array', 'invalid_mega_menu_tabs');
    }

    const provided = new Map<MegaMenuTabId, unknown>();

    for (const rawTab of body.tabs) {
        const id = asRecord(rawTab).id;

        if (!isTabId(id)) {
            throw createMegaMenuError(
                400,
                `Each tab id must be one of: ${MEGA_MENU_TAB_IDS.join(', ')}`,
                'invalid_mega_menu_tab'
            );
        }

        if (provided.has(id)) {
            throw createMegaMenuError(
                400,
                `Tab "${id}" was sent more than once`,
                'duplicate_mega_menu_tab'
            );
        }

        provided.set(id, rawTab);
    }

    // Always emit the three tabs, in the model's canonical order, so the
    // storefront contract does not depend on the order the client sent them in.
    const tabs = DEFAULT_MEGA_MENU_SETTINGS.tabs.map((fallback) =>
        normalizeTab(fallback.id, provided.get(fallback.id), fallback)
    );

    return { singletonKey: 'mega_menu', tabs };
};

export const serializeMegaMenuSettings = (
    settings?: Partial<MegaMenuSettingsValue> | null
): MegaMenuSettingsValue => ({
    singletonKey: 'mega_menu',
    tabs:
        settings?.tabs && settings.tabs.length > 0
            ? settings.tabs.map(cloneMegaMenuTab)
            : DEFAULT_MEGA_MENU_SETTINGS.tabs.map(cloneMegaMenuTab),
});

export type StorefrontMegaMenuItem = {
    id: string;
    label: string;
    target: { kind: MegaMenuTargetKind; value: string };
    group?: string;
};

export type StorefrontMegaMenuTab = {
    id: MegaMenuTabId;
    label: string;
    maxItems: number;
    grouped: boolean;
    items: StorefrontMegaMenuItem[];
};

export type StorefrontMegaMenu = {
    tabs: StorefrontMegaMenuTab[];
};

/**
 * The public payload: hidden items removed, and a tab with nothing visible is
 * dropped entirely so the storefront never renders an empty tab (or an empty
 * panel if every item in every tab is hidden).
 */
export const serializeMegaMenuForStorefront = (
    settings: MegaMenuSettingsValue
): StorefrontMegaMenu => ({
    tabs: settings.tabs
        .map((tab) => ({
            id: tab.id,
            label: tab.label,
            maxItems: tab.maxItems,
            grouped: tab.grouped,
            items: tab.items
                .filter((item) => item.visible)
                .map((item) => ({
                    id: item.id,
                    label: item.label,
                    target: { kind: item.target.kind, value: item.target.value },
                    group: item.group,
                })),
        }))
        .filter((tab) => tab.items.length > 0),
});

/** Reads the singleton, creating it with the seeded menu on first access. */
export const getMegaMenu = async (): Promise<MegaMenuSettingsValue> => {
    const settings = await MegaMenuSettings.findOneAndUpdate(
        { singletonKey: 'mega_menu' },
        { $setOnInsert: DEFAULT_MEGA_MENU_SETTINGS },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    )
        .lean()
        .exec();

    return serializeMegaMenuSettings(settings);
};

export const upsertMegaMenuSettings = async (payload: unknown): Promise<MegaMenuSettingsValue> => {
    const normalized = normalizeMegaMenuPayload(payload);

    const settings = await MegaMenuSettings.findOneAndUpdate(
        { singletonKey: 'mega_menu' },
        {
            $set: { tabs: normalized.tabs },
            $setOnInsert: { singletonKey: 'mega_menu' },
        },
        { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true }
    )
        .lean()
        .exec();

    return serializeMegaMenuSettings(settings);
};
