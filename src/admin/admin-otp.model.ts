import { Schema, model, Document } from 'mongoose';

/**
 * One outstanding admin login OTP (2FA second factor).
 *
 * Only the SHA-256 hash of the 6-digit code is stored — the raw code exists
 * solely in the email that was sent. A Mongo TTL index sweeps the row ~5
 * minutes after creation, matching the logical expiry, so the collection
 * cannot accumulate stale codes.
 */
export interface IAdminOtp extends Document {
  /** The admin account the code was issued for (normalized lowercase). */
  email: string;
  /** SHA-256 hex of the 6-digit code; the raw code is never stored. */
  otpHash: string;
  /** When the code stops being accepted. */
  expiresAt: Date;
  /** Wrong submissions seen; the code is voided at MAX_OTP_ATTEMPTS. */
  attempts: number;
  createdAt: Date;
}

const adminOtpSchema = new Schema<IAdminOtp>({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
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
  attempts: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// 5 minutes: the TTL sweep and the logical `expiresAt` check agree by
// construction (issueAdminOtp sets expiresAt = now + 5 min).
adminOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

export const AdminOtpModel = model<IAdminOtp>('AdminOtp', adminOtpSchema);
