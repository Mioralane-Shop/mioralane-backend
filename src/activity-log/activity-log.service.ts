import mongoose from 'mongoose';
import { Request } from 'express';
import { UserModel } from '../auth/user.model';
import { buildPaginatedResult, getPaginationParams, getSkip } from '../utils/pagination';
import {
    ACTIVITY_ACTIONS,
    ACTIVITY_ENTITY_TYPES,
    ActivityAction,
    ActivityActorType,
    ActivityEntityType,
    ActivityLog,
    IActivityLogDocument,
} from './activity-log.model';

type HttpError = Error & { statusCode?: number; code?: string };

export const createActivityLogError = (
    statusCode: number,
    message: string,
    code?: string
): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Sensitive data scrubbing ─────────────────────────────────────────────

const SENSITIVE_KEY_PATTERN =
    /pass(word)?|secret|token|api[-_]?key|credential|authorization|cookie|otp|cvv|cvc|card(number)?|private[-_]?key|signature|jwt|session/i;

const REDACTED = '[redacted]';
const MAX_DEPTH = 5;
const MAX_ARRAY_LENGTH = 50;
const MAX_STRING_LENGTH = 2000;

const isObjectIdLike = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    (value as { _bsontype?: string })._bsontype === 'ObjectId';

/**
 * Recursively scrubs credentials and bounds the payload so a log row can never
 * store a password, a token, or an unbounded document.
 */
export const sanitizeAuditValue = (value: unknown, depth = 0): unknown => {
    if (value === null || value === undefined) {
        return null;
    }

    if (depth > MAX_DEPTH) {
        return '[truncated]';
    }

    if (typeof value === 'string') {
        return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (isObjectIdLike(value)) {
        return value.toString();
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_ARRAY_LENGTH)
            .map((entry) => sanitizeAuditValue(entry, depth + 1));
    }

    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};

        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                result[key] = REDACTED;
                continue;
            }

            if (typeof entry === 'function' || entry === undefined) {
                continue;
            }

            result[key] = sanitizeAuditValue(entry, depth + 1);
        }

        return result;
    }

    return String(value);
};

/** Derived/system fields that would add noise to every update diff. */
const IGNORED_DIFF_FIELDS = new Set([
    '_id',
    '__v',
    'id',
    'createdAt',
    'updatedAt',
    'actorObjectId',
]);

const PRICE_FIELDS = new Set(['price', 'salePrice', 'compareAtPrice', 'savings', 'cost']);
const STOCK_FIELDS = new Set([
    'stock',
    'lowStockThreshold',
    'availabilityMode',
    'preOrder',
    'quantityLimit',
    'reservedQuantity',
]);
const STATUS_FIELDS = new Set([
    'orderStatus',
    'status',
    'isActive',
    'active',
    'paymentStatus',
    'isApproved',
]);

/**
 * Picks a subset of a document for the audit snapshot (create/delete, or the
 * "relevant fields" of an update).
 */
export const pickActivitySnapshot = (
    source: unknown,
    fields?: string[]
): Record<string, unknown> | null => {
    if (!source || typeof source !== 'object') {
        return null;
    }

    const record = source as Record<string, unknown>;
    const keys = fields ?? Object.keys(record);
    const snapshot: Record<string, unknown> = {};

    for (const key of keys) {
        if (IGNORED_DIFF_FIELDS.has(key) || !(key in record)) {
            continue;
        }

        const value = record[key];

        if (value === undefined) {
            continue;
        }

        snapshot[key] = sanitizeAuditValue(value);
    }

    return Object.keys(snapshot).length > 0 ? snapshot : null;
};

export type ActivityChanges = {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** Names of the fields whose values actually differ. */
    changedFields: string[];
};

/**
 * Builds the before/after payload for an update: only the fields that changed,
 * so the log stays small and the UI can render "৳1,200 → ৳1,300".
 */
