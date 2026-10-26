import { timingSafeEqual } from 'node:crypto';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { AdminModel, type IAdmin } from './admin.model';
import type {
  AdminBootstrapInput,
  AdminLoginInput,
  ResendAdminOtpInput,
  VerifyAdminOtpInput,
} from './admin.schemas';
import {
  AdminOtpDeliveryError,
  findChallengeForResend,
  issueAdminChallenge,
  verifyAdminChallenge,
  type ChallengeFailure,
} from './admin-otp.service';
import {
  clearAdminAuthCookie,
  createAdminSession,
  revokeAdminSession,
  setAdminAuthCookie,
  signAdminSessionToken,
} from './admin-session.service';
import { recordActivity } from '../activity-log/activity-log.service';
import { createCsrfToken, readAdminSessionToken } from '../middleware/csrf-token.middleware';
import type { AuthenticatedAdminRequest } from '../middleware/auth.middleware';

/**
 * Admin authentication endpoints (mounted at `/api/admin/auth`).
 *
 * Flow: `bootstrap` (once) -> `login` (credentials, sends an OTP) ->
 * `verify-otp` (code, mints the 3-hour session) -> protected admin APIs ->
 * `logout`. `resend-otp` re-issues a code for a live challenge and `me` reports
 * the current session.
 *
 * No admin session exists before `verify-otp`: `login` deliberately issues no
 * token and sets no cookie, so a stolen password alone yields nothing.
 */

/** Header an operator sends to provision the very first admin. Never used by a frontend. */
export const ADMIN_BOOTSTRAP_HEADER = 'x-admin-bootstrap-secret';

/** Bcrypt hash of a throwaway literal, used to equalise "account not found" timing. */
const DUMMY_PASSWORD_HASH = '$2b$10$JctwlGFITf3yuzChnb281.FmTKeI7SjSn4LUd5W2I3ffg3QLSgQRK';

const buildErrorMessage = (): string =>
  mongoose.connection.readyState !== 1
    ? 'Service temporarily unavailable'
    : 'Internal server error';

/** Constant-time string compare; length is checked first because timingSafeEqual throws on mismatch. */
const secretsMatch = (expected: string, provided: string): boolean => {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
};

/**
 * Safe projection of an admin account for API responses.
 *
 * Explicit allowlist rather than a spread of the document: nothing added to the
 * model later can leak here by accident, and the password hash has no path into
 * a response.
 */
const toAdminProfile = (admin: {
  _id: unknown;
  email: string;
  name?: string | null;
  role: string;
  permissions?: string[];
  isActive?: boolean;
  createdAt?: Date;
}) => ({
  id: String(admin._id),
  email: admin.email,
  name: admin.name ?? null,
  role: admin.role,
  permissions: admin.permissions ?? [],
  isActive: admin.isActive !== false,
  createdAt: admin.createdAt,
});

/** Messages for each challenge failure. Never reveals whether a code was close. */
const CHALLENGE_FAILURES: Record<ChallengeFailure, { status: number; code: string; message: string }> = {
  not_found: {
    status: 400,
    code: 'CHALLENGE_NOT_FOUND',
    message: 'This sign-in attempt is no longer valid — sign in again to request a new code',
  },
  expired: {
    status: 400,
    code: 'OTP_EXPIRED',
    message: 'The verification code has expired — sign in again to request a new code',
  },
  already_used: {
    status: 400,
    code: 'OTP_ALREADY_USED',
    message: 'This verification code has already been used — sign in again to request a new code',
  },
  attempt_limit: {
    status: 400,
    code: 'OTP_ATTEMPT_LIMIT',
    message: 'Too many incorrect attempts — sign in again to request a new code',
  },
  invalid_code: {
    status: 400,
    code: 'OTP_INVALID',
    message: 'Incorrect verification code',
  },
  cooldown: {
    status: 429,
    code: 'OTP_RESEND_COOLDOWN',
    message: 'Please wait before requesting another code',
  },
};

const OTP_DELIVERY_MESSAGE =
  'We could not send the verification email. Please try again in a moment.';

/**
 * POST /api/admin/auth/bootstrap — provisions the FIRST admin account.
 *
 * - Requires `ADMIN_BOOTSTRAP_SECRET` to be configured, and the request to carry
 *   it in `x-admin-bootstrap-secret`. Missing configuration fails closed (503).
 * - Only works while the `admins` collection is empty; every later call is 409.
 *   It therefore cannot be used to add an account or overwrite the owner.
 * - Creates no session and issues no cookie: the new admin still has to sign in
 *   and pass OTP verification like any other.
 *
 * Disable it after use by deleting `ADMIN_BOOTSTRAP_SECRET` from the deployment
 * environment (the endpoint then answers 503 and an existing admin makes it 409).
 */
