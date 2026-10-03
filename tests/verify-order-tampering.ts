/**
 * P1.3 — order tampering fixes (R1–R8).
 *
 * Run with: npm run verify:order-tampering
 *
 * ## What this can and cannot cover
 *
 * The checkout path needs MongoDB (it opens a session and writes), and `protect`
 * needs the users collection — so there is **no DB-free end-to-end path to
 * `createOrder`**, exactly as with the upload route in P1.2. This harness
 * therefore asserts three things that need no database:
 *
 *   1. the two pure decisions — zone resolution (R2) and the status matrix (R4) —
 *      by calling the real functions,
 *   2. the idempotency fingerprint (R1) and the request schema, by calling the
 *      real code,
 *   3. the wiring and the atomicity *shape* of everything that needs a database,
 *      by reading the comment-stripped source: which index exists, which guard an
 *      update carries, and in what order the writes run inside the transaction.
 *
 * The concurrent cases that genuinely need a replica set — two simultaneous
 * checkouts sharing a coupon or a key — are **not** covered here. They are listed
 * in the P1.3 report as the opt-in integration layer, which needs a reachable
 * `MONGODB_URI` and an isolated database.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrderStatus } from '../src/enums/order-status.enum';
import { createOrderSchema } from '../src/order/order.schemas';
import {
  IDEMPOTENCY_KEY_TTL_MS,
  createCheckoutRequestFingerprint,
} from '../src/order/idempotency-key.model';
import {
  allowedNextOrderStatuses,
  canTransitionOrderStatus,
  TERMINAL_ORDER_STATUSES,
} from '../src/order/order-status-transitions';
import {
  BD_DISTRICTS,
  BD_DIVISIONS,
  DHAKA_CITY_AREAS,
  isKnownDhakaArea,
} from '../src/shipping/bangladesh-locations';
import { resolveShippingZone } from '../src/shipping/shipping-zone-policy';

const SRC_DIR = join(__dirname, '..', 'src');
const ORDER_CONTROLLER_FILE = join(SRC_DIR, 'order', 'order.controller.ts');
const ADMIN_ORDER_CONTROLLER_FILE = join(SRC_DIR, 'order', 'admin-order.controller.ts');
const ORDER_SCHEMAS_FILE = join(SRC_DIR, 'order', 'order.schemas.ts');
const PROMOTION_SERVICE_FILE = join(SRC_DIR, 'promotion', 'promotion.service.ts');
const COUNTER_MODEL_FILE = join(SRC_DIR, 'promotion', 'coupon-usage-counter.model.ts');

const failures: string[] = [];

const check = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    console.log(`  OK   ${label}`);
    return;
  }

  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  FAIL ${label}${suffix}`);
  failures.push(`${label}${suffix}`);
};

const section = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

const stripCommentLines = (source: string): string =>
  source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();

      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*/')
      );
    })
    .join('\n');

const readSource = (file: string): string => stripCommentLines(readFileSync(file, 'utf8'));

/**
 * Raw source, comments included.
 *
 * Documentation is asserted against this, never against `readSource`: the point
 * of those checks is that a note EXISTS, and stripping comments first makes them
 * unfailable rather than failing.
 */
const readRaw = (file: string): string => readFileSync(file, 'utf8');

/** Runs `run` and reports whether it threw an error carrying `code`. */
const throwsWithCode = (run: () => unknown, code: string): boolean => {
  try {
    run();

    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === code;
  }
};

const baseOrderBody = {
  items: [{ itemId: '507f1f77bcf86cd799439011', itemType: 'product' as const, quantity: 1 }],
  shippingAddress: { division: 'Dhaka', district: 'Dhaka', area: 'Dhanmondi' },
  paymentMethod: 'cash_on_delivery' as const,
};

