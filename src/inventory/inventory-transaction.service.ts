import mongoose from 'mongoose';
import Product from '../product/product.model';
import Combo from '../combo/combo.model';
import { UserModel } from '../auth/user.model';
import { buildPaginatedResult, getPaginationParams, getSkip } from '../utils/pagination';
import {
    INVENTORY_TRANSACTION_TYPES,
    InventoryActorRole,
    InventoryItemType,
    InventoryReferenceType,
    InventoryTransaction,
    InventoryTransactionType,
} from './inventory-transaction.model';
import {
    StockStatus,
    getEffectiveLowStockThreshold,
    getInventorySettings,
    getStockStatus,
} from './inventory.service';

type HttpError = Error & { statusCode?: number; code?: string };

export const createInventoryTransactionError = (
    statusCode: number,
    message: string,
    code?: string
): HttpError => {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

export const INVENTORY_TRANSACTION_META: Record<
    InventoryTransactionType,
    { label: string; defaultReason: string; direction: 'increase' | 'decrease' | 'both' }
> = {
    STOCK_IN: {
        label: 'Stock In',
        defaultReason: 'New inventory received',
        direction: 'increase',
    },
    RESTOCK: {
        label: 'Restock',
        defaultReason: 'Supplier restock received',
        direction: 'increase',
    },
    STOCK_OUT: {
        label: 'Stock Out',
        defaultReason: 'Stock removed from availability',
        direction: 'decrease',
    },
    ORDER_DEDUCTION: {
        label: 'Order Deduction',
        defaultReason: 'Customer order',
        direction: 'decrease',
    },
    CANCELLATION_RESTORATION: {
        label: 'Cancellation Restoration',
        defaultReason: 'Order cancelled',
        direction: 'increase',
    },
    MANUAL_ADJUSTMENT: {
        label: 'Manual Adjustment',
        defaultReason: 'Manual stock correction',
        direction: 'both',
    },
    DAMAGED: {
        label: 'Damaged',
        defaultReason: 'Damaged stock written off',
        direction: 'decrease',
    },
    LOST: {
        label: 'Lost',
        defaultReason: 'Stock reported lost or missing',
        direction: 'decrease',
    },
};

/** Types an admin can trigger directly through the inventory endpoints. */
export const MANUAL_INVENTORY_TRANSACTION_TYPES: InventoryTransactionType[] = [
    'STOCK_IN',
    'RESTOCK',
    'STOCK_OUT',
    'DAMAGED',
    'LOST',
    'MANUAL_ADJUSTMENT',
];

export const INVENTORY_SORTS = ['newest', 'oldest'] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];

export const normalizeInventoryItemType = (value: unknown): InventoryItemType => {
    if (value === 'combo') {
        return 'combo';
    }

    if (value === 'product') {
        return 'product';
    }

    throw createInventoryTransactionError(
        400,
        'itemType must be product or combo',
        'invalid_inventory_item_type'
    );
};

export const normalizeInventoryTransactionType = (value: unknown): InventoryTransactionType => {
    if (typeof value === 'string' && (INVENTORY_TRANSACTION_TYPES as readonly string[]).includes(value)) {
        return value as InventoryTransactionType;
    }

    throw createInventoryTransactionError(
        400,
        `transactionType must be one of: ${INVENTORY_TRANSACTION_TYPES.join(', ')}`,
        'invalid_transaction_type'
    );
};

export const normalizeInventorySort = (value: unknown): InventorySort =>
    value === 'oldest' ? 'oldest' : 'newest';

export const toInventoryObjectId = (value: string, label: string): mongoose.Types.ObjectId => {
    if (!value || !mongoose.Types.ObjectId.isValid(value)) {
        throw createInventoryTransactionError(400, `A valid ${label} is required`, 'invalid_inventory_id');
    }

    return new mongoose.Types.ObjectId(value);
};

const inventoryItemLabel = (itemType: InventoryItemType) =>
    itemType === 'combo' ? 'Combo' : 'Product';

