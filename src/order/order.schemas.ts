import { z } from 'zod';
import { OBJECT_ID_PATTERN, numericField } from '../utils/validation';

/**
 * Per-item quantity ceiling. The real limit on how much a customer can buy is
 * stock or pre-order capacity, which the controller reports as a 409; this is a
 * sanity bound that only rejects absurd values.
 */
export const MAX_ORDER_ITEM_QUANTITY = 999;

/**
 * Item shape, including the `itemId` FORMAT — a malformed id previously reached
 * `Product.findById()`, threw a Mongoose CastError with no `statusCode`, and
 * surfaced as a 500. Rejecting it here turns that into a clean 400.
 */
const orderItemSchema = z
    .object({
        // `productId` is an accepted alias: the cart may send either.
        itemId: z.string().regex(OBJECT_ID_PATTERN, 'Invalid item id').optional(),
        productId: z.string().regex(OBJECT_ID_PATTERN, 'Invalid item id').optional(),
        itemType: z.enum(['product', 'combo']),
        quantity: numericField(z.coerce.number().int().positive().max(MAX_ORDER_ITEM_QUANTITY)),
    })
    .refine((item) => item.itemId !== undefined || item.productId !== undefined, {
        message: 'itemId is required',
        path: ['itemId'],
    });

/**
 * Shape only — every field is an optional string.
 *
 * Required-field semantics stay with `validateAndNormalizeShippingAddress`, so
 * its specific message and `code: 'invalid_shipping_address'` survive. It also
 * computes `deliveryZone` itself, which is why the client's zone is not
 * accepted here.
 */
const orderShippingAddressSchema = z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    division: z.string().optional(),
    district: z.string().optional(),
    area: z.string().optional(),
    thana: z.string().optional(),
    address: z.string().optional(),
    detailedAddress: z.string().optional(),
    fullAddress: z.string().optional(),
    landmark: z.string().optional(),
    addressId: z.string().optional(),
});

/**
 * `items` is deliberately NOT `.min(1)`: an empty array is left to the
 * controller so its "Order items are required" message survives.
 *
 * `title`, `price` and `thumbnail` are intentionally absent (as is the shipping
 * address's `deliveryZone`) — the server derives all of them, so accepting them
 * would only let a client suggest a price or a delivery zone.
 *
 * `couponCode` and `quoteFingerprint` MUST stay: the controller reads both, and
 * `quoteFingerprint` feeds a mismatch check that rejects the order.
 */
export const createOrderSchema = z.object({
    items: z.array(orderItemSchema),
    shippingAddress: orderShippingAddressSchema.optional(),
    addressId: z.string().min(1).optional(),
    paymentMethod: z.enum(['cash_on_delivery']).optional(),
    couponCode: z.string().optional(),
    quoteFingerprint: z.string().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
