import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import { AdminOtpModel } from './admin-otp.model';
import { sendAdminOtpEmail } from '../services/email.service';

/**
 * Admin login challenge (OTP) lifecycle.
 *
 * Responsibilities kept here rather than in the controller: TTL/cooldown config,
 * code generation and hashing, the atomic single-use redemption, and the one
 * place that emails a code. The controller only decides what to answer.
 */

/** A challenge always accepts at most this many wrong codes before it is voided. */
export const MAX_ADMIN_OTP_ATTEMPTS = 5;

/** Server-side floor between two codes for the same challenge. */
export const ADMIN_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export const DEFAULT_ADMIN_OTP_TTL_MINUTES = 5;
const MIN_ADMIN_OTP_TTL_MINUTES = 1;
const MAX_ADMIN_OTP_TTL_MINUTES = 15;

/** `ADMIN_OTP_TTL_MINUTES`, clamped to a sane range. Default 5 minutes. */
export const resolveAdminOtpTtlMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = (env.ADMIN_OTP_TTL_MINUTES ?? '').trim();
  const fallback = DEFAULT_ADMIN_OTP_TTL_MINUTES * 60 * 1000;

  if (raw === '') {
    return fallback;
  }

  const minutes = Number(raw);

  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_ADMIN_OTP_TTL_MINUTES ||
    minutes > MAX_ADMIN_OTP_TTL_MINUTES
  ) {
    console.warn(
      `[admin-auth] ADMIN_OTP_TTL_MINUTES="${raw}" is not an integer between ${MIN_ADMIN_OTP_TTL_MINUTES} and ${MAX_ADMIN_OTP_TTL_MINUTES}; using ${DEFAULT_ADMIN_OTP_TTL_MINUTES}m`
    );

    return fallback;
  }

  return minutes * 60 * 1000;
};

/**
 * The inbox every admin OTP is delivered to.
 *
 * Configured, never hardcoded. `ADMIN_EMAIL` is accepted as a deprecated alias so
 * an existing deployment keeps working, but `ADMIN_OTP_EMAIL` is what the
 * documentation tells operators to set. `null` means "not configured" and the
 * caller must refuse to start a challenge rather than guess an address.
 */
export const resolveAdminOtpDestination = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configured = (env.ADMIN_OTP_EMAIL ?? '').trim() || (env.ADMIN_EMAIL ?? '').trim();

  return configured === '' ? null : configured;
};

/** A uniformly random 6-digit code, zero-padded (covers e.g. 000042). */
export const generateAdminOtp = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');

/** SHA-256 hex of the code — the raw code is never stored or logged. */
export const hashAdminOtp = (otp: string): string => createHash('sha256').update(otp).digest('hex');