/**
 * Products and combos share the fields the ledger touches (stock/title), but
 * their model generics differ — this keeps the shared helpers readable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InventoryItemModel = mongoose.Model<any>;

const resolveItemModel = (itemType: InventoryItemType): InventoryItemModel =>
    itemType === 'combo' ? (Combo as InventoryItemModel) : (Product as InventoryItemModel);

const readNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const readOptionalString = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
};

const isDuplicateKeyError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: number }).code === 11000 ||
        /E11000/.test((error as { message?: string }).message ?? ''));

const isTransactionUnsupportedError = (error: unknown): boolean =>
    error instanceof Error &&
    /transaction numbers are only allowed|replica set|mongos|Transaction numbers/i.test(error.message);

// ─── Record ───────────────────────────────────────────────────────────────

export type RecordInventoryTransactionInput = {
    itemId: mongoose.Types.ObjectId;
    itemType: InventoryItemType;
    transactionType: InventoryTransactionType;
    quantityChange: number;
    previousQuantity: number;
    newQuantity: number;
    reason?: string;
    note?: string;
    referenceType?: InventoryReferenceType;
    referenceId?: string;
    performedBy?: mongoose.Types.ObjectId | string;
    performedByRole?: InventoryActorRole;
    session?: mongoose.ClientSession;
};

/**
 * Writes one ledger row. Returns `null` when an identical order-scoped movement
 * already exists, which makes retries/cancellation replays safe.
 */
export const recordInventoryTransaction = async (
    input: RecordInventoryTransactionInput
): Promise<Record<string, unknown> | null> => {
    const template = {
        itemId: input.itemId,
        itemType: input.itemType,
        transactionType: input.transactionType,
        quantityChange: input.quantityChange,
        previousQuantity: input.previousQuantity,
        newQuantity: input.newQuantity,
        reason:
            readOptionalString(input.reason, 300) ?? INVENTORY_TRANSACTION_META[input.transactionType].defaultReason,
        note: readOptionalString(input.note, 1000),
        referenceType: input.referenceType,
        referenceId: readOptionalString(input.referenceId, 120),
        performedBy: input.performedBy,
        performedByRole: input.performedByRole,
    };

    try {
        const [created] = await InventoryTransaction.create([template], {
            session: input.session,
        });

        return created.toObject() as Record<string, unknown>;
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            return null;
        }

        throw error;
    }
};

// ─── Atomic stock application ─────────────────────────────────────────────

export type ApplyStockDeltaInput = {
    itemId: mongoose.Types.ObjectId;
    itemType: InventoryItemType;
    /** Signed change applied to the item's current stock. */
    quantityChange: number;
    transactionType: InventoryTransactionType;
    reason?: string;
    note?: string;
    referenceType?: InventoryReferenceType;
    referenceId?: string;
    performedBy?: mongoose.Types.ObjectId | string;
    performedByRole?: InventoryActorRole;
    /** Compare-and-set guard: only applies when stock still equals this value. */
    expectedPrevious?: number;
    session?: mongoose.ClientSession;
};

export type ApplyStockDeltaResult = {
    itemId: string;
    itemType: InventoryItemType;
    previousQuantity: number;
    quantityChange: number;
    newQuantity: number;
    /** Null when the movement was already recorded (idempotent replay). */
    transaction: Record<string, unknown> | null;
};

/**
 * Applies a stock delta and records the matching ledger entry.
 *
 * The update uses a single guarded `$inc` (compare-and-set on the previous
 * quantity) so two concurrent operations can never both write from the same
 * previous value, and the ledger's `previousQuantity`/`newQuantity` are derived
 * from the database result rather than from a stale application-side read.
 */
