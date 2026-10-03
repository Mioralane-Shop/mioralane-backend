import crypto from 'crypto';
import mongoose, { Document, Model, Schema } from 'mongoose';
import type { CreateOrderInput } from './order.schemas';

/**
 * Checkout idempotency (P1.3, R1).
 *
 * ## Why
 *
 * Nothing deduplicated a repeated `POST /api/orders`. A double-click, a network
 * retry, or the one-shot retry P1.1 added to the clients' axios interceptors
 * (which fires when a checkout response is lost after its 403 CSRF re-sync)
 * created a **second order**: second order number, second stock deduction,
 * second COD shipment. The inventory ledger's idempotency index cannot help —
 * it is keyed on the order id, and a replay mints a new one.
 *
 * ## How
 *
 * The client sends an `idempotencyKey` generated once per checkout attempt and
 * reused across retries. This collection records the key with the order it
 * created and a fingerprint of the intent. A second request with the same key:
 *
 *   - same fingerprint  -> return the existing order (200, no second write)
 *   - different content -> 409 `IDEMPOTENCY_KEY_REUSED`
 *
 * The key document is written **inside the order's transaction**, so a failed
 * checkout leaves no key behind and the customer's retry is free to succeed.
 *
 * ## Lifecycle
 *
 * The key outlives the order's usefulness only briefly: a TTL index drops it
 * after 48 hours. A TTL on the *order* would have been wrong — an order lives
 * forever, while a dedupe window only needs to cover retry behaviour.
 *
 * The unique index is scoped to the user, so one customer's key can never be
 * used to probe or collide with another's.
 */

/** How long a key stays valid. Long enough for retries, short enough to expire quietly. */
export const IDEMPOTENCY_KEY_TTL_MS = 48 * 60 * 60 * 1000;

export interface IIdempotencyKey {
  userId: mongoose.Types.ObjectId;
  key: string;
  requestFingerprint: string;
  orderId: mongoose.Types.ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

export interface IIdempotencyKeyDocument extends IIdempotencyKey, Document {}

const IdempotencyKeySchema = new Schema<IIdempotencyKeyDocument>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  key: {
    type: String,
    required: true,
    trim: true,
  },
  requestFingerprint: {
    type: String,
    required: true,
  },
  orderId: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

/** One key per customer: a collision can only ever be the same customer retrying. */
IdempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });

/** Retention. `expireAfterSeconds: 0` means "delete once `expiresAt` has passed". */
IdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey: Model<IIdempotencyKeyDocument> =
  mongoose.models.IdempotencyKey ||
  mongoose.model<IIdempotencyKeyDocument>('IdempotencyKey', IdempotencyKeySchema);

/**
 * A stable hash of what the customer is asking for — the *intent*, not the
 * request bytes.
 *
 * The raw body cannot be hashed directly: JSON key order follows the client, so
 * the same cart could produce two different hashes and turn a legitimate retry
 * into a 409. Items are therefore sorted and every field is read explicitly.
 *
 * `quoteFingerprint` is deliberately **excluded**. It is derived pricing that can
 * legitimately change between attempts (a campaign edit, a shipping fee change);
 * if it were part of the intent, a retry after such a change would be refused
 * instead of returning the order that was already created — which is the whole
 * point of an idempotency key.
 */
export const createCheckoutRequestFingerprint = (
  body: CreateOrderInput,
  userId: string
): string => {
  const items = (body.items ?? [])
    .map((item) => ({
      itemId: item.itemId ?? item.productId ?? '',
      itemType: item.itemType,
      quantity: Number(item.quantity),
    }))
    .sort((first, second) =>
      `${first.itemType}:${first.itemId}`.localeCompare(`${second.itemType}:${second.itemId}`)
    );

  const address = body.shippingAddress;

  const state = {
    userId,
    items,
    addressId: body.addressId ?? address?.addressId ?? null,
    shippingAddress: address
      ? {
        name: address.name ?? null,
        phone: address.phone ?? null,
        division: address.division ?? null,
        district: address.district ?? null,
        area: address.area ?? null,
        thana: address.thana ?? null,
        address: address.address ?? null,
        detailedAddress: address.detailedAddress ?? null,
        fullAddress: address.fullAddress ?? null,
        landmark: address.landmark ?? null,
      }
      : null,
    couponCode: body.couponCode?.trim() ?? '',
    paymentMethod: body.paymentMethod ?? 'cash_on_delivery',
  };

  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
};

export default IdempotencyKey;
