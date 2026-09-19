import mongoose, { Document, Schema } from 'mongoose';

export type InventoryItemType = 'product' | 'combo';

/**
 * Every meaningful stock movement. `previousQuantity` + `quantityChange` always
 * add up to `newQuantity`, so the ledger explains how the current stock got to
 * its value instead of only recording deltas.
 */
export const INVENTORY_TRANSACTION_TYPES = [
    'STOCK_IN',
    'STOCK_OUT',
    'ORDER_DEDUCTION',
    'CANCELLATION_RESTORATION',
    'MANUAL_ADJUSTMENT',
    'DAMAGED',
    'LOST',
    'RESTOCK',
] as const;

export type InventoryTransactionType = (typeof INVENTORY_TRANSACTION_TYPES)[number];

/** Who caused the movement — used so the ledger is readable in the admin UI. */
export type InventoryActorRole = 'admin' | 'customer' | 'system';

export type InventoryReferenceType = 'order' | 'catalog_editor' | 'manual';

export interface IInventoryTransaction {
    itemId: mongoose.Types.ObjectId;
    itemType: InventoryItemType;
    transactionType: InventoryTransactionType;
    /** Signed change: positive adds stock, negative removes it. */
    quantityChange: number;
    previousQuantity: number;
    newQuantity: number;
    reason?: string;
    note?: string;
    referenceType?: InventoryReferenceType;
    referenceId?: string;
    performedBy?: mongoose.Types.ObjectId;
    performedByRole?: InventoryActorRole;
}

export interface IInventoryTransactionDocument extends IInventoryTransaction, Document {
    createdAt: Date;
    updatedAt: Date;
}

const applyInventoryTransactionAliases = (
    _doc: unknown,
    ret: Record<string, unknown>
): Record<string, unknown> => {
    const r = ret as Record<string, unknown> & {
        _id?: { toString: () => string };
        itemId?: { toString: () => string };
        performedBy?: { toString: () => string };
    };

    if (r._id) {
        r.id = r._id.toString();
        delete r._id;
    }

    delete r.__v;

    if (r.itemId) {
        r.itemId = r.itemId.toString();
    }

    if (r.performedBy && typeof r.performedBy === 'object') {
        r.performedById = r.performedBy.toString();
    }

    return r;
};

const InventoryTransactionSchema = new Schema<IInventoryTransactionDocument>(
    {
        itemId: {
            type: Schema.Types.ObjectId,
            required: [true, 'Inventory item reference is required'],
            index: true,
        },
        itemType: {
            type: String,
            enum: ['product', 'combo'],
            required: [true, 'Inventory item type is required'],
        },
        transactionType: {
            type: String,
            enum: INVENTORY_TRANSACTION_TYPES,
            required: [true, 'Transaction type is required'],
        },
        quantityChange: {
            type: Number,
            required: [true, 'Quantity change is required'],
            validate: {
                validator: Number.isInteger,
                message: 'Quantity change must be a whole number',
            },
        },
        previousQuantity: {
            type: Number,
            required: true,
            min: [0, 'Previous quantity cannot be negative'],
            validate: {
                validator: Number.isInteger,
                message: 'Previous quantity must be a whole number',
            },
        },
        newQuantity: {
            type: Number,
            required: true,
            min: [0, 'New quantity cannot be negative'],
            validate: {
                validator: Number.isInteger,
                message: 'New quantity must be a whole number',
            },
        },
        reason: {
            type: String,
            trim: true,
            maxlength: [300, 'Reason cannot exceed 300 characters'],
            default: undefined,
        },
        note: {
            type: String,
            trim: true,
            maxlength: [1000, 'Note cannot exceed 1000 characters'],
            default: undefined,
        },
        referenceType: {
            type: String,
            enum: ['order', 'catalog_editor', 'manual'],
            default: undefined,
        },
        referenceId: {
            type: String,
            trim: true,
            default: undefined,
        },
        performedBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            default: undefined,
        },
        performedByRole: {
            type: String,
            enum: ['admin', 'customer', 'system'],
            default: undefined,
        },
    },
    {
        timestamps: true,
        // Both aliases matter: API responses serialize with toJSON, while the
        // inventory service builds its views from toObject().
        toJSON: { transform: applyInventoryTransactionAliases },
        toObject: { transform: applyInventoryTransactionAliases },
    }
);

// Item history (the "why is stock N?" query).
InventoryTransactionSchema.index({ itemType: 1, itemId: 1, createdAt: -1 });
// Global admin list + type/actor filters.
InventoryTransactionSchema.index({ createdAt: -1 });
InventoryTransactionSchema.index({ transactionType: 1, createdAt: -1 });
InventoryTransactionSchema.index({ performedBy: 1, createdAt: -1 });

/**
 * Idempotency guard for order-scoped movements: an order can deduct or restore
 * stock for a given item exactly once. Re-running the cancellation (or a retried
 * checkout) can never add a second entry for the same order + item.
 */
InventoryTransactionSchema.index(
    {
        referenceType: 1,
        referenceId: 1,
        transactionType: 1,
        itemType: 1,
        itemId: 1,
    },
    {
        unique: true,
        partialFilterExpression: { referenceType: 'order' },
    }
);

const IMMUTABLE_MESSAGE =
    'Inventory transactions are audit records and cannot be modified or deleted. Record a compensating transaction instead.';

/**
 * Audit integrity: the ledger is append-only. Corrections are new transactions
 * (for example +5 after a mistaken -5), never edits of existing rows.
 *
 * Mongoose 9 query middleware is promise based — throwing rejects the query.
 */
const blockInventoryTransactionMutation = async function (): Promise<void> {
    throw new Error(IMMUTABLE_MESSAGE);
};

InventoryTransactionSchema.pre('updateOne', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('updateMany', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('findOneAndUpdate', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('findOneAndReplace', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('replaceOne', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('deleteOne', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('deleteMany', blockInventoryTransactionMutation);
InventoryTransactionSchema.pre('findOneAndDelete', blockInventoryTransactionMutation);

export const InventoryTransaction =
    mongoose.models.InventoryTransaction ||
    mongoose.model<IInventoryTransactionDocument>('InventoryTransaction', InventoryTransactionSchema);

export default InventoryTransaction;