export const applyStockDelta = async (
    input: ApplyStockDeltaInput
): Promise<ApplyStockDeltaResult> => {
    if (!Number.isInteger(input.quantityChange) || input.quantityChange === 0) {
        throw createInventoryTransactionError(
            400,
            'quantityChange must be a non-zero whole number',
            'invalid_quantity_change'
        );
    }

    const model = resolveItemModel(input.itemType);

    // Never allow stock below zero: a decrease carries a floor on the current
    // stock, applied together with (not instead of) the compare-and-set guard.
    const floor = input.quantityChange < 0 ? Math.abs(input.quantityChange) : 0;

    const conditions: Record<string, unknown>[] = [];
    if (input.expectedPrevious !== undefined) {
        conditions.push({ stock: input.expectedPrevious });
    }
    if (floor > 0) {
        conditions.push({ stock: { $gte: floor } });
    }

    const filter: Record<string, unknown> = { _id: input.itemId };
    if (conditions.length === 1) {
        Object.assign(filter, conditions[0]);
    } else if (conditions.length > 1) {
        filter.$and = conditions;
    }

    const updated = await model
        .findOneAndUpdate(
            filter,
            { $inc: { stock: input.quantityChange } },
            { new: true, session: input.session }
        )
        .select('stock title name')
        .exec();

    if (!updated) {
        const existing = await model
            .findById(input.itemId)
            .select('stock title name')
            .session(input.session ?? null)
            .exec();

        if (!existing) {
            throw createInventoryTransactionError(
                404,
                `${inventoryItemLabel(input.itemType)} not found`,
                'inventory_item_not_found'
            );
        }

        const available = readNumber(existing.stock);
        const label = inventoryItemLabel(input.itemType).toLowerCase();

        if (floor > 0 && available < floor) {
            throw createInventoryTransactionError(
                409,
                `Not enough stock for this ${label}. Available: ${available}`,
                'insufficient_stock'
            );
        }

        if (input.expectedPrevious !== undefined) {
            throw createInventoryTransactionError(
                409,
                'Stock changed while this operation was being applied. Please retry.',
                'stock_conflict'
            );
        }

        throw createInventoryTransactionError(
            409,
            `Not enough stock for this ${label}. Available: ${available}`,
            'insufficient_stock'
        );
    }

    const newQuantity = readNumber((updated as unknown as { stock: number }).stock);
    const previousQuantity = newQuantity - input.quantityChange;

    const transaction = await recordInventoryTransaction({
        ...input,
        previousQuantity,
        newQuantity,
    });

    return {
        itemId: input.itemId.toString(),
        itemType: input.itemType,
        previousQuantity,
        quantityChange: input.quantityChange,
        newQuantity,
        transaction,
    };
};

// ─── Admin manual operations ──────────────────────────────────────────────

export type ManualInventoryOperationInput = {
    itemType: InventoryItemType;
    itemId: string;
    transactionType: InventoryTransactionType;
    /** Positive quantity for directional types (stock in/out/restock/damaged/lost). */
    quantity?: number;
    /** Absolute resulting quantity — only for MANUAL_ADJUSTMENT. */
    targetStock?: number;
    reason?: string;
    note?: string;
    actorId: string;
    actorRole: InventoryActorRole;
};

const readPositiveInteger = (value: unknown, label: string): number => {
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
        throw createInventoryTransactionError(400, `${label} must be a whole number`, 'invalid_quantity');
    }

    if (parsed <= 0) {
        throw createInventoryTransactionError(400, `${label} must be greater than zero`, 'invalid_quantity');
    }

    return parsed;
};

const readNonNegativeInteger = (value: unknown, label: string): number => {
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
        throw createInventoryTransactionError(400, `${label} must be a whole number`, 'invalid_quantity');
    }

    if (parsed < 0) {
        throw createInventoryTransactionError(400, `${label} cannot be negative`, 'invalid_quantity');
    }

    return parsed;
};

/**
 * Admin-triggered stock movement. Runs the stock update and the ledger entry in
 * one Mongo transaction, so a failure can never leave one without the other.
 */
