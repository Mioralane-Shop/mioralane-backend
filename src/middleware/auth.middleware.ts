import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { UserModel } from '../auth/user.model';
import {
  ADMIN_JWT_AUDIENCE,
  ADMIN_TOKEN_COOKIE,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../auth/jwt.constants';
import {
  authenticateAdminToken,
  type AdminAuthFailure,
} from '../admin/admin-session.service';
import type { AdminPermission, AdminRole } from '../admin/admin.model';

/**
 * Authentication middleware, in two fully separate families.
 *
 *   - **Customer** — `protect` (+ `adminOnly` as a legacy alias that can never
 *     pass here). Reads the `token` cookie / Bearer header, verifies a customer
 *     JWT and loads the *User* record.
 *   - **Admin** — `adminProtect` (+ `adminOnly`), exposed to routes as
 *     `adminGuard`. Reads ONLY the `admin_token` cookie, verifies an admin JWT
 *     (different audience), and validates a live `adminsessions` row plus the
 *     live `Admin` record.
 *
 * The isolation is structural, not a role comparison:
 *
 *   1. different cookies — a customer cookie is never consulted by `adminProtect`
 *      and vice versa;
 *   2. different JWT audiences and an explicit `typ: 'admin'` claim, so a token
 *      from one family fails the other's `verify`;
 *   3. different collections — `adminProtect` only ever reads `Admin` and
 *      `AdminSession`, `protect` only ever reads `User`.
 *
 * Consequently, a customer row whose `role` is `"admin"` (a legacy account, see
 * the migration note in docs/ADMIN_AUTH.md) is still just a customer: it cannot
 * reach a single `/api/admin/*` endpoint.
 */

export type UserRole = 'user' | 'admin';

/** Express Request augmented with the authenticated customer payload. */
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: UserRole;
  };
}

/**
 * The admin principal established by `adminProtect`.
 *
 * Deliberately a different field from `user`: code that reads `req.user` can be
 * sure it is looking at a customer, and admin-only code reads `req.admin`, which
 * only ever exists after a database-backed admin session was validated.
 */
export interface AdminPrincipal {
  id: string;
  email: string;
  name?: string | null;
  role: AdminRole;
  permissions: AdminPermission[];
  isActive: boolean;
  createdAt?: Date;
  /** `adminsessions` row id — used to revoke exactly this session on logout. */
  sessionId: string;
  sessionExpiresAt: Date;
}

export interface AuthenticatedAdminRequest extends Request {
  admin: AdminPrincipal;
}

/*
 * Re-exported so existing importers of this module keep working unchanged. The
 * values themselves live in `auth/jwt.constants.ts` because the admin services
 * need them too and must not import middleware (that would be a cycle).
 */
export { JWT_ALGORITHM, JWT_ISSUER, JWT_AUDIENCE, ADMIN_JWT_AUDIENCE, ADMIN_TOKEN_COOKIE };

const JWT_SECRET = process.env.JWT_SECRET;

interface JwtPayload {
  id: string;
  role: UserRole;
}

export const isUserRole = (value: unknown): value is UserRole =>
  value === 'user' || value === 'admin';

/** Messages are stable so clients can branch on `code` rather than parse prose. */
const ADMIN_SESSION_MESSAGES: Record<AdminAuthFailure | 'missing', { code: string; message: string }> = {
  missing: { code: 'ADMIN_SESSION_REQUIRED', message: 'Not authorized — no admin session' },
  invalid: { code: 'ADMIN_SESSION_INVALID', message: 'Admin session is not valid — sign in again' },
  expired: { code: 'ADMIN_SESSION_EXPIRED', message: 'Admin session has expired — sign in again' },
  revoked: { code: 'ADMIN_SESSION_REVOKED', message: 'Admin session was signed out — sign in again' },
  admin_inactive: { code: 'ADMIN_ACCOUNT_DISABLED', message: 'This admin account is disabled' },
};

const assertJwtSecret = (): string => {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required for authentication');
  }

  return JWT_SECRET;
};

/**
 * Loads the live role of a *customer* account behind a customer token.
 *
 * The DB round-trip on every request is deliberate: it makes a role change take
 * effect immediately instead of leaving a demoted account with its old powers
 * until the token expires. There is intentionally no cache.
 */
const loadLiveUserRole = async (userId: string): Promise<UserRole | null> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  const account = await UserModel.findById(userId).select('role').lean().exec();

  if (!account || !isUserRole(account.role)) {
    return null;
  }

  return account.role;
};