export const buildActivityChanges = (
    beforeDoc: unknown,
    afterDoc: unknown,
    fields?: string[]
): ActivityChanges => {
    const beforeSource = (beforeDoc && typeof beforeDoc === 'object' ? beforeDoc : {}) as Record<
        string,
        unknown
    >;
    const afterSource = (afterDoc && typeof afterDoc === 'object' ? afterDoc : {}) as Record<
        string,
        unknown
    >;
    const keys =
        fields ??
        Array.from(new Set([...Object.keys(beforeSource), ...Object.keys(afterSource)]));

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const changedFields: string[] = [];

    for (const key of keys) {
        if (IGNORED_DIFF_FIELDS.has(key)) {
            continue;
        }

        const beforeValue = sanitizeAuditValue(beforeSource[key]);
        const afterValue = sanitizeAuditValue(afterSource[key]);

        if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) {
            continue;
        }

        if (key in beforeSource) {
            before[key] = beforeValue;
        }

        if (key in afterSource) {
            after[key] = afterValue;
        }

        changedFields.push(key);
    }

    return {
        before: Object.keys(before).length > 0 ? before : null,
        after: Object.keys(after).length > 0 ? after : null,
        changedFields,
    };
};

/**
 * Chooses the single action code for an edit. A save that only touches prices
 * is a PRICE_CHANGE (not a generic UPDATE) so it is filterable in the UI.
 */
export const resolveUpdateAction = (changedFields: string[]): ActivityAction => {
    if (changedFields.length === 0) {
        return 'UPDATE';
    }

    if (changedFields.every((field) => PRICE_FIELDS.has(field))) {
        return 'PRICE_CHANGE';
    }

    if (changedFields.every((field) => STOCK_FIELDS.has(field))) {
        return 'STOCK_CHANGE';
    }

    if (changedFields.every((field) => STATUS_FIELDS.has(field))) {
        return 'STATUS_CHANGE';
    }

    return 'UPDATE';
};

// ─── Descriptions ─────────────────────────────────────────────────────────

const ENTITY_LABELS: Record<ActivityEntityType, string> = {
    PRODUCT: 'product',
    COMBO: 'combo',
    ORDER: 'order',
    COUPON: 'coupon',
    CAMPAIGN: 'campaign',
    SETTINGS: 'settings',
    INVENTORY: 'inventory',
    PARTICIPANT: 'participant',
    ADMIN: 'admin user',
    ADDRESS: 'address',
    WISHLIST: 'wishlist',
    REVIEW: 'review',
};

const ACTION_VERBS: Record<ActivityAction, string> = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    PRICE_CHANGE: 'Changed the price of',
    STOCK_CHANGE: 'Changed the stock of',
    STATUS_CHANGE: 'Changed the status of',
    LOGIN: 'Signed in',
    LOGOUT: 'Signed out',
    REGISTER: 'Registered',
    CANCEL: 'Cancelled',
};

const buildDefaultDescription = (
    action: ActivityAction,
    entityType: ActivityEntityType,
    entityName?: string,
    actionLabel?: string
): string => {
    const label = ENTITY_LABELS[entityType] ?? entityType.toLowerCase();
    const subject = entityName ? `${label} "${entityName}"` : label;
    const verb = actionLabel ?? ACTION_VERBS[action];

    switch (action) {
        case 'LOGIN':
        case 'LOGOUT':
            return `${verb}${entityName ? ` — ${entityName}` : ''}`;
        case 'REGISTER':
            return `Registered a new ${subject}`;
        case 'CANCEL':
            return `${verb} ${subject}`;
        default:
            return `${verb} ${subject}`;
    }
};

// ─── Actor resolution ─────────────────────────────────────────────────────

export type ActorSnapshot = { name?: string; email?: string };

const ACTOR_CACHE_TTL_MS = 30_000;
const actorCache = new Map<string, { expiresAt: number; snapshot: ActorSnapshot }>();

/**
 * The actor always comes from the authenticated request. Names are cached
 * briefly because admin actions are logged far more often than users change.
 */
const resolveActorSnapshot = async (
    actorId: string,
    provided?: ActorSnapshot
): Promise<ActorSnapshot> => {
    if (provided?.name || provided?.email) {
        return provided;
    }

    const cached = actorCache.get(actorId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.snapshot;
    }

    const user = await UserModel.findById(actorId)
        .select('username email')
        .lean()
        .exec()
        .catch(() => null);

    const snapshot: ActorSnapshot = user
        ? {
            name: (user as { username?: string }).username,
            email: (user as { email?: string }).email,
        }
        : {};

    actorCache.set(actorId, { expiresAt: Date.now() + ACTOR_CACHE_TTL_MS, snapshot });
    return snapshot;
};