export const applyManualInventoryOperation = async (
    input: ManualInventoryOperationInput
): Promise<{
    itemId: string;
    itemType: InventoryItemType;
    previousQuantity: number;
    quantityChange: number;
    newQuantity: number;
    transactionType: InventoryTransactionType;
}> => {
    if (!MANUAL_INVENTORY_TRANSACTION_TYPES.includes(input.transactionType)) {
        throw createInventoryTransactionError(
            400,
            `${input.transactionType} cannot be applied manually. Allowed: ${MANUAL_INVENTORY_TRANSACTION_TYPES.join(', ')}`,
            'unsupported_transaction_type'
        );
    }

    const itemObjectId = toInventoryObjectId(input.itemId, 'itemId');
    const model = resolveItemModel(input.itemType);
    const isAdjustment = input.transactionType === 'MANUAL_ADJUSTMENT';

    if (isAdjustment && input.targetStock === undefined) {
        throw createInventoryTransactionError(
            400,
            'targetStock is required for a manual adjustment',
            'missing_target_stock'
        );
    }

    if (!isAdjustment && input.quantity === undefined) {
        throw createInventoryTransactionError(400, 'quantity is required', 'missing_quantity');
    }

    const explicitQuantity = isAdjustment ? undefined : readPositiveInteger(input.quantity, 'Quantity');
    const targetStock = isAdjustment
        ? readNonNegativeInteger(input.targetStock, 'Target stock')
        : undefined;

    // Direction comes from the transaction type: stock-out, damaged and lost all
    // take a positive admin input but reduce stock.
    const direction = INVENTORY_TRANSACTION_META[input.transactionType].direction;

    const session = await mongoose.startSession();

    try {
        const result = await session.withTransaction(async () => {
            const item = await model
                .findById(itemObjectId)
                .select('stock title')
                .session(session)
                .exec();

            if (!item) {
                throw createInventoryTransactionError(
                    404,
                    `${inventoryItemLabel(input.itemType)} not found`,
                    'inventory_item_not_found'
                );
            }

            const previousQuantity = readNumber((item as unknown as { stock: number }).stock);
            const quantityChange =
                targetStock !== undefined
                    ? targetStock - previousQuantity
                    : direction === 'decrease'
                        ? -(explicitQuantity as number)
                        : (explicitQuantity as number);

            if (quantityChange === 0) {
                throw createInventoryTransactionError(
                    400,
                    'Stock is already at the requested quantity',
                    'no_stock_change'
                );
            }

            return applyStockDelta({
                itemId: itemObjectId,
                itemType: input.itemType,
                quantityChange,
                transactionType: input.transactionType,
                reason: input.reason,
                note: input.note,
                referenceType: 'manual',
                performedBy: input.actorId,
                performedByRole: input.actorRole,
                expectedPrevious: previousQuantity,
                session,
            });
        });

        return {
            itemId: result.itemId,
            itemType: result.itemType,
            previousQuantity: result.previousQuantity,
            quantityChange: result.quantityChange,
            newQuantity: result.newQuantity,
            transactionType: input.transactionType,
        };
    } catch (error) {
        if (isTransactionUnsupportedError(error)) {
            throw createInventoryTransactionError(
                503,
                'Inventory changes cannot be applied safely: MongoDB transactions are unavailable in this deployment.',
                'transactions_unsupported'
            );
        }

        throw error;
    } finally {
        await session.endSession();
    }
};

// ─── Catalog editor / pre-order arrival ───────────────────────────────────

export type CatalogStockChangeInput = {
    itemType: InventoryItemType;
    itemId: string;
    previousStock: number;
    nextStock: number;
    transactionType?: InventoryTransactionType;
    reason?: string;
    referenceType?: InventoryReferenceType;
    performedBy?: mongoose.Types.ObjectId | string;
    performedByRole?: InventoryActorRole;
    session?: mongoose.ClientSession;
};

/**
 * Ledgers a stock change that happens alongside other catalog fields (product or
 * combo editor, pre-order arrival). The CAS guard keeps concurrent edits safe.
 */
export const applyCatalogStockChange = async (
    input: CatalogStockChangeInput
): Promise<ApplyStockDeltaResult | null> => {
    const quantityChange = input.nextStock - input.previousStock;

    if (quantityChange === 0) {
        return null;
    }

    return applyStockDelta({
        itemId: toInventoryObjectId(input.itemId, 'itemId'),
        itemType: input.itemType,
        quantityChange,
        transactionType: input.transactionType ?? 'MANUAL_ADJUSTMENT',
        reason: input.reason,
        referenceType: input.referenceType ?? 'catalog_editor',
        performedBy: input.performedBy,
        performedByRole: input.performedByRole,
        expectedPrevious: input.previousStock,
        session: input.session,
    });
};

// ─── Order deduction + cancellation restoration ───────────────────────────

export type OrderItemStockLine = {
    itemType: InventoryItemType;
    itemId: string;
    quantity: number;
};

/**
 * Ledgers the stock a checkout just deducted. Runs inside the order transaction,
 * so a failed order leaves no inventory transaction behind.
 */
export const recordOrderStockDeductions = async (
    orderId: string,
    customerId: string,
    lines: OrderItemStockLine[],
    session: mongoose.ClientSession
): Promise<void> => {
    for (const line of lines) {
        const itemObjectId = toInventoryObjectId(line.itemId, 'itemId');
        const item = await resolveItemModel(line.itemType)
            .findById(itemObjectId)
            .select('stock')
            .session(session)
            .exec();

        if (!item) {
            throw createInventoryTransactionError(
                404,
                `${inventoryItemLabel(line.itemType)} not found while recording inventory`,
                'inventory_item_not_found'
            );
        }

        const newQuantity = readNumber((item as unknown as { stock: number }).stock);

        await recordInventoryTransaction({
            itemId: itemObjectId,
            itemType: line.itemType,
            transactionType: 'ORDER_DEDUCTION',
            quantityChange: -line.quantity,
            previousQuantity: newQuantity + line.quantity,
            newQuantity,
            referenceType: 'order',
            referenceId: orderId,
            performedBy: customerId,
            performedByRole: 'customer',
            session,
        });
    }
};

