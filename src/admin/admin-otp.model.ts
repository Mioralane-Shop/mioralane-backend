import { Schema, model, Document, Types } from 'mongoose';

/**
 * One outstanding admin login challenge (the 2FA second factor).
 *
 * A challenge is issued only after email+password verified, is bound to the
 * admin it was issued for, and is the *only* thing `verify-otp` accepts besides
 * the code. The raw code never touches the database or a log line: only its
 * SHA-256 hash is stored, and it exists in plaintext solely inside the email.
 *
 * Single use is enforced by an atomic `consumedAt` update, not by the TTL index:
 * Mongo's TTL monitor runs about once a minute, so a code could otherwise be
 * accepted while its row was still on disk. `expiresAt` is checked on every
 * verification (see `admin-otp.service.ts`); the index is only housekeeping.
 */
export interface IAdminChallenge extends Document {
  /** The admin account the code was issued for. */
  adminId: Types.ObjectId;
  /** Random 256-bit handle returned to the client and required to verify. */
  challengeId: string;
  /** SHA-256 hex of the 6-digit code; the raw code is never stored. */
  otpHash: string;
  /** When the code stops being accepted. */
  expiresAt: Date;
  /** When the most recent code was emailed (server-side resend cooldown). */
  lastSentAt: Date;
  /** Wrong submissions seen; the challenge is voided at the attempt limit. */
  attempts: number;
  /** Set exactly once, atomically, when the code is redeemed. */
  consumedAt: Date | null;
  /** Minimal security metadata for the audit trail. */
  requestIp?: string;
  userAgent?: string;
  createdAt: Date;
}

const adminChallengeSchema = new Schema<IAdminChallenge>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
      index: true,
    },
    challengeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    lastSentAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    requestIp: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Housekeeping only: rows are dropped shortly after they expire. Authorization
// never depends on this having run — `expiresAt` is compared in code first.
adminChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminOtpModel = model<IAdminChallenge>('AdminOtp', adminChallengeSchema);
