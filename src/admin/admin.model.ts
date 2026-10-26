import { Schema, model, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Dedicated admin account — fully separate from the customer `User` collection.
 *
 * Admins authenticate with `email` + `password` and then a one-time code sent to
 * the address configured by `ADMIN_OTP_EMAIL` (see `admin-otp.service.ts`). The
 * customer `User` model is untouched by this flow, so a storefront session can
 * never be turned into an admin session, and a `User` row with
 * `role: "admin"` is NOT an admin account.
 *
 * Multiple administrators are supported by construction: the collection is a
 * normal one-row-per-admin set, `role`/`permissions` are stored per account, and
 * the OTP destination is a deployment-wide address rather than a property of
 * the account being signed in.
 */

/** Coarse role. Every role in this enum may sign in; `permissions` refines it. */
export const ADMIN_ROLES = ['owner', 'admin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const isAdminRole = (value: unknown): value is AdminRole =>
  typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);

/**
 * Granular permissions, reserved for the multi-admin rollout.
 *
 * Nothing enforces them yet — `role` alone decides access today — but the shape
 * is stored per account so adding enforcement later is a code change, not a data
 * migration. Unknown keys are rejected rather than silently stored.
 */
export const ADMIN_PERMISSIONS = [
  'catalog:write',
  'orders:write',
  'customers:read',
  'campaigns:write',
  'settings:write',
  'reviews:write',
  'admins:manage',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export interface IAdmin extends Document {
  /** Normalized (lower-cased, trimmed) login address. Unique at the DB level. */
  email: string;
  /** bcrypt hash. Never selected by default; `toJSON` strips it as a second layer. */
  password?: string;
  name?: string;
  role: AdminRole;
  permissions: AdminPermission[];
  /** A disabled admin cannot sign in and cannot use an existing session. */
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const adminSchema = new Schema<IAdmin>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      // Never selected by default: a query must opt in with `.select('+password')`.
      // Keeps the bcrypt hash out of every generic document load.
      select: false,
    },
    name: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ADMIN_ROLES,
      default: 'admin',
    },
    permissions: {
      type: [{ type: String, enum: ADMIN_PERMISSIONS }],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastLoginAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Hash password before saving — only when the field exists and is modified.
adminSchema.pre('save', async function () {
  if (!this.password || !this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Never serialize the password hash.
adminSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { password, __v, ...rest } = ret;
    void password;
    return rest;
  },
});

export const AdminModel = model<IAdmin>('Admin', adminSchema);
