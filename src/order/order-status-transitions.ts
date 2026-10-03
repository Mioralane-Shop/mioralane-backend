import { OrderStatus } from '../enums/order-status.enum';

/**
 * Allowed order-status transitions (P1.3, R4).
 *
 * ## Why this exists
 *
 * `updateAdminOrderStatus` validated only that the submitted value was *a*
 * status (`admin-order.controller.ts:536` → `isValidOrderStatus`), never that
 * it was a legal *next* status. So `DELIVERED → CANCELLED` was accepted, and
 * that branch restores stock — inflating inventory for goods the customer had
 * already received. `PENDING → DELIVERED` and `DELIVERED → SHIPPED` were
 * equally reachable. The admin UI presumably only offers sensible actions, which
 * is exactly the "the UI is the control" gap: the API accepted states the UI
 * would not have produced.
 *
 * ## Rules
 *
 * ```
 *   pending    -> processing | cancelled
 *   processing -> shipped    | cancelled
 *   shipped    -> delivered
 *   delivered  -> (terminal)
 *   cancelled  -> (terminal)
 * ```
 *
 * Note the enum member is **`PROCESSING`**, not `CONFIRMED` — that name does not
 * exist in `src/enums/order-status.enum.ts`, and inventing it here would have
 * produced a matrix that silently never matched.
 *
 * Returns and refunds are deliberately out of scope: a delivered order that comes
 * back needs its own `RETURNED` state and its own stock policy, not a reuse of
 * `CANCELLED` (which would make "we shipped it, then it came back" and "we never
 * shipped it" indistinguishable in the ledger).
 */
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * True when `from -> to` is a legal progression.
 *
 * `from === to` returns false: the caller treats a no-op write separately (it is
 * an idempotent re-send, not a transition), and folding the two together would
 * hide that distinction here.
 */
export const canTransitionOrderStatus = (from: OrderStatus, to: OrderStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/** The legal next statuses from `from`, in declaration order. */
export const allowedNextOrderStatuses = (from: OrderStatus): readonly OrderStatus[] =>
  ALLOWED_TRANSITIONS[from];

/** Statuses with no outgoing transition. Kept explicit so a new enum member fails loudly. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
];

/** Every status that appears in the matrix, for exhaustiveness checks in tests. */
export const ORDER_STATUS_MATRIX_KEYS: readonly OrderStatus[] = Object.values(OrderStatus);