const readIpAddress = (req: Request): string | undefined => {
    const forwarded = req.headers['x-forwarded-for'];

    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
        const first = forwarded.split(',')[0]?.trim();
        if (first) {
            return first.slice(0, 100);
        }
    }

    const ip = typeof req.ip === 'string' ? req.ip : '';
    return ip ? ip.slice(0, 100) : undefined;
};

const readUserAgent = (req: Request): string | undefined => {
    const agent = req.headers['user-agent'];
    return typeof agent === 'string' && agent.trim() !== '' ? agent.slice(0, 400) : undefined;
};

// ─── Writing ──────────────────────────────────────────────────────────────

export type RecordActivityInput = {
    action: ActivityAction;
    entityType: ActivityEntityType;
    entityId?: string | null;
    entityName?: string | null;
    /** Overrides the generated sentence, e.g. "Approved review for Serum". */
    description?: string;
    actionLabel?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    /**
     * Actor identity. Defaults to the authenticated request; public endpoints
     * (register/login) pass the user they just authenticated instead, because no
     * session exists yet.
     */
    actor?: { id?: string; role?: string; name?: string; email?: string };
    /** Joins the log to the business write when the caller is in a transaction. */
    session?: mongoose.ClientSession;
};

/**
 * Records one audit entry. Returns null when there is no usable actor (for
 * example an anonymous request hitting a public endpoint).
 */
export const recordActivity = async (
    req: Request,
    input: RecordActivityInput
): Promise<IActivityLogDocument | null> => {
    const actorId = input.actor?.id ?? req.user?.id;
    const actorRole = input.actor?.role ?? req.user?.role;

    if (!actorId || !mongoose.Types.ObjectId.isValid(actorId)) {
        return null;
    }

    const snapshot = await resolveActorSnapshot(actorId, {
        name: input.actor?.name,
        email: input.actor?.email,
    });

    const [created] = await ActivityLog.create(
        [
            {
                actorId: new mongoose.Types.ObjectId(actorId),
                actorType: actorRole === 'admin' ? 'admin' : 'participant',
                actorName: snapshot.name,
                actorEmail: snapshot.email,
                action: input.action,
                entityType: input.entityType,
                entityId: input.entityId ? String(input.entityId) : undefined,
                entityName: input.entityName ? String(input.entityName).slice(0, 300) : undefined,
                description:
                    input.description ??
                    buildDefaultDescription(
                        input.action,
                        input.entityType,
                        input.entityName ?? undefined,
                        input.actionLabel
                    ),
                before: input.before ?? null,
                after: input.after ?? null,
                metadata: input.metadata ? (sanitizeAuditValue(input.metadata) as Record<string, unknown>) : undefined,
                ipAddress: readIpAddress(req),
                userAgent: readUserAgent(req),
            },
        ],
        input.session ? { session: input.session } : {}
    );

    return created ?? null;
};

// ─── Reading ──────────────────────────────────────────────────────────────