const main = async (): Promise<void> => {
  /* ── A. R2 — zone resolution fails closed ──────────────────────────── */
  section('A. R2 — delivery zone resolution');

  check('the division list holds 8 entries', BD_DIVISIONS.length === 8, String(BD_DIVISIONS.length));
  check('the district list holds 64 entries', BD_DISTRICTS.length === 64, String(BD_DISTRICTS.length));
  check(
    'the district list has no duplicates',
    new Set(BD_DISTRICTS.map((name) => name.toLowerCase())).size === BD_DISTRICTS.length,
    `${BD_DISTRICTS.length} names`
  );
  check(
    'the Dhaka city list is deduplicated',
    new Set(DHAKA_CITY_AREAS.map((name) => name.toLowerCase())).size === DHAKA_CITY_AREAS.length,
    `${DHAKA_CITY_AREAS.length} names`
  );

  check(
    'a Dhaka city area resolves to inside_dhaka',
    resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: 'Dhanmondi' }) === 'inside_dhaka'
  );
  check(
    'a Dhaka suburban upazila resolves to dhaka_suburban',
    resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: 'Savar' }) === 'dhaka_suburban'
  );
  check(
    'the suburban list still wins over the city list for the names in both (Dhamrai)',
    resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: 'Dhamrai' }) === 'dhaka_suburban',
    'ordering changed'
  );
  check(
    'case and whitespace do not matter',
    resolveShippingZone({ division: '  DHAKA ', district: 'dhaka', area: '  savar ' }) === 'dhaka_suburban'
  );
  check(
    'both dataset spellings of the same place are accepted',
    isKnownDhakaArea('Nababganj') && isKnownDhakaArea('Nawabganj') &&
      isKnownDhakaArea('Uttarkhan') && isKnownDhakaArea('Uttar Khan')
  );
  check(
    'another district in the Dhaka division is outside_dhaka',
    resolveShippingZone({ division: 'Dhaka', district: 'Gazipur', area: 'Tongi' }) === 'outside_dhaka'
  );
  check(
    'a district outside the Dhaka division is outside_dhaka',
    resolveShippingZone({ division: 'Chattogram', district: 'Chattogram', area: 'Pahartali' }) === 'outside_dhaka'
  );
  check(
    'a non-Dhaka district accepts any non-empty area (area cannot change its zone)',
    resolveShippingZone({ division: 'Khulna', district: 'Khulna', area: 'Anything At All' }) === 'outside_dhaka'
  );

  // R2's whole point: the removed `return 'inside_dhaka'` default.
  check(
    'NC: an unknown Dhaka area is refused instead of defaulting to the cheapest zone',
    throwsWithCode(
      () => resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: 'Not A Real Area' }),
      'unknown_delivery_area'
    ),
    'an unknown area still resolved to a zone'
  );
  check(
    'NC: and an empty area is refused too',
    throwsWithCode(
      () => resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: '' }),
      'unknown_delivery_area'
    )
  );
  check(
    'an unknown district is refused',
    throwsWithCode(
      () => resolveShippingZone({ division: 'Dhaka', district: 'Atlantis', area: 'Dhanmondi' }),
      'unknown_delivery_district'
    )
  );
  check(
    'an unknown division is refused',
    throwsWithCode(
      () => resolveShippingZone({ division: 'Atlantis', district: 'Dhaka', area: 'Dhanmondi' }),
      'unknown_delivery_division'
    )
  );
  check(
    'a missing district is refused, not defaulted',
    throwsWithCode(() => resolveShippingZone({ division: 'Dhaka', area: 'Dhanmondi' }), 'unknown_delivery_district')
  );
  check(
    'the zone error is a 400 with a code the client can act on',
    (() => {
      try {
        resolveShippingZone({ division: 'Dhaka', district: 'Dhaka', area: 'Nope' });

        return false;
      } catch (error) {
        const typed = error as { statusCode?: number; message?: string };

        return typed.statusCode === 400 && typeof typed.message === 'string' && typed.message.length > 0;
      }
    })()
  );

  /* ── B. R4 — status transition matrix ─────────────────────────────── */
  section('B. R4 — order status transitions');

  const allStatuses = Object.values(OrderStatus);
  const allowedPairs = allStatuses.flatMap((from) =>
    allStatuses.filter((to) => canTransitionOrderStatus(from, to)).map((to) => `${from}->${to}`)
  );

  check(
    'the enum has the five expected members (no CONFIRMED — it is PROCESSING)',
    allStatuses.length === 5 && !allStatuses.includes('confirmed' as OrderStatus),
    allStatuses.join(', ')
  );
  check(
    'exactly five transitions are allowed',
    allowedPairs.length === 5,
    allowedPairs.join(', ')
  );
  check(
    'the allowed set is exactly the documented progression',
    ['pending->processing', 'pending->cancelled', 'processing->shipped', 'processing->cancelled', 'shipped->delivered'].every(
      (pair) => allowedPairs.includes(pair)
    ),
    allowedPairs.join(', ')
  );
  check(
    'NC: DELIVERED -> CANCELLED is refused (this is the hole R4 closes)',
    !canTransitionOrderStatus(OrderStatus.DELIVERED, OrderStatus.CANCELLED)
  );
  check(
    'a delivered order is terminal',
    allowedNextOrderStatuses(OrderStatus.DELIVERED).length === 0
  );
  check(
    'a cancelled order is terminal',
    allowedNextOrderStatuses(OrderStatus.CANCELLED).length === 0
  );
  check(
    'no status can transition to itself (the no-op is handled separately)',
    allStatuses.every((status) => !canTransitionOrderStatus(status, status))
  );
  check(
    'no backwards transition exists',
    !canTransitionOrderStatus(OrderStatus.SHIPPED, OrderStatus.PENDING) &&
      !canTransitionOrderStatus(OrderStatus.DELIVERED, OrderStatus.SHIPPED) &&
      !canTransitionOrderStatus(OrderStatus.PROCESSING, OrderStatus.PENDING)
  );
  check(
    'the terminal list matches the matrix',
    TERMINAL_ORDER_STATUSES.length === 2 &&
      TERMINAL_ORDER_STATUSES.every((status) => allowedNextOrderStatuses(status).length === 0)
  );

  /* ── C. R1 — idempotency ──────────────────────────────────────────── */
  section('C. R1 — checkout idempotency');

  const fingerprint = createCheckoutRequestFingerprint(baseOrderBody, 'user-1');

  check(
    'the same intent produces the same fingerprint',
    fingerprint === createCheckoutRequestFingerprint(baseOrderBody, 'user-1') && fingerprint.length === 64,
    `${fingerprint.length} chars`
  );
  check(
    'a different customer produces a different fingerprint',
    fingerprint !== createCheckoutRequestFingerprint(baseOrderBody, 'user-2')
  );
  check(
    'a different quantity produces a different fingerprint',
    fingerprint !==
      createCheckoutRequestFingerprint(
        { ...baseOrderBody, items: [{ ...baseOrderBody.items[0], quantity: 2 }] },
        'user-1'
      )
  );
  check(
    'a different coupon produces a different fingerprint',
    fingerprint !== createCheckoutRequestFingerprint({ ...baseOrderBody, couponCode: 'SAVE10' }, 'user-1')
  );
  check(
    'item order does not change the fingerprint (the client may send any order)',
    createCheckoutRequestFingerprint(
      {
        ...baseOrderBody,
        items: [
          { itemId: '507f1f77bcf86cd799439012', itemType: 'combo', quantity: 3 },
          { itemId: '507f1f77bcf86cd799439011', itemType: 'product', quantity: 1 },
        ],
      },
      'user-1'
    ) ===
      createCheckoutRequestFingerprint(
        {
          ...baseOrderBody,
          items: [
            { itemId: '507f1f77bcf86cd799439011', itemType: 'product', quantity: 1 },
            { itemId: '507f1f77bcf86cd799439012', itemType: 'combo', quantity: 3 },
          ],
        },
        'user-1'
      )
  );
  check(
    'the quote fingerprint is NOT part of the intent (a re-quote must not break a retry)',
    fingerprint ===
      createCheckoutRequestFingerprint({ ...baseOrderBody, quoteFingerprint: 'abc123' }, 'user-1') &&
      fingerprint ===
        createCheckoutRequestFingerprint({ ...baseOrderBody, quoteFingerprint: 'zzz999' }, 'user-1')
  );

  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  check(
    'the schema accepts a UUID key',
    createOrderSchema.safeParse({ ...baseOrderBody, idempotencyKey: uuid }).success
  );
  check(
    'the schema accepts an absent key (older clients keep working, backend-first rollout)',
    createOrderSchema.safeParse(baseOrderBody).success
  );
  check(
    'the schema rejects a non-UUID key',
    !createOrderSchema.safeParse({ ...baseOrderBody, idempotencyKey: 'not-a-uuid' }).success
  );
  check(
    'the TTL window is 48 hours',
    IDEMPOTENCY_KEY_TTL_MS === 48 * 60 * 60 * 1000,
    String(IDEMPOTENCY_KEY_TTL_MS)
  );

  const idempotencySource = readSource(join(SRC_DIR, 'order', 'idempotency-key.model.ts'));
  const orderController = readSource(ORDER_CONTROLLER_FILE);

  check(
    'the key is unique per customer',
    /index\(\{\s*userId:\s*1,\s*key:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}\)/.test(idempotencySource),
    'no unique {userId, key} index'
  );
  check(
    'and expires on its own',
    /expireAfterSeconds:\s*0/.test(idempotencySource),
    'no TTL index'
  );

  const replayGuardIndex = orderController.indexOf('IDEMPOTENCY_KEY_REUSED');
  const sessionIndex = orderController.indexOf('await mongoose.startSession()');
  const createIndex = orderController.indexOf('await Order.create(');
  const keyInsertIndex = orderController.indexOf('key: idempotencyKey,');

  check(
    'the replay check runs before the transaction is even opened',
    replayGuardIndex !== -1 && sessionIndex !== -1 && replayGuardIndex < sessionIndex,
    `replay@${replayGuardIndex} session@${sessionIndex}`
  );
  check(
    'the key row is written inside the transaction, after the order',
    keyInsertIndex > createIndex && /\{ session \}/.test(orderController.slice(keyInsertIndex, keyInsertIndex + 400))
  );
  check(
    'a concurrent duplicate is handled rather than surfacing as a 500',
    orderController.includes('IDEMPOTENCY_KEY_IN_PROGRESS') && orderController.includes('isDuplicateKeyError(error)'),
    'no duplicate-key branch'
  );
  check(
    'exactly one fingerprint function exists for the whole path',
    (idempotencySource.match(/export const createCheckoutRequestFingerprint/g) ?? []).length === 1 &&
      (orderController.match(/createCheckoutRequestFingerprint\(/g) ?? []).length === 1
  );

  /* ── D. R3 — atomic per-customer coupon counter ───────────────────── */
  section('D. R3 — coupon usage per customer');

  const counterSource = readSource(COUNTER_MODEL_FILE);
  const promotionSource = readSource(PROMOTION_SERVICE_FILE);

  check(
    'the counter is unique per coupon and customer',
    /index\(\{\s*couponId:\s*1,\s*userId:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}\)/.test(counterSource),
    'no unique index'
  );
  check(
    'the reservation increments with a guarded $inc, not a read-then-write',
    /\$expr:\s*\{\s*\$lt:\s*\['\$count',\s*perCustomerLimit\]/.test(promotionSource) &&
      /\$inc:\s*\{\s*count:\s*1\s*\}/.test(promotionSource),
    'the counter guard is missing'
  );
  check(
    'the limit is read from the coupon inside the transaction, never passed in by a caller',
    /select\('perCustomerUsageLimit'\)/.test(promotionSource)
  );
  check(
    'the read-only countDocuments pre-check is still present as the fast path',
    /coupon\.perCustomerUsageLimit && customerUsage >= coupon\.perCustomerUsageLimit/.test(promotionSource)
  );

  const customerReserveIndex = orderController.indexOf('reserveCouponUsageForCustomer(');
  const globalReserveIndex = orderController.indexOf('reserveCouponUsage({');

  check(
    'both coupon counters are reserved before the order row is created',
    customerReserveIndex !== -1 && globalReserveIndex !== -1 &&
      customerReserveIndex < createIndex && globalReserveIndex < createIndex,
    `customer@${customerReserveIndex} global@${globalReserveIndex} order@${createIndex}`
  );
  check(
    'and the usage row itself is still written after the order exists',
    orderController.indexOf('await CouponUsage.create(') > createIndex
  );

  /* ── E. R5/R6/R7/R8 — typing, the cap, and the notes ──────────────── */
  section('E. R5/R6/R7/R8');

  const orderDirSources = [
    ORDER_CONTROLLER_FILE,
    ORDER_SCHEMAS_FILE,
    join(SRC_DIR, 'order', 'order.model.ts'),
    join(SRC_DIR, 'order', 'order-status-transitions.ts'),
    join(SRC_DIR, 'order', 'idempotency-key.model.ts'),
  ].map(readSource);
  const adminController = readSource(ADMIN_ORDER_CONTROLLER_FILE);
  const adminControllerRaw = readRaw(ADMIN_ORDER_CONTROLLER_FILE);
  const orderControllerRaw = readRaw(ORDER_CONTROLLER_FILE);

  check(
    'NC: no `any` survives in the order module (R5)',
    orderDirSources.every((source) => !/:\s*any\b/.test(source) && !/as any\b/.test(source) && !/<any>/.test(source)),
    'a cast or annotation remains'
  );
  check(
    'the product/combo view type is declared rather than cast (R5)',
    orderController.includes('type ResolvedSourceDoc =') &&
      orderController.includes('const sourceDoc: ResolvedSourceDoc | null =') &&
      !/sourceDoc as \{/.test(orderController)
  );
  check(
    'a pre-order product with no configuration still fails closed (R5 preserved the behaviour)',
    /const preOrder: ResolvedPreOrder = isPreOrderProduct \? sourceDoc\.preOrder \?\? \{\} : \{\}/.test(
      orderController
    ),
    'the ?? {} fallback is missing'
  );
  check(
    'the quantity cap is re-applied in the controller, not only in the schema (R6)',
    /normalizedItems\.some\(\(item\) => item\.quantity > MAX_ORDER_ITEM_QUANTITY\)/.test(orderController)
  );
  check(
    'the vestigial deliveryZone input field is gone (R7)',
    !readSource(join(SRC_DIR, 'shipping', 'shipping.service.ts')).includes('deliveryZone?: DeliveryZone;')
  );
  check(
    'the transition matrix is documented as the authority over the enum check (R4/R8)',
    adminController.includes('canTransitionOrderStatus(') && adminController.includes('INVALID_STATUS_TRANSITION')
  );

  const adminMatrixIndex = adminController.indexOf('canTransitionOrderStatus(');
  const adminSameStatusIndex = adminController.indexOf('currentStatus === nextStatus');
  const adminMutateIndex = adminController.indexOf('order.orderStatus = nextStatus;');

  check(
    'the matrix is consulted after the same-status no-op and before any mutation',
    adminSameStatusIndex < adminMatrixIndex && adminMatrixIndex < adminMutateIndex,
    `same@${adminSameStatusIndex} matrix@${adminMatrixIndex} mutate@${adminMutateIndex}`
  );
  check(
    'the matrix is consulted as a refusal, not merely referenced',
    /if \(!canTransitionOrderStatus\(currentStatus, nextStatus\)\)/.test(adminController),
    'the guard is not in its refusing form — an inverted or inert call reads the same to a presence check'
  );
  check(
    'the concurrent-cancel assumption is recorded rather than implied (R7)',
    adminControllerRaw.includes('write conflict on the order document')
  );
  check(
    'the two stock writers are cross-referenced (R8)',
    orderControllerRaw.includes('applyStockDelta')
  );

  /* ── Result ────────────────────────────────────────────────────────── */
  console.log('\n=== Result ===');

  if (failures.length > 0) {
    console.log(`FAILED (${failures.length}):`);
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log('All order tampering checks passed.');
};

void main();
