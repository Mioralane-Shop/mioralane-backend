import mongoose, { Document, Schema } from 'mongoose';

/** Action codes stay coarse on purpose — the description carries the detail. */
export const ACTIVITY_ACTIONS = [
    'CREATE',
    'UPDATE',
    'DELETE',
    'PRICE_CHANGE',
    'STOCK_CHANGE',
    'STATUS_CHANGE',
    'LOGIN',
    'LOGOUT',
    'REGISTER',
    'CANCEL',
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const ACTIVITY_ENTITY_TYPES = [
    'PRODUCT',
    'COMBO',
    'ORDER',
    'COUPON',
    'CAMPAIGN',
    'SETTINGS',
    'INVENTORY',
    'PARTICIPANT',
    'ADMIN',
    'ADDRESS',
    'WISHLIST',
    'REVIEW',
] as const;

export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/**
 * Who the actor is. `admin` entries are only visible in the admin activity
 * feed, `participant` entries only in the participant feed.
 */
export const ACTIVITY_ACTOR_TYPES = ['admin', 'participant'] as const;

export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

export interface IActivityLog {
    actorId: mongoose.Types.ObjectId;
    actorType: ActivityActorType;
    /** Identity snapshot — the user may be renamed or removed later. */
    actorName?: string;
    actorEmail?: string;
    action: ActivityAction;
    entityType: ActivityEntityType;
    entityId?: string;
    entityName?: string;
    description?: string;
    /** Only the fields that actually changed (or the removed snapshot). */
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
    createdAt: Date;
    updatedAt: Date;
}

export type IActivityLogDocument = IActivityLog &
    Document & { _id: mongoose.Types.ObjectId };

const applyActivityLogAliases = (
    _doc: unknown,
    ret: Record<string, unknown>
): Record<string, unknown> => {
    const r = ret as Record<string, unknown> & {
        _id?: { toString: () => string };
        actorId?: { toString: () => string };
    };

    if (r._id) {
        r.id = r._id.toString();
        delete r._id;
    }

    if (r.actorId) {
        r.actorId = r.actorId.toString();
        r.actorObjectId = r.actorId;
    }

    delete r.__v;

    return r;
};

const ActivityLogSchema = new Schema<IActivityLogDocument>(
    {
        actorId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'An activity log requires an actor'],
            index: true,
        },
        actorType: {
            type: String,
            enum: ACTIVITY_ACTOR_TYPES,
            required: true,
            index: true,
        },
        actorName: { type: String, trim: true, maxlength: 200 },
        actorEmail: { type: String, trim: true, maxlength: 320 },
        action: {
            type: String,
            enum: ACTIVITY_ACTIONS,
            required: true,
        },
        entityType: {
            type: String,
            enum: ACTIVITY_ENTITY_TYPES,
            required: true,
        },
        entityId: { type: String, trim: true, maxlength: 120 },
        entityName: { type: String, trim: true, maxlength: 300 },
        description: { type: String, trim: true, maxlength: 1000 },
        before: { type: Schema.Types.Mixed, default: null },
        after: { type: Schema.Types.Mixed, default: null },
        metadata: { type: Schema.Types.Mixed, default: undefined },
        ipAddress: { type: String, trim: true, maxlength: 100 },
        userAgent: { type: String, trim: true, maxlength: 400 },
    },
    {
        timestamps: true,
        // API responses serialize with toJSON, the service builds views from
        // toObject() — both need the same aliases.
        toJSON: { transform: applyActivityLogAliases },
        toObject: { transform: applyActivityLogAliases },
    }
);

// Feed queries always scope by actor type first, then sort by time.
ActivityLogSchema.index({ actorType: 1, createdAt: -1 });
ActivityLogSchema.index({ actorId: 1, createdAt: -1 });
ActivityLogSchema.index({ action: 1, createdAt: -1 });
ActivityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const IMMUTABLE_MESSAGE =
    'Activity logs are audit records and cannot be modified or deleted. Record a new activity instead.';

/**
 * Audit integrity: activity logs are append-only.
 *
 * Mongoose 9 query middleware is promise based — throwing rejects the query.
 */
const blockActivityLogMutation = async function (): Promise<void> {
    throw new Error(IMMUTABLE_MESSAGE);
};

ActivityLogSchema.pre('save', async function () {
    if (!this.isNew) {
        throw new Error(IMMUTABLE_MESSAGE);
    }
});

ActivityLogSchema.pre('updateOne', blockActivityLogMutation);
ActivityLogSchema.pre('updateMany', blockActivityLogMutation);
ActivityLogSchema.pre('findOneAndUpdate', blockActivityLogMutation);
ActivityLogSchema.pre('findOneAndReplace', blockActivityLogMutation);
ActivityLogSchema.pre('replaceOne', blockActivityLogMutation);
ActivityLogSchema.pre('deleteOne', blockActivityLogMutation);
ActivityLogSchema.pre('deleteMany', blockActivityLogMutation);
ActivityLogSchema.pre('findOneAndDelete', blockActivityLogMutation);

export const ActivityLog =
    mongoose.models.ActivityLog ||
    mongoose.model<IActivityLogDocument>('ActivityLog', ActivityLogSchema);

export default ActivityLog;
