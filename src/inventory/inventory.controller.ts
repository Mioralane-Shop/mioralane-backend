import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { getInventorySettings, upsertInventorySettings } from './inventory.service';
import {
  InventoryItemType,
  InventoryTransactionType,
} from './inventory-transaction.model';
import {
  applyManualInventoryOperation,
  createInventoryTransactionError,
  getInventoryItemSnapshot,
  getInventoryTransactionById,
  listInventoryTransactions,
  normalizeInventoryItemType,
  normalizeInventorySort,
  normalizeInventoryTransactionType,
} from './inventory-transaction.service';

export const getAdminInventorySettings = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const settings = await getInventorySettings();
  res.json({ success: true, settings });
};

export const updateAdminInventorySettings = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const settings = await upsertInventorySettings(req.body);
    res.json({ success: true, settings });
  } catch (error) {
    const err = error as { statusCode?: number; message?: string; code?: string };
    res.status(err.statusCode ?? 400).json({
      success: false,
      message: err.message ?? 'Unable to update inventory settings',
      code: err.code ?? 'inventory_settings_update_failed',
    });
  }
};

const respondWithInventoryError = (res: Response, error: unknown, fallback: string): void => {
  const err = error as { statusCode?: number; message?: string; code?: string };

  if ((err.statusCode ?? 500) >= 500) {
    console.error('[inventory]', error);
  }

  res.status(err.statusCode ?? 500).json({
    success: false,
    message: err.message ?? fallback,
    code: err.code ?? 'inventory_operation_failed',
  });
};

const readQueryString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const readTransactionTypes = (value: unknown): InventoryTransactionType[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const raw = Array.isArray(value) ? value : String(value).split(',');

  return raw
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => normalizeInventoryTransactionType(entry));
};

export const listInventoryTransactionHistory = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const result = await listInventoryTransactions({
      itemType: req.query.itemType ? normalizeInventoryItemType(req.query.itemType) : undefined,
      itemId: readQueryString(req.query.itemId),
      transactionType: readTransactionTypes(req.query.transactionType ?? req.query.type),
      performedBy: readQueryString(req.query.performedBy),
      from: readQueryString(req.query.from),
      to: readQueryString(req.query.to),
      sort: normalizeInventorySort(req.query.sort),
      page: req.query.page,
      limit: req.query.limit,
    });

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    respondWithInventoryError(res, error, 'Unable to load inventory transactions');
  }
};

export const getInventoryTransaction = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const rawId = req.params.id;
    const transaction = await getInventoryTransactionById(Array.isArray(rawId) ? rawId[0] : rawId);

    res.status(200).json({ success: true, transaction });
  } catch (error) {
    respondWithInventoryError(res, error, 'Unable to load this inventory transaction');
  }
};

/** Item header (current stock) + that item's ledger, newest first. */
export const getInventoryItemHistory = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const itemType = normalizeInventoryItemType(req.params.itemType);
    const rawItemId = req.params.itemId;
    const itemId = Array.isArray(rawItemId) ? rawItemId[0] : rawItemId;

    const [item, history] = await Promise.all([
      getInventoryItemSnapshot(itemType, itemId),
      listInventoryTransactions({
        itemType,
        itemId,
        transactionType: readTransactionTypes(req.query.transactionType ?? req.query.type),
        performedBy: readQueryString(req.query.performedBy),
        from: readQueryString(req.query.from),
        to: readQueryString(req.query.to),
        sort: normalizeInventorySort(req.query.sort),
        page: req.query.page,
        limit: req.query.limit ?? 50,
      }),
    ]);

    res.status(200).json({ success: true, item, ...history });
  } catch (error) {
    respondWithInventoryError(res, error, 'Unable to load this item history');
  }
};

const INVENTORY_ACTION_TYPES: Record<string, InventoryTransactionType> = {
  'stock-in': 'STOCK_IN',
  'stock-out': 'STOCK_OUT',
  restock: 'RESTOCK',
  adjust: 'MANUAL_ADJUSTMENT',
  damaged: 'DAMAGED',
  lost: 'LOST',
};

const INVENTORY_ACTION_MESSAGES: Record<string, string> = {
  'stock-in': 'Stock added',
  'stock-out': 'Stock removed',
  restock: 'Restock recorded',
  adjust: 'Stock adjusted',
  damaged: 'Damaged stock recorded',
  lost: 'Lost stock recorded',
};

const performInventoryAction =
  (action: string) =>
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const itemType: InventoryItemType = normalizeInventoryItemType(body.itemType);
        const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : '';

        if (!itemId) {
          throw createInventoryTransactionError(400, 'itemId is required', 'invalid_inventory_id');
        }

        const movement = await applyManualInventoryOperation({
          itemType,
          itemId,
          transactionType: INVENTORY_ACTION_TYPES[action],
          quantity: body.quantity as number | undefined,
          targetStock: body.targetStock as number | undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          note: typeof body.note === 'string' ? body.note : undefined,
          actorId: req.user.id,
          actorRole: 'admin',
        });

        const item = await getInventoryItemSnapshot(itemType, itemId);

        res.status(201).json({
          success: true,
          message: `${INVENTORY_ACTION_MESSAGES[action]}: ${item.name}`,
          movement,
          item,
        });
      } catch (error) {
        respondWithInventoryError(res, error, INVENTORY_ACTION_MESSAGES[action] ?? 'Inventory update failed');
      }
    };

export const stockInInventoryItem = performInventoryAction('stock-in');
export const stockOutInventoryItem = performInventoryAction('stock-out');
export const restockInventoryItem = performInventoryAction('restock');
export const adjustInventoryItem = performInventoryAction('adjust');
export const markInventoryDamaged = performInventoryAction('damaged');
export const markInventoryLost = performInventoryAction('lost');