/**
 * Ledgers restored stock for a cancelled order. Idempotent twice over: the
 * `referenceType + referenceId + itemId + itemType` unique index rejects a
 * repeated restoration, and the caller only restores once per order.
 */
export const recordCancellationRestorations = async (
    orderId: string,
    actorId: string,
    actorRole: InventoryActorRole,
    lines: OrderItemStockLine[],
    session: mongoose.ClientSession
): Promise<void> => {
    for (const line of lines) {
        const itemObjectId = toInventoryObjectId(line.itemId, 'itemId');
        const item = await resolveItemModel(line.itemType)
            .findById(itemObjectId)
            .select('stock')
            .session(session)
            .exec();

        if (!item) {
            throw createInventoryTransactionError(
                404,
                `${inventoryItemLabel(line.itemType)} not found while restoring inventory`,
                'inventory_item_not_found'
            );
        }

        const newQuantity = readNumber((item as unknown as { stock: number }).stock);

        await recordInventoryTransaction({
            itemId: itemObjectId,
            itemType: line.itemType,
            transactionType: 'CANCELLATION_RESTORATION',
            quantityChange: line.quantity,
            previousQuantity: newQuantity - line.quantity,
            newQuantity,
            referenceType: 'order',
            referenceId: orderId,
            performedBy: actorId,
            performedByRole: actorRole,
            session,
        });
    }
};

// ─── Queries ──────────────────────────────────────────────────────────────

export type InventoryTransactionQuery = {
    itemType?: InventoryItemType;
    itemId?: string;
    transactionType?: InventoryTransactionType[];
    performedBy?: string;
    from?: string;
    to?: string;
    sort?: InventorySort;
    page?: unknown;
    limit?: unknown;
};

export type InventoryTransactionView = Record<string, unknown> & {
    id: string;
    itemName: string;
    performedByName?: string;
};

const buildTransactionFilter = (query: InventoryTransactionQuery): Record<string, unknown> => {
    const filter: Record<string, unknown> = {};

    if (query.itemType) {
        filter.itemType = query.itemType;
    }

    if (query.itemId) {
        filter.itemId = toInventoryObjectId(query.itemId, 'itemId');
    }

    if (query.transactionType?.length) {
        filter.transactionType = { $in: query.transactionType };
    }

    if (query.performedBy) {
        filter.performedBy = toInventoryObjectId(query.performedBy, 'performedBy');
    }

    const createdAt: Record<string, Date> = {};
    if (query.from) {
        const from = new Date(query.from);
        if (Number.isNaN(from.getTime())) {
            throw createInventoryTransactionError(400, 'from must be a valid date', 'invalid_date');
        }
        createdAt.$gte = from;
    }
    if (query.to) {
        const to = new Date(query.to);
        if (Number.isNaN(to.getTime())) {
            throw createInventoryTransactionError(400, 'to must be a valid date', 'invalid_date');
        }
        createdAt.$lte = to;
    }
    if (Object.keys(createdAt).length > 0) {
        filter.createdAt = createdAt;
    }

    return filter;
};

