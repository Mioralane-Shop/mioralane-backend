/**
 * P1.6-followup-a — coupon accounting is given back when an order is cancelled.
 *
 * Run with: npm run verify:coupon-cancel
 *
 * ## The bug this covers
 *
 * Cancelling an order restored stock and nothing else. `coupon.usageCount`, the
 * per-customer `CouponUsageCounter` and the per-order `CouponUsage` row all
 * survived, so a customer could spend a `perCustomerUsageLimit: 1` coupon, cancel
 * the order, and spend it again — repeatedly, because the cancel path decremented
 * nothing.
 *
 * ## What this harness can and cannot reach
 *
 * It is DB-free, like the rest of the suite, so it does NOT execute the reversal
 * against MongoDB. What it pins is everything that decides whether the reversal is
 * correct: the two update guards (no counter may go negative), the ordering that
 * makes the function idempotent, the no-op cases (proved by calling the real
 * function with a session it must never reach), and the wiring that puts the call in
 * the CANCELLED branch of the order transaction.
 *
 * The behavioural cases need a real transaction and belong to the opt-in integration
 * layer (`tests/verify-order-tampering.ts` names it for the same reason): happy path,
 * cancel twice, two orders sharing a coupon, a missing counter row, a deleted coupon.
 * They were **verified once against an isolated database** (db name swapped, counters
 * read back, database dropped afterwards) instead of being asserted here, and that
 * distinction is deliberate — a harness that claimed them without a database would be
 * asserting a mock.
 *
 * ## The property that carries the most weight
 *
 * Idempotency is structural: the `CouponUsage` delete comes first and its
 * `deletedCount` gates everything else, so a second release finds nothing to delete
 * and touches no counter. That is asserted here as ORDER, because order is the whole
 * mechanism — the same three statements in a different sequence would double-credit
 * on a retry.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import {
  couponUsageCounterReleaseFilter,
  couponUsageCounterReleaseUpdate,
  couponUsageReleaseFilter,
  couponUsageReleaseUpdate,
  releaseCouponUsageForOrder,
} from '../src/promotion/promotion.service';

const SRC_DIR = join(__dirname, '..', 'src');
const PROMOTION_SERVICE_FILE = join(SRC_DIR, 'promotion', 'promotion.service.ts');
const ADMIN_ORDER_CONTROLLER_FILE = join(SRC_DIR, 'order', 'admin-order.controller.ts');

const COUPON_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';

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

/** Strips comment-ONLY lines so structural assertions read code, not prose. */
const stripCommentLines = (source: string): string =>
  source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();

      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');

/**
 * The property each release filter must have. Extracted so it can be shown to
 * DISCRIMINATE — the control at the end runs it against an unguarded filter and
 * requires `false`. A predicate that returned `true` for everything would make the
 * guard checks vacuous.
 */
const hasPositiveFloor = (filter: Record<string, unknown>): boolean => {
  if ('count' in filter) {
    const count = filter.count as { $gt?: unknown } | undefined;
    return count?.$gt === 0;
  }

  const expr = filter.$expr as { $gt?: [string, number] } | undefined;
  return Array.isArray(expr?.$gt) && expr.$gt[0] === '$usageCount' && expr.$gt[1] === 0;
};

