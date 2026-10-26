import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { AdminModel, type IAdmin } from './admin.model';
import { AdminSessionModel, type IAdminSession } from './admin-session.model';
import {
  ADMIN_JWT_AUDIENCE,
  ADMIN_TOKEN_COOKIE,
  JWT_ALGORITHM,
  JWT_ISSUER,
} from '../auth/jwt.constants';

/**
 * Admin session lifecycle: mint, verify, revoke.
 *
 * Deliberately free of Express request/response handling (apart from the two
 * cookie helpers) and free of imports from `middleware/auth.middleware`, so both
 * the guard and the controllers can depend on it without an import cycle.
 */

/**
 * The admin session policy: exactly 3 hours after the OTP is verified.
 *
 * `ADMIN_SESSION_TTL_HOURS` is honoured ONLY outside production, so a deployment
 * can shorten a lifetime to exercise expiry without ever weakening the
 * production policy. In production the value is ignored and the constant below
 * is used, which is why the requirement "exactly 3 hours" cannot drift with an
 * environment change.
 */
export const ADMIN_SESSION_TTL_HOURS = 3;
export const DEFAULT_ADMIN_SESSION_TTL_MS = ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000;

const MIN_TEST_TTL_HOURS = 1;
const MAX_TEST_TTL_HOURS = 24;

export const resolveAdminSessionTtlMs = (env: NodeJS.ProcessEnv = process.env): number => {
  if (env.NODE_ENV === 'production') {
    return DEFAULT_ADMIN_SESSION_TTL_MS;
  }

  const raw = (env.ADMIN_SESSION_TTL_HOURS ?? '').trim();

  if (raw === '') {
    return DEFAULT_ADMIN_SESSION_TTL_MS;
  }

  const hours = Number(raw);

  if (!Number.isInteger(hours) || hours < MIN_TEST_TTL_HOURS || hours > MAX_TEST_TTL_HOURS) {
    console.warn(
      `[admin-auth] ADMIN_SESSION_TTL_HOURS="${raw}" is not an integer between ${MIN_TEST_TTL_HOURS} and ${MAX_TEST_TTL_HOURS}; using ${ADMIN_SESSION_TTL_HOURS}h`
    );

    return DEFAULT_ADMIN_SESSION_TTL_MS;
  }

  return hours * 60 * 60 * 1000;
};

/** SHA-256 hex of the session id — the only form ever written to the database. */
export const hashSessionId = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex');

/** 256-bit session id. Unguessable; the JWT signature is what makes it a credential. */
const generateSessionId = (): string => randomBytes(32).toString('base64url');

const readJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is required for authentication');
  }

  return secret;
};

export type CreatedAdminSession = {
  sessionId: string;
  expiresAt: Date;
};

/** Persists a new session row for an admin. The expiry is fixed here, once. */
export const createAdminSession = async (input: {
  adminId: string;
  requestIp?: string;
  userAgent?: string;
}): Promise<CreatedAdminSession> => {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + resolveAdminSessionTtlMs());

  await AdminSessionModel.create({
    adminId: input.adminId,
    tokenHash: hashSessionId(sessionId),
    expiresAt,
    revokedAt: null,
    requestIp: input.requestIp,
    userAgent: input.userAgent,
  });

  return { sessionId, expiresAt };
};

/**
 * Signs the admin JWT.
 *
 * `exp` is derived from the session row's `expiresAt`, so the token, the cookie
 * and the database row all stop being valid at the same instant. `typ` is an
 * explicit principal marker: an id alone is never used to decide what kind of
 * account a request belongs to.
 */
export const signAdminSessionToken = (input: {
  sessionId: string;
  adminId: string;
  expiresAt: Date;
}): string => {
  const secondsRemaining = Math.max(
    1,
    Math.round((input.expiresAt.getTime() - Date.now()) / 1000)
  );

  return jwt.sign(
    { sid: input.sessionId, aid: input.adminId, typ: 'admin' },
    readJwtSecret(),
    {
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
      expiresIn: secondsRemaining,
    }
  );
};

type AdminTokenPayload = {
  sid?: unknown;
  aid?: unknown;
  typ?: unknown;
};