/** Attaches item names and actor names so the admin list is readable. */
const decorateTransactions = async (
    transactions: Array<Record<string, unknown> & { itemId?: unknown; performedBy?: unknown }>
): Promise<InventoryTransactionView[]> => {
    const productIds = transactions
        .filter((t) => t.itemType === 'product' && t.itemId)
        .map((t) => t.itemId as mongoose.Types.ObjectId);
    const comboIds = transactions
        .filter((t) => t.itemType === 'combo' && t.itemId)
        .map((t) => t.itemId as mongoose.Types.ObjectId);
    const userIds = transactions
        .filter((t) => t.performedBy)
        .map((t) => t.performedBy as mongoose.Types.ObjectId);

    const [products, combos, users] = await Promise.all([
        productIds.length
            ? Product.find({ _id: { $in: productIds } })
                .select('title slug')
                .lean()
                .exec()
            : Promise.resolve([]),
        comboIds.length
            ? Combo.find({ _id: { $in: comboIds } })
                .select('title slug')
                .lean()
                .exec()
            : Promise.resolve([]),
        userIds.length
            ? UserModel.find({ _id: { $in: userIds } })
                .select('username email')
                .lean()
                .exec()
            : Promise.resolve([]),
    ]);

    const itemNames = new Map<string, string>();
    for (const doc of products) {
        itemNames.set(`product:${doc._id.toString()}`, (doc as { title?: string }).title ?? 'Product');
    }
    for (const doc of combos) {
        itemNames.set(`combo:${doc._id.toString()}`, (doc as { title?: string }).title ?? 'Combo');
    }

    const actorNames = new Map<string, string>();
    for (const doc of users) {
        const record = doc as { _id: mongoose.Types.ObjectId; username?: string; email?: string };
        actorNames.set(record._id.toString(), record.username ?? record.email ?? 'Unknown user');
    }

    return transactions.map((transaction) => {
        const itemKey = `${transaction.itemType}:${String(transaction.itemId)}`;
        const actorId = transaction.performedBy ? String(transaction.performedBy) : undefined;

        return {
            ...transaction,
            itemName: itemNames.get(itemKey) ?? 'Unavailable item',
            performedByName: actorId ? actorNames.get(actorId) : undefined,
        } as InventoryTransactionView;
    });
};

export const listInventoryTransactions = async (
    query: InventoryTransactionQuery
): Promise<{
    items: InventoryTransactionView[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}> => {
    const filter = buildTransactionFilter(query);
    const pagination = getPaginationParams(query.page as number, (query.limit as number) ?? 25);
    const sortDirection = normalizeInventorySort(query.sort) === 'oldest' ? 1 : -1;

    const [documents, total] = await Promise.all([
        InventoryTransaction.find(filter)
            .sort({ createdAt: sortDirection, _id: sortDirection })
            .skip(getSkip(pagination))
            .limit(pagination.limit)
            .exec(),
        InventoryTransaction.countDocuments(filter),
    ]);

    const items = await decorateTransactions(
        documents.map((doc) => doc.toObject() as unknown as Record<string, unknown>)
    );

    return buildPaginatedResult(items, total, pagination);
};

export const getInventoryTransactionById = async (
    transactionId: string
): Promise<InventoryTransactionView> => {
    const objectId = toInventoryObjectId(transactionId, 'transactionId');
    const transaction = await InventoryTransaction.findById(objectId).exec();

    if (!transaction) {
        throw createInventoryTransactionError(404, 'Inventory transaction not found', 'transaction_not_found');
    }

    const [view] = await decorateTransactions([
        transaction.toObject() as unknown as Record<string, unknown>,
    ]);

    return view;
};

export type InventoryItemSnapshot = {
    itemId: string;
    itemType: InventoryItemType;
    name: string;
    slug?: string;
    stock: number;
    lowStockThreshold: number;
    effectiveLowStockThreshold: number;
    stockStatus: StockStatus;
    availabilityMode: 'in_stock' | 'pre_order';
    preOrder?: unknown;
    price: number;
};

/** Current stock + threshold for a single catalog item (history page header). */
export const getInventoryItemSnapshot = async (
    itemType: InventoryItemType,
    itemId: string
): Promise<InventoryItemSnapshot> => {
    const objectId = toInventoryObjectId(itemId, 'itemId');
    const [document, settings] = await Promise.all([
        resolveItemModel(itemType).findById(objectId).exec(),
        getInventorySettings(),
    ]);

    if (!document) {
        throw createInventoryTransactionError(
            404,
            `${inventoryItemLabel(itemType)} not found`,
            'inventory_item_not_found'
        );
    }

    const json = document.toJSON() as unknown as Record<string, unknown>;
    const stock = readNumber(json.stock);
    const effectiveLowStockThreshold = getEffectiveLowStockThreshold(
        json as { lowStockThreshold?: number | null },
        settings.defaultLowStockThreshold
    );

    return {
        itemId: document._id.toString(),
        itemType,
        name: typeof json.name === 'string' ? json.name : String(json.title ?? ''),
        slug: typeof json.slug === 'string' ? json.slug : undefined,
        stock,
        lowStockThreshold: readNumber(json.lowStockThreshold, settings.defaultLowStockThreshold),
        effectiveLowStockThreshold,
        stockStatus: getStockStatus(stock, effectiveLowStockThreshold),
        availabilityMode: json.availabilityMode === 'pre_order' ? 'pre_order' : 'in_stock',
        preOrder: json.preOrder,
        price: readNumber(json.price),
    };
};