export const ACTIVITY_SORTS = ['newest', 'oldest'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

export const normalizeActivitySort = (value: unknown): ActivitySort =>
    value === 'oldest' ? 'oldest' : 'newest';

export const normalizeActivityAction = (value: unknown): ActivityAction => {
    if (typeof value === 'string' && (ACTIVITY_ACTIONS as readonly string[]).includes(value)) {
        return value as ActivityAction;
    }

    throw createActivityLogError(
        400,
        `action must be one of: ${ACTIVITY_ACTIONS.join(', ')}`,
        'invalid_activity_action'
    );
};

export const normalizeActivityEntityType = (value: unknown): ActivityEntityType => {
    if (typeof value === 'string' && (ACTIVITY_ENTITY_TYPES as readonly string[]).includes(value)) {
        return value as ActivityEntityType;
    }

    throw createActivityLogError(
        400,
        `entityType must be one of: ${ACTIVITY_ENTITY_TYPES.join(', ')}`,
        'invalid_activity_entity_type'
    );
};

export type ActivityLogQuery = {
    actorId?: string;
    action?: ActivityAction[];
    entityType?: ActivityEntityType[];
    entityId?: string;
    from?: string;
    to?: string;
    search?: string;
    sort?: ActivitySort;
    page?: unknown;
    limit?: unknown;
};

export type ActivityLogView = Record<string, unknown> & { id: string; actorId: string };

const readDate = (value: string | undefined, label: string): Date | undefined => {
    if (!value) {
        return undefined;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        throw createActivityLogError(400, `${label} must be a valid date`, 'invalid_date');
    }

    return parsed;
};

const buildActivityFilter = (
    actorType: ActivityActorType,
    query: ActivityLogQuery
): Record<string, unknown> => {
    // Scope first: an admin never sees participant rows through the wrong route
    // (and vice versa) because the actor type is not client-controlled.
    const filter: Record<string, unknown> = { actorType };

    if (query.actorId) {
        if (!mongoose.Types.ObjectId.isValid(query.actorId)) {
            throw createActivityLogError(400, 'A valid actorId is required', 'invalid_actor_id');
        }

        filter.actorId = new mongoose.Types.ObjectId(query.actorId);
    }

    if (query.action?.length) {
        filter.action = { $in: query.action };
    }

    if (query.entityType?.length) {
        filter.entityType = { $in: query.entityType };
    }

    if (query.entityId) {
        filter.entityId = query.entityId;
    }

    const from = readDate(query.from, 'from');
    const to = readDate(query.to, 'to');

    if (from || to) {
        filter.createdAt = {
            ...(from ? { $gte: from } : {}),
            ...(to ? { $lte: to } : {}),
        };
    }

    if (query.search?.trim()) {
        const regex = new RegExp(escapeRegex(query.search.trim()), 'i');
        filter.$or = [
            { description: regex },
            { entityName: regex },
            { actorName: regex },
            { actorEmail: regex },
        ];
    }

    return filter;
};

export const listActivityLogs = async (
    actorType: ActivityActorType,
    query: ActivityLogQuery
): Promise<{
    items: ActivityLogView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}> => {
    const filter = buildActivityFilter(actorType, query);
    const pagination = getPaginationParams(query.page as number, (query.limit as number) ?? 25);
    const direction = normalizeActivitySort(query.sort) === 'oldest' ? 1 : -1;

    const [documents, total] = await Promise.all([
        ActivityLog.find(filter)
            .sort({ createdAt: direction, _id: direction })
            .skip(getSkip(pagination))
            .limit(pagination.limit)
            .exec(),
        ActivityLog.countDocuments(filter),
    ]);

    return buildPaginatedResult(
        documents.map((document) => document.toObject() as unknown as ActivityLogView),
        total,
        pagination
    );
};

export const getActivityLogById = async (
    activityId: string,
    actorType: ActivityActorType
): Promise<ActivityLogView> => {
    if (!activityId || !mongoose.Types.ObjectId.isValid(activityId)) {
        throw createActivityLogError(400, 'A valid activity id is required', 'invalid_activity_id');
    }

    const document = await ActivityLog.findOne({
        _id: new mongoose.Types.ObjectId(activityId),
        actorType,
    }).exec();

    if (!document) {
        throw createActivityLogError(404, 'Activity log entry not found', 'activity_not_found');
    }

    return document.toObject() as unknown as ActivityLogView;
};

/** Distinct actors that appear in a feed, for the "filter by admin" select. */
export const listActivityActors = async (
    actorType: ActivityActorType,
    limit = 200
): Promise<Array<{ id: string; name?: string; email?: string }>> => {
    const rows = await ActivityLog.aggregate([
        { $match: { actorType } },
        { $sort: { createdAt: -1 } },
        {
            $group: {
                _id: '$actorId',
                name: { $first: '$actorName' },
                email: { $first: '$actorEmail' },
            },
        },
        { $sort: { name: 1 } },
        { $limit: limit },
    ]);

    return rows.map((row) => ({
        id: String(row._id),
        name: row.name ?? undefined,
        email: row.email ?? undefined,
    }));
};
