import { createHash, randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { UserModel } from './user.model';
import { sendPasswordResetEmail } from '../services/email.service';
import type { ForgotPasswordInput } from './auth.schemas';

/**
 * Forgot-password handler.
 *
 * The response is deliberately identical for an unknown address, a Google-only
 * account and a successful send. Delivery failures are logged but never
 * surfaced: returning a different status for an existing account would turn
 * this endpoint into an account-enumeration oracle.
 */

/** How long a reset link stays valid: one hour. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const GENERIC_FORGOT_MESSAGE = 'If an account exists, a reset link has been sent.';

/** One-way hash of the raw token; only this form is ever stored or compared. */
export const hashResetToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** POST /api/auth/forgot-password */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body as ForgotPasswordInput;

    // `password` is select:false, so the query must opt in to distinguish a
    // Google-only account (no local password) from a local one.
    const user = await UserModel.findOne({ email }).select('+password');

    if (user && user.password) {
      const rawToken = randomBytes(32).toString('hex');

      user.resetPasswordToken = hashResetToken(rawToken);
      user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await user.save();

      try {
        await sendPasswordResetEmail(user.email, rawToken);
      } catch (error) {
        // A dead SMTP relay must not change the response for this address.
        console.error('[forgotPassword] reset email could not be sent:', error);
      }
    }

    // Identical body whether or not the account exists, and whether or not the
    // account is a Google-only one.
    res.status(200).json({ success: true, message: GENERIC_FORGOT_MESSAGE });
  } catch (error) {
    console.error('[forgotPassword]', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
