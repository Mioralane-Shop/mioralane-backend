import { Schema, model, Document, Types } from 'mongoose';

/**
 * A persisted admin session — the record that makes an admin cookie revocable.
 *
 * The customer flow is stateless: its JWT *is* the session. Admin sessions are
 * deliberately stateful, because the requirements demand server-side revocation
 * (logout must kill the session, not merely clear a cookie) and a hard expiry
 * that no client can extend.
 *
 * ## Why `tokenHash` and not the session id
 *
 * The signed JWT carries a random 256-bit session id (`sid`). This row stores
 * only `SHA-256(sid)`, so a dump of this collection cannot be turned back into
 * usable session ids — and a session id on its own is useless without the
 * signature anyway. Lookups hash the presented `sid` and match on `tokenHash`.
 */
export interface IAdminSession extends Document {
  /** The admin this session belongs to. Re-checked (with `isActive`) per request. */
  adminId: Types.ObjectId;
  /** SHA-256 hex of the session id embedded in the JWT. Unique per session. */
  tokenHash: string;
  /** Hard expiry, set once when the session is created. Never extended. */
  expiresAt: Date;
  /** Set when the session is signed out; a revoked session is rejected forever. */
  revokedAt: Date | null;
  /** Free-form reason for revocation (`logout`, `reauth`, ...). */
  revokedReason?: string;
  /** Last request that used this session. Informational only — never extends it. */
  lastSeenAt?: Date;
  requestIp?: string;
  userAgent?: string;
  createdAt: Date;
}

const adminSessionSchema = new Schema<IAdminSession>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
    },
    lastSeenAt: {
      type: Date,
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

/**
 * Housekeeping only, and deliberately later than the row's logical expiry: an
 * expired session must still exist long enough to explain itself in an audit,
 * and expiry is always enforced by comparing `expiresAt` in code.
 */
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const AdminSessionModel = model<IAdminSession>('AdminSession', adminSessionSchema);
