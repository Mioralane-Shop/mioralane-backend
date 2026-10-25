import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { AdminModel } from './admin.model';
import { AdminOtpModel } from './admin-otp.model';
import type { AdminLoginInput, VerifyAdminOtpInput } from './admin.schemas';
import { sendAdminOtpEmail } from '../services/email.service';
import { recordActivity } from '../activity-log/activity-log.service';
import { createCsrfToken } from '../middleware/csrf-token.middleware';
import { generateToken, resolveSessionTtl, setAuthCookie } from '../auth/auth.controller';

/**
 * The single admin inbox every OTP is delivered to. This is the universal
 * admin account's address, independent of which admin account is signing in.
 */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim() || 'mioralaneshop@gmail.com';

/** An OTP stays valid for 5 minutes. */
const ADMIN_OTP_TTL_MS = 5 * 60 * 1000;

/** Wrong submissions accepted before the code is voided and must be re-issued. */
const MAX_OTP_ATTEMPTS = 5;

/**
 * Bcrypt hash of a throwaway literal, used only to spend the same CPU time on
 * the "account not found" branch as on a real password comparison. It is not a
 * credential for any account.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$JctwlGFITf3yuzChnb281.FmTKeI7SjSn4LUd5W2I3ffg3QLSgQRK';

const buildErrorMessage = (): string =>
  mongoose.connection.readyState !== 1
    ? 'Service temporarily unavailable'
    : 'Internal server error';

/** A uniformly random 6-digit code, zero-padded (covers e.g. 000042). */
const generateAdminOtp = (): string =>
  randomInt(0, 1_000_000).toString().padStart(6, '0');

/** SHA-256 hex of the code — the raw code is never stored. */
const hashAdminOtp = (otp: string): string =>
  createHash('sha256').update(otp).digest('hex');

/** Constant-time comparison of the submitted code against the stored hash. */
const otpMatches = (submitted: string, storedHash: string): boolean => {
  const computed = Buffer.from(hashAdminOtp(submitted), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');

  return computed.length === stored.length && timingSafeEqual(computed, stored);
};

/**
 * Mints a fresh 6-digit OTP for an admin whose email+password just verified,
 * stores only its hash, and emails the raw code to the universal admin inbox.
 *
 * Any previously outstanding code for the same admin is invalidated first, so
 * there is at most one live code per account. When the email send fails, the
 * freshly created row is removed before the error propagates: a
 * `success: true` response always means the relay accepted the message.
 */
const issueAdminOtp = async (adminEmail: string): Promise<void> => {
  const otp = generateAdminOtp();
  const normalized = adminEmail.toLowerCase();

  await AdminOtpModel.deleteMany({ email: normalized });

  const record = await AdminOtpModel.create({
    email: normalized,
    otpHash: hashAdminOtp(otp),
    expiresAt: new Date(Date.now() + ADMIN_OTP_TTL_MS),
  });

  try {
    await sendAdminOtpEmail(ADMIN_EMAIL, otp);
  } catch (error) {
    await AdminOtpModel.deleteOne({ _id: record._id }).catch(() => undefined);
    throw error;
  }
};

/**
 * POST /api/admin/auth/login — step 1 of the two-step admin sign-in.
 *
 * Validates the credentials against the dedicated `Admin` collection. On
 * success it issues an OTP (by email) and returns WITHOUT a token; the
 * session is only minted by `verifyAdminOtp`.
 */
export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as AdminLoginInput;
    const normalized = email.trim().toLowerCase();

    const admin = await AdminModel.findOne({ email: normalized }).select('+password');

    if (!admin) {
      // Constant-ish timing: spend the same bcrypt work as the wrong-password
      // branch, so response time cannot probe whether the account exists.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    await issueAdminOtp(normalized);

    res.status(200).json({ success: true, message: 'OTP sent to admin email' });
  } catch (error) {
    console.error('[adminLogin]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};

/**
 * POST /api/admin/auth/verify-otp — step 2 of the two-step admin sign-in.
 *
 * Verifies the 6-digit code against its hash, consumes it on success, and
 * issues the 2-hour admin session (JWT + httpOnly cookie).
 */
export const verifyAdminOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body as VerifyAdminOtpInput;
    const normalized = email.trim().toLowerCase();

    const record = await AdminOtpModel.findOne({ email: normalized }).sort({ createdAt: -1 });

    if (!record || record.expiresAt.getTime() <= Date.now()) {
      if (record) {
        await AdminOtpModel.deleteOne({ _id: record._id });
      }

      res.status(400).json({
        success: false,
        message: 'OTP has expired or was never issued — sign in again to request a new code',
      });
      return;
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await AdminOtpModel.deleteOne({ _id: record._id });

      res.status(400).json({
        success: false,
        message: 'Too many attempts — sign in again to request a new code',
      });
      return;
    }

    if (!otpMatches(otp, record.otpHash)) {
      await AdminOtpModel.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });

      res.status(400).json({ success: false, message: 'Invalid OTP code' });
      return;
    }

    // The code is single-use: consume it before issuing the session.
    await AdminOtpModel.deleteOne({ _id: record._id });

    const admin = await AdminModel.findOne({ email: normalized });

    if (!admin) {
      res.status(400).json({ success: false, message: 'No admin account matches this email' });
      return;
    }

    // Admin session: resolveSessionTtl hardcodes the 2-hour lifetime.
    const token = generateToken({ id: admin._id.toString(), role: 'admin' });
    const { maxAgeMs } = resolveSessionTtl('admin');

    setAuthCookie(res, token, maxAgeMs);

    const displayName = admin.name ?? admin.email;

    await recordActivity(req, {
      action: 'LOGIN',
      entityType: 'ADMIN',
      entityId: admin._id.toString(),
      entityName: displayName,
      description: `Signed in as ${displayName} (OTP verified)`,
      actor: { id: admin._id.toString(), role: 'admin', name: displayName, email: admin.email },
    });

    res.status(200).json({
      success: true,
      token,
      // Same token the client echoes back as `X-CSRF-Token` (P1.1), derived
      // from the session that was just issued.
      csrfToken: createCsrfToken(token),
      user: {
        id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error('[verifyAdminOtp]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};