const main = async (): Promise<void> => {
  const promotionServiceSource = readFileSync(PROMOTION_SERVICE_FILE, 'utf8');
  const adminOrderSource = stripCommentLines(readFileSync(ADMIN_ORDER_CONTROLLER_FILE, 'utf8'));

  /* ══ A. The guards ═══════════════════════════════════════════════════════ */

  section('A. The two guards — no counter may go negative');

  const releaseFilter = couponUsageReleaseFilter(COUPON_ID);
  const counterFilter = couponUsageCounterReleaseFilter(COUPON_ID, USER_ID);

  check(
    'the coupon filter matches the coupon being released',
    releaseFilter._id === COUPON_ID,
    JSON.stringify(releaseFilter._id)
  );
  check(
    'the coupon filter refuses to decrement below zero',
    hasPositiveFloor(releaseFilter),
    JSON.stringify(releaseFilter)
  );
  check(
    'the coupon decrement is a single $inc of -1',
    JSON.stringify(couponUsageReleaseUpdate) === JSON.stringify({ $inc: { usageCount: -1 } }),
    JSON.stringify(couponUsageReleaseUpdate)
  );

  check(
    'the counter filter is scoped to the coupon AND the customer',
    counterFilter.couponId === COUPON_ID && counterFilter.userId === USER_ID,
    JSON.stringify({ couponId: counterFilter.couponId, userId: counterFilter.userId })
  );
  check(
    'the counter filter refuses to decrement below zero',
    hasPositiveFloor(counterFilter),
    JSON.stringify(counterFilter)
  );
  check(
    'and does NOT use $expr, which would silently no-op on a missing field',
    !('$expr' in counterFilter)
  );
  check(
    'the counter decrement is a single $inc of -1',
    JSON.stringify(couponUsageCounterReleaseUpdate) === JSON.stringify({ $inc: { count: -1 } }),
    JSON.stringify(couponUsageCounterReleaseUpdate)
  );
  check(
    'the release uses those exported guards rather than its own copies',
    promotionServiceSource.includes(
      'Coupon.findOneAndUpdate(couponUsageReleaseFilter(couponId), couponUsageReleaseUpdate'
    ) &&
      promotionServiceSource.includes('couponUsageCounterReleaseFilter(couponId, userId)') &&
      promotionServiceSource.includes('couponUsageCounterReleaseUpdate')
  );

  /* ══ B. Idempotency is ordering ══════════════════════════════════════════ */

  section('B. Idempotency — the delete comes first and gates everything');

  const releaseBodyStart = promotionServiceSource.indexOf('export const releaseCouponUsageForOrder');
  const releaseBody = promotionServiceSource.slice(releaseBodyStart);
  const deleteAt = releaseBody.indexOf('CouponUsage.deleteOne');
  const couponUpdateAt = releaseBody.indexOf('Coupon.findOneAndUpdate');
  const counterUpdateAt = releaseBody.indexOf('CouponUsageCounter.updateOne');

  check('the function exists', releaseBodyStart > 0);
  check('it deletes the per-order usage row', deleteAt > 0);
  check(
    'the delete is the FIRST write',
    deleteAt > 0 && couponUpdateAt > deleteAt && counterUpdateAt > deleteAt,
    `delete@${deleteAt} coupon@${couponUpdateAt} counter@${counterUpdateAt}`
  );
  check(
    'the delete filters on the order, not just the coupon',
    /CouponUsage\.deleteOne\(\s*\{\s*orderId:\s*order\._id,\s*couponId\s*\}/.test(releaseBody),
    releaseBody.slice(deleteAt, deleteAt + 90).replace(/\s+/g, ' ')
  );
  check(
    'the decrements run ONLY when the delete removed a row',
    /deletedCount\s*!==\s*1/.test(releaseBody.slice(deleteAt, couponUpdateAt))
  );
  check(
    'a failed delete returns before either counter is touched',
    releaseBody.slice(deleteAt, couponUpdateAt).includes('return false')
  );
  check('it reports whether it released anything', /Promise<boolean>/.test(releaseBody.slice(0, 240)));

  // Behavioural no-op cases, driven through the real function. The session is a
  // sentinel: the guard must return before it is ever used, so removing the guard
  // makes this throw instead of passing quietly.
  const sentinelSession = { __sentinel: 'never used' } as unknown as ClientSession;

  const callWith = async (
    order: Parameters<typeof releaseCouponUsageForOrder>[0]
  ): Promise<boolean | string> => {
    try {
      return await releaseCouponUsageForOrder(order, sentinelSession);
    } catch (error) {
      return `threw: ${(error as Error).message.slice(0, 60)}`;
    }
  };

  const noCoupon = await callWith({ _id: new mongoose.Types.ObjectId() });
  check('an order with no coupon releases nothing and touches no session', noCoupon === false, String(noCoupon));

  const emptyCoupon = await callWith({
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    coupon: {},
  });
  check('a coupon snapshot without a couponId releases nothing', emptyCoupon === false, String(emptyCoupon));

  const noUser = await callWith({
    _id: new mongoose.Types.ObjectId(),
    coupon: { couponId: new mongoose.Types.ObjectId() },
  });
  check('a coupon with no user on the order releases nothing', noUser === false, String(noUser));

  /* ══ C. Wiring — the CANCELLED branch of the order transaction ══════════ */

  section('C. Wiring');

  const cancelBranchStart = adminOrderSource.indexOf('if (nextStatus === OrderStatus.CANCELLED)');
  const cancelBranch = adminOrderSource.slice(cancelBranchStart, cancelBranchStart + 2600);
  const transactionStart = adminOrderSource.indexOf('session.withTransaction');

  check('the controller imports the release', adminOrderSource.includes('releaseCouponUsageForOrder'));
  check('it is called from the CANCELLED branch', cancelBranch.includes('releaseCouponUsageForOrder('));
  check('the branch is inside the order transaction', transactionStart > 0 && cancelBranchStart > transactionStart);
  check(
    'it runs AFTER the stock restoration',
    cancelBranch.indexOf('recordCancellationRestorations') < cancelBranch.indexOf('releaseCouponUsageForOrder('),
    `restore@${cancelBranch.indexOf('recordCancellationRestorations')} release@${cancelBranch.indexOf('releaseCouponUsageForOrder(')}`
  );
  check(
    'it is passed the order id, user and coupon snapshot',
    /releaseCouponUsageForOrder\(\s*\{\s*_id:\s*order\._id,\s*user:\s*order\.user,\s*coupon:\s*order\.coupon\s*\}/.test(
      cancelBranch
    ),
    cancelBranch.slice(cancelBranch.indexOf('releaseCouponUsageForOrder('), cancelBranch.indexOf('releaseCouponUsageForOrder(') + 120).replace(/\s+/g, ' ')
  );
  check(
    'it receives the transaction session',
    /couponUsageReleased = await releaseCouponUsageForOrder\([\s\S]{0,160}session\s*\)/.test(cancelBranch)
  );
  check(
    'the result is recorded on the audit entry',
    adminOrderSource.includes('metadata: { restoredStockLineCount, couponUsageReleased }')
  );
  check(
    'it is NOT called for non-cancel status changes',
    !adminOrderSource.slice(cancelBranchStart + 2600).includes('releaseCouponUsageForOrder(')
  );

  /* ══ D. Controls ════════════════════════════════════════════════════════ */

  section('D. Controls');

  check('control: the floor predicate rejects an unguarded coupon filter', hasPositiveFloor({ _id: COUPON_ID }) === false);
  check(
    'control: the floor predicate rejects a counter filter without a floor',
    hasPositiveFloor({ couponId: COUPON_ID, userId: USER_ID }) === false
  );
  check(
    'control: and accepts the shipped filters, so it is not simply always false',
    hasPositiveFloor(releaseFilter) && hasPositiveFloor(counterFilter)
  );

  // Discrimination for the wiring checks: a slice that cannot contain the call must
  // fail the same predicate, otherwise "the branch calls it" proves nothing.
  check(
    'control: the wiring predicate is not satisfied by an unrelated slice',
    !adminOrderSource.slice(0, transactionStart).includes('releaseCouponUsageForOrder(')
  );

  const counterFilterShape = JSON.stringify(counterFilter);
  check(
    'control: the counter filter cannot match any row it should not',
    counterFilterShape.includes('$gt') &&
      counterFilterShape.includes(COUPON_ID) &&
      counterFilterShape.includes(USER_ID)
  );

  /* ══ Result ═════════════════════════════════════════════════════════════ */

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failure(s)`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

void main();