export const bootstrapAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const configuredSecret = (process.env.ADMIN_BOOTSTRAP_SECRET ?? '').trim();

    if (configuredSecret === '') {
      res.status(503).json({
        success: false,
        message: 'Admin bootstrap is disabled on this deployment',
      });
      return;
    }

    const providedSecret = req.get(ADMIN_BOOTSTRAP_HEADER);

    if (typeof providedSecret !== 'string' || !secretsMatch(configuredSecret, providedSecret.trim())) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    const existing = await AdminModel.countDocuments({});

    if (existing > 0) {
      res.status(409).json({
        success: false,
        message: 'An admin account already exists — bootstrap is only available once',
      });
      return;
    }

    const { email, password, name } = req.body as AdminBootstrapInput;

    const admin = await AdminModel.create({
      email,
      password,
      name: name || undefined,
      role: 'owner',
      permissions: [],
      isActive: true,
    });

    // Two concurrent bootstraps can both pass the count check above; the unique
    // index stops a duplicate address, and this stops two *different* addresses
    // from both becoming the "initial" admin. The loser removes its own row.
    const total = await AdminModel.countDocuments({});

    if (total > 1) {
      await AdminModel.deleteOne({ _id: admin._id }).catch(() => undefined);

      res.status(409).json({
        success: false,
        message: 'An admin account already exists — bootstrap is only available once',
      });
      return;
    }

    res.status(201).json({
      success: true,
      message: 'Admin account created. Sign in with email, password and the emailed code.',
      admin: toAdminProfile(admin),
    });
  } catch (error) {
    // A duplicate key means a concurrent request won the race: same 409, no detail.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000) {
      res.status(409).json({
        success: false,
        message: 'An admin account already exists — bootstrap is only available once',
      });
      return;
    }

    console.error('[bootstrapAdmin]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};

/**
 * POST /api/admin/auth/login — step 1 of the two-step admin sign-in.
 *
 * Validates the credentials against the dedicated `Admin` collection (never
 * `UserModel`), then emails a 6-digit code to the configured inbox and returns a
 * challenge id. No token, no cookie: the session is minted only by `verify-otp`.
 */
export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as AdminLoginInput;
    const normalized = email.trim().toLowerCase();

    const admin = await AdminModel.findOne({ email: normalized }).select('+password');

    if (!admin || !admin.password) {
      // Same bcrypt work as the wrong-password branch, so response time cannot
      // be used to probe whether an account exists.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    const isMatch = await bcrypt.compare(password, admin.password);

    // A disabled account answers exactly like a wrong password: an attacker
    // learns nothing about which addresses exist or which are suspended.
    if (!isMatch || admin.isActive !== true) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    const challenge = await issueAdminChallenge(admin._id.toString(), {
      requestIp: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    res.status(200).json({
      success: true,
      requiresOtp: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt.toISOString(),
      otpExpiresInSeconds: Math.round(challenge.ttlMs / 1000),
    });
  } catch (error) {
    if (error instanceof AdminOtpDeliveryError) {
      // A failed send leaves no usable challenge and no session; the client must
      // start over with the password step.
      console.error('[adminLogin] verification email could not be sent:', error.reason);
      res.status(503).json({ success: false, message: OTP_DELIVERY_MESSAGE });
      return;
    }

    console.error('[adminLogin]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};

/**
 * POST /api/admin/auth/verify-otp — step 2 of the two-step admin sign-in.
 *
 * Verifies the code (expiry, attempt ceiling, single use, live account status),
 * then creates the database-backed session and issues the httpOnly admin cookie.
 * The session expires exactly 3 hours from this point and is never extended.
 */
export const verifyAdminOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { challengeId, otp } = req.body as VerifyAdminOtpInput;

    const verification = await verifyAdminChallenge(challengeId, otp);

    if (!verification.ok) {
      const failure = CHALLENGE_FAILURES[verification.reason];
      res.status(failure.status).json({
        success: false,
        code: failure.code,
        message: failure.message,
      });
      return;
    }

    const admin = await AdminModel.findById(verification.adminId);

    // Re-checked after the code was accepted: an account disabled between the two
    // steps must not end up with a session.
    if (!admin || admin.isActive !== true) {
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    const session = await createAdminSession({
      adminId: admin._id.toString(),
      requestIp: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    const token = signAdminSessionToken({
      sessionId: session.sessionId,
      adminId: admin._id.toString(),
      expiresAt: session.expiresAt,
    });

    setAdminAuthCookie(res, token, session.expiresAt);

    await AdminModel.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } }).catch(
      () => undefined
    );

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
      // The session token itself only ever lives in the httpOnly cookie; the CSRF
      // token is derived from the token that was just issued (the request still
      // carries the *previous* cookie, if any, so it must not be read here).
      csrfToken: createCsrfToken(token, 'admin'),
      admin: toAdminProfile(admin),
      session: {
        expiresAt: session.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('[verifyAdminOtp]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};

/**
 * POST /api/admin/auth/resend-otp — re-issues a code for a live challenge.
 *
 * Pre-session by definition, so the only capability is the challenge id. The
 * cooldown and the rate limiter are both server-side: the countdown in the UI is
 * an affordance, not the control.
 */
export const resendAdminOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { challengeId } = req.body as ResendAdminOtpInput;

    const existing = await findChallengeForResend(challengeId);

    if (!existing.ok) {
      const failure = CHALLENGE_FAILURES[existing.reason];

      if (existing.reason === 'cooldown') {
        res.status(failure.status).json({
          success: false,
          code: failure.code,
          message: failure.message,
          retryAfterSeconds: existing.retryAfterSeconds,
        });
        return;
      }

      res.status(failure.status).json({
        success: false,
        code: failure.code,
        message: failure.message,
      });
      return;
    }

    const admin = await AdminModel.findById(existing.adminId);

    if (!admin || admin.isActive !== true) {
      res.status(400).json({
        success: false,
        code: 'CHALLENGE_NOT_FOUND',
        message: CHALLENGE_FAILURES.not_found.message,
      });
      return;
    }

    // Issues a brand-new code AND a brand-new challenge id; the presented one is
    // invalidated by the same call, so an old link cannot be reused.
    const challenge = await issueAdminChallenge(admin._id.toString(), {
      requestIp: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    res.status(200).json({
      success: true,
      requiresOtp: true,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt.toISOString(),
      otpExpiresInSeconds: Math.round(challenge.ttlMs / 1000),
    });
  } catch (error) {
    if (error instanceof AdminOtpDeliveryError) {
      console.error('[resendAdminOtp] verification email could not be sent:', error.reason);
      res.status(503).json({ success: false, message: OTP_DELIVERY_MESSAGE });
      return;
    }

    console.error('[resendAdminOtp]', error);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};

/**
 * GET /api/admin/auth/me — the session bootstrap for the admin panel.
 *
 * Behind `adminGuard`, so reaching the handler already proves the session exists,
 * is unrevoked, is unexpired and belongs to an active admin. The profile returned
 * is the one that guard just read from MongoDB.
 */
export const getAdminMe = async (req: Request, res: Response): Promise<void> => {
  const principal = (req as AuthenticatedAdminRequest).admin;

  if (!principal) {
    res.status(401).json({ success: false, message: 'Not authorized' });
    return;
  }

  const admin = await AdminModel.findById(principal.id).catch(() => null);

  if (!admin || admin.isActive !== true) {
    res.status(401).json({ success: false, message: 'Admin session is no longer valid' });
    return;
  }

  res.status(200).json({
    success: true,
    csrfToken: createCsrfToken(readAdminSessionToken(req), 'admin'),
    admin: toAdminProfile(admin),
    session: {
      expiresAt: principal.sessionExpiresAt.toISOString(),
    },
  });
};

/**
 * POST /api/admin/auth/logout — revokes the current admin session.
 *
 * The database row is revoked before the cookie is cleared, so a copied cookie
 * (or a replayed request) stops working immediately rather than when it expires.
 * CSRF protection is unchanged: this route is NOT exempt, so the caller must
 * present the session-bound token like any other state-changing request.
 */
export const logoutAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const principal = (req as AuthenticatedAdminRequest).admin;

    if (principal) {
      await revokeAdminSession(principal.sessionId, 'logout');
    }

    clearAdminAuthCookie(res);

    res.status(200).json({ success: true, message: 'Signed out successfully' });
  } catch (error) {
    console.error('[logoutAdmin]', error);
    // The cookie is cleared regardless: leaving it behind after a failed revoke
    // would be worse than a 500, because the client would keep sending it.
    clearAdminAuthCookie(res);
    res.status(500).json({ success: false, message: buildErrorMessage() });
  }
};