/**
 * Customer authentication.
 *
 * Token sources (checked in order):
 * 1. `req.cookies.token` — httpOnly cookie (XSS-safe, preferred)
 * 2. `Authorization: ****** — standard header fallback
 *
 * An admin token is rejected here by construction: it is signed for the admin
 * audience, which this `verify` pins against.
 */
export const protect = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const secret = assertJwtSecret();

    let token: string | undefined;

    if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Not authorized — no token provided',
      });
      return;
    }

    const decoded = jwt.verify(token, secret, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as JwtPayload;

    if (typeof decoded.id !== 'string') {
      res.status(401).json({ success: false, message: 'Invalid token' });
      return;
    }

    const liveRole = await loadLiveUserRole(decoded.id);

    if (!liveRole) {
      res.status(401).json({
        success: false,
        message: 'User session is no longer valid',
      });
      return;
    }

    req.user = {
      id: decoded.id,
      // The live role from MongoDB, never the claim baked into the token.
      role: liveRole,
    };

    next();
  } catch (error) {
    const message =
      error instanceof jwt.TokenExpiredError
        ? 'Token has expired'
        : error instanceof jwt.JsonWebTokenError
          ? 'Invalid token'
          : 'Not authorized';

    res.status(401).json({ success: false, message });
  }
};

/**
 * Authorises an admin request.
 *
 * Only the `admin_token` cookie is consulted — no `Authorization` fallback — so
 * there is exactly one way to present an admin credential and no ambiguity about
 * which family a bearer token belongs to.
 */
export const adminProtect = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const cookie: unknown = req.cookies?.[ADMIN_TOKEN_COOKIE];
  const token = typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;

  if (!token) {
    const { code, message } = ADMIN_SESSION_MESSAGES.missing;
    res.status(401).json({ success: false, code, message });
    return;
  }

  try {
    const result = await authenticateAdminToken(token);

    if (!result.ok) {
      const { code, message } = ADMIN_SESSION_MESSAGES[result.reason];

      // 'admin_inactive' is an authorization failure, everything else is "no
      // valid session". Both are refused; the status differs for the client's
      // benefit only.
      res.status(result.reason === 'admin_inactive' ? 403 : 401).json({
        success: false,
        code,
        message,
      });
      return;
    }

    const { admin, session } = result;

    req.admin = {
      id: admin._id.toString(),
      email: admin.email,
      name: admin.name ?? null,
      role: admin.role,
      permissions: admin.permissions ?? [],
      isActive: admin.isActive !== false,
      createdAt: admin.createdAt,
      sessionId: session._id.toString(),
      sessionExpiresAt: session.expiresAt,
    };

    // Compatibility shim for handlers written before the admin split: they read
    // `req.user` for audit fields ("performedBy"). The value comes from the
    // verified admin session above, never from a customer token.
    req.user = { id: req.admin.id, role: 'admin' };

    next();
  } catch (error) {
    console.error('[adminProtect]', error);
    res.status(401).json({
      success: false,
      code: ADMIN_SESSION_MESSAGES.invalid.code,
      message: ADMIN_SESSION_MESSAGES.invalid.message,
    });
  }
};

/**
 * Blocks anything that is not an authenticated admin.
 *
 * Must be used after `adminProtect`. It reads `req.admin`, which only that
 * middleware can set — so composing it with the customer `protect` (or on its
 * own) fails closed instead of trusting a customer role claim.
 */
export const adminOnly = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.admin) {
    res.status(403).json({
      success: false,
      message: 'Forbidden — admin session required',
    });
    return;
  }

  next();
};

/**
 * Shared guard chain for admin-only routes.
 *
 * Defined once so every admin surface composes the same two middlewares in the
 * same order: `adminProtect` authenticates (admin cookie -> admin JWT ->
 * `adminsessions` row -> live `Admin`), then `adminOnly` authorises. Routers that
 * mix public and admin endpoints must apply it per route, because a router-level
 * `use` would lock out the public handlers.
 *
 * The array is frozen and typed `readonly` so the shared guard chain cannot be
 * mutated at runtime — an accidental `push`, `splice`, or element reassignment
 * would otherwise silently weaken every admin route at once.
 */
export const adminGuard: readonly RequestHandler[] = Object.freeze([
  adminProtect as RequestHandler,
  adminOnly as RequestHandler,
]);