/** Reads the token without touching the database. `null` means "not even signed correctly". */
export const decodeAdminSessionToken = (token: string): { sessionId: string; adminId: string } | null => {
  try {
    const decoded = jwt.verify(token, readJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
    }) as AdminTokenPayload;

    if (decoded.typ !== 'admin' || typeof decoded.sid !== 'string' || typeof decoded.aid !== 'string') {
      return null;
    }

    return { sessionId: decoded.sid, adminId: decoded.aid };
  } catch {
    return null;
  }
};

export type AdminAuthFailure = 'invalid' | 'expired' | 'revoked' | 'admin_inactive';

export type AdminAuthResult =
  | { ok: true; admin: IAdmin; session: IAdminSession }
  | { ok: false; reason: AdminAuthFailure };

/**
 * Full server-side validation of an admin session token.
 *
 * Every admin request runs through this. All four conditions are checked live,
 * against MongoDB, on every call:
 *   1. the signature, issuer, audience and `typ` are the admin family,
 *   2. a session row exists for this token and has not been revoked,
 *   3. the row's `expiresAt` has not passed (never delegated to TTL cleanup),
 *   4. the admin account still exists and is still active.
 *
 * There is no cache on purpose: disabling an admin or revoking a session must
 * take effect on the very next request.
 */
export const authenticateAdminToken = async (token: string): Promise<AdminAuthResult> => {
  const decoded = decodeAdminSessionToken(token);

  if (!decoded) {
    // Distinguishes "expired" from "bad signature" only for UX; both are 401.
    return { ok: false, reason: isExpiredAdminToken(token) ? 'expired' : 'invalid' };
  }

  const session = await AdminSessionModel.findOne({ tokenHash: hashSessionId(decoded.sessionId) });

  if (!session) {
    return { ok: false, reason: 'invalid' };
  }

  if (session.revokedAt) {
    return { ok: false, reason: 'revoked' };
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const admin = await AdminModel.findById(session.adminId);

  if (!admin || admin.isActive !== true) {
    return { ok: false, reason: 'admin_inactive' };
  }

  touchSession(session._id.toString());

  return { ok: true, admin, session };
};

/** True when the token is well-formed but past its `exp` — used only to pick a message. */
const isExpiredAdminToken = (token: string): boolean => {
  const decoded = jwt.decode(token) as { exp?: unknown } | null;

  return typeof decoded?.exp === 'number' && decoded.exp * 1000 <= Date.now();
};

/**
 * Records activity on the session at most once a minute. Fire-and-forget: it is
 * informational metadata and must never fail or slow down a request. It does NOT
 * extend the session — `expiresAt` is written once, at creation.
 */
const TOUCH_INTERVAL_MS = 60 * 1000;

const touchSession = (sessionDocId: string): void => {
  void AdminSessionModel.updateOne(
    {
      _id: sessionDocId,
      $or: [{ lastSeenAt: { $exists: false } }, { lastSeenAt: null }, { lastSeenAt: { $lt: new Date(Date.now() - TOUCH_INTERVAL_MS) } }],
    },
    { $set: { lastSeenAt: new Date() } }
  ).catch(() => undefined);
};

/** Marks the session revoked. Idempotent; the row is kept for the audit trail. */
export const revokeAdminSession = async (
  sessionDocId: string,
  reason: string
): Promise<void> => {
  await AdminSessionModel.updateOne(
    { _id: sessionDocId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
};

/**
 * Issues the admin auth cookie.
 *
 * Mirrors the customer cookie's flags (httpOnly, `Secure` and `SameSite=None` in
 * production because the panel and the API are different sites) with a different
 * name, and `maxAge` is computed from the server-side expiry rather than a
 * literal.
 */
export const setAdminAuthCookie = (res: Response, token: string, expiresAt: Date): void => {
  const isProduction = process.env.NODE_ENV === 'production';

  /*
   * Rounded UP to the next whole second: `res.cookie` serialises `Max-Age` with a
   * floor, so passing the raw difference would shave a second off the advertised
   * lifetime on almost every request. The cookie may end up at most one second
   * longer than the session row, which is the safe direction — the database check
   * is what actually decides, and it rejects anything past `expiresAt`.
   */
  const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
  const maxAge = Math.ceil(remainingMs / 1000) * 1000;

  res.cookie(ADMIN_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge,
    path: '/',
  });
};

/** Clears the admin auth cookie with exactly the attributes it was set with. */
export const clearAdminAuthCookie = (res: Response): void => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie(ADMIN_TOKEN_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  });
};
