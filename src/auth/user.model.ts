import { Schema, model, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  username: string;
  email: string;
  password?: string;
  googleId?: string;
  avatar?: string;
  authProvider: 'local' | 'google';
  role: 'user' | 'admin';
  wishlist: Schema.Types.ObjectId[];
  comboWishlist: Schema.Types.ObjectId[];
  createdAt: Date;
}

const userSchema = new Schema<IUser>({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    minlength: [6, 'Password must be at least 6 characters'],
  },
  googleId: {
    type: String,
  },
  avatar: {
    type: String,
  },
  authProvider: {
    type: String,
    enum: ['local', 'google'],
    default: 'local',
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  wishlist: {
    type: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
    default: [],
  },
  comboWishlist: {
    type: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Combo',
      },
    ],
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving — only when password field exists and is modified
userSchema.pre('save', async function () {
  if (!this.password || !this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Strip password when converting to JSON
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { password, __v, ...rest } = ret;
    return rest;
  },
});

export const UserModel = model<IUser>('User', userSchema);
