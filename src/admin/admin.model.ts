import { Schema, model, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Dedicated admin account — fully separate from the customer `User` collection.
 *
 * Admins authenticate with `email` + `password` and go through the two-step
 * OTP flow in `admin-auth.controller.ts`. The customer `User` model is left
 * untouched, so storefront login cannot mint an admin session.
 */
export interface IAdmin extends Document {
  email: string;
  password: string;
  name?: string;
  role: 'admin';
  createdAt: Date;
}

const adminSchema = new Schema<IAdmin>({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
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
    enum: ['admin'],
    default: 'admin',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

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
    return rest;
  },
});

export const AdminModel = model<IAdmin>('Admin', adminSchema);