/** Constant-time comparison of a submitted code against the stored hash. */
export const adminOtpMatches = (submitted: string, storedHash: string): boolean => {
  const computed = Buffer.from(hashAdminOtp(submitted), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');

  return computed.length === stored.length && timingSafeEqual(computed, stored);
};

/**
 * Raised when the code could not be emailed. The controller turns this into a
 * generic failure — a login challenge that never reached the inbox must not leave
 * the caller with a usable session or a half-created challenge.
 */
export class AdminOtpDeliveryError extends Error {
  readonly reason: 'email_not_configured' | 'email_failed';

  constructor(reason: 'email_not_configured' | 'email_failed') {
    super(`Admin OTP email could not be sent (${reason})`);
    this.name = 'AdminOtpDeliveryError';
    this.reason = reason;
  }
}

export type IssuedAdminChallenge = {
  challengeId: string;
  expiresAt: Date;
  /** How long the code is valid, so the client can render the same copy as the email. */
  ttlMs: number;
};

export type ChallengeMeta = { requestIp?: string; userAgent?: string };

/**
 * Creates a challenge for an admin and emails the code.
 *
 * Any previously outstanding challenge for that admin is removed first, so at
 * most one code is ever live per account (a user who requests a second code
 * cannot keep using the first). If delivery fails, the freshly written row is
 * deleted before the error propagates: a "code sent" response never lies.
 */
export const issueAdminChallenge = async (
  adminId: string | Types.ObjectId,
  meta: ChallengeMeta = {}
): Promise<IssuedAdminChallenge> => {
  const destination = resolveAdminOtpDestination();

  if (destination === null) {
    throw new AdminOtpDeliveryError('email_not_configured');
  }

  const ttlMs = resolveAdminOtpTtlMs();
  const otp = generateAdminOtp();
  const now = new Date();

  await AdminOtpModel.deleteMany({ adminId });

  const challenge = await AdminOtpModel.create({
    adminId,
    challengeId: randomBytes(32).toString('base64url'),
    otpHash: hashAdminOtp(otp),
    expiresAt: new Date(now.getTime() + ttlMs),
    lastSentAt: now,
    attempts: 0,
    consumedAt: null,
    requestIp: meta.requestIp,
    userAgent: meta.userAgent,
  });

  try {
    await sendAdminOtpEmail(destination, otp, Math.round(ttlMs / 60000));
  } catch (error) {
    await AdminOtpModel.deleteOne({ _id: challenge._id }).catch(() => undefined);
    throw new AdminOtpDeliveryError('email_failed');
  }

  return { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, ttlMs };
};

export type ChallengeFailure =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'attempt_limit'
  | 'invalid_code'
  | 'cooldown';

export type ChallengeVerification =
  | { ok: true; adminId: string }
  | { ok: false; reason: ChallengeFailure; retryAfterSeconds?: number };

/**
 * Verifies a code against its challenge.
 *
 * Order matters: existence, consumption, expiry and the attempt ceiling are all
 * checked before the hash is compared, and the two state transitions are atomic
 * conditional updates so two concurrent requests cannot both succeed:
 *
 *   - a wrong code can only increment `attempts` while the row is unconsumed and
 *     under the ceiling, so a race cannot push the counter past the limit;
 *   - the correct code consumes the row with `consumedAt: null` in the filter, so
 *     exactly one caller ever gets `ok: true` (replay is rejected).
 */
export const verifyAdminChallenge = async (
  challengeId: string,
  otp: string
): Promise<ChallengeVerification> => {
  const challenge = await AdminOtpModel.findOne({ challengeId });

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (challenge.consumedAt) {
    return { ok: false, reason: 'already_used' };
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    // Expiry is decided here, not by the TTL index (which may not have run yet).
    await AdminOtpModel.deleteOne({ _id: challenge._id, consumedAt: null }).catch(() => undefined);

    return { ok: false, reason: 'expired' };
  }

  if (challenge.attempts >= MAX_ADMIN_OTP_ATTEMPTS) {
    return { ok: false, reason: 'attempt_limit' };
  }

  if (!adminOtpMatches(otp, challenge.otpHash)) {
    const updated = await AdminOtpModel.findOneAndUpdate(
      { _id: challenge._id, consumedAt: null, attempts: { $lt: MAX_ADMIN_OTP_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    return {
      ok: false,
      reason: updated && updated.attempts >= MAX_ADMIN_OTP_ATTEMPTS ? 'attempt_limit' : 'invalid_code',
    };
  }

  const consumed = await AdminOtpModel.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );

  if (!consumed) {
    return { ok: false, reason: 'already_used' };
  }

  return { ok: true, adminId: consumed.adminId.toString() };
};

/**
 * Loads a challenge that a client is allowed to ask for a new code for.
 *
 * Used by `resend-otp`, which holds no session — the challenge id it presents is
 * the whole capability. The cooldown is enforced here (server-side) so it cannot
 * be bypassed by ignoring the countdown in the UI.
 */
export const findChallengeForResend = async (
  challengeId: string
): Promise<
  | { ok: true; adminId: string }
  | { ok: false; reason: ChallengeFailure; retryAfterSeconds?: number }
> => {
  const challenge = await AdminOtpModel.findOne({ challengeId });

  if (!challenge) {
    return { ok: false, reason: 'not_found' };
  }

  if (challenge.consumedAt) {
    return { ok: false, reason: 'already_used' };
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const elapsed = Date.now() - challenge.lastSentAt.getTime();

  if (elapsed < ADMIN_OTP_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil((ADMIN_OTP_RESEND_COOLDOWN_MS - elapsed) / 1000),
    };
  }

  return { ok: true, adminId: challenge.adminId.toString() };
};
