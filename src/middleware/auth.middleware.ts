import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { UserModel } from '../auth/user.model';

export type UserRole = 'user' | 'admin';

/**
 * Express Request augmented with the authenticated user payload.
 * Use this as the handler param type on routes protected by `protect`.
 */
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: UserRole;
  };
}

/** Token validation contract, shared by `jwt.sign` (auth controller) and `jwt.verify`. */
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_ISSUER = 'mioralane-api';
export const JWT_AUDIENCE = 'mioralane-clients';

const JWT_SECRET = process.env.JWT_SECRET;

interface JwtPayload {
  id: string;
  role: UserRole;
}

export const isUserRole = (value: unknown): value is UserRole =>
  value === 'user' || value === 'admin';

/**
 * Loads the live account behind a token id.
 *
 * Returns null when the id is malformed, the account no longer exists, or its
 * stored role is not a recognised value. The DB round-trip on every request is
 * a deliberate trade-off: it makes role demotion and account deletion take
 * effect immediately, instead of leaving a demoted admin with full access
 * until the token expires. There is intentionally no cache — a TTL cache would
 * reintroduce exactly that stale-role window.
 */
const loadLiveAccountRole = async (userId: string): Promise<UserRole | null> => {
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
 * Middleware that verifies the JWT from the Authorization header or
 * httpOnly cookie and attaches the decoded user payload to `req.user`.
 *
 * Token sources (checked in order):
 * 1. `req.cookies.token`  —  httpOnly cookie (XSS-safe, preferred)
 * 2. `Authorization: Bearer <token>`  —  standard header fallback
 */
export const protect = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!JWT_SECRET) {
      throw new Error('JWT_SECRET is required for authentication');
    }

    let token: string | undefined;

    // 1. Try httpOnly cookie first
    if (req.cookies?.token) {
      token = req.cookies.token;
    }

    // 2. Fall back to Authorization header
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

    // Algorithm, issuer and audience are pinned. Without them `verify` would
    // accept any algorithm compatible with the secret, plus tokens minted for
    // another service that happens to share it.
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as JwtPayload;

    if (typeof decoded.id !== 'string') {
      res.status(401).json({ success: false, message: 'Invalid token' });
      return;
    }

    const liveRole = await loadLiveAccountRole(decoded.id);

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
 * Middleware that blocks requests from non-admin users.
 * Must be used **after** `protect` middleware.
 */
export const adminOnly = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: 'Not authorized — user not authenticated',
    });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      message: 'Forbidden — admin access required',
    });
    return;
  }

  next();
};

/**
 * Shared guard chain for admin-only routes.
 *
 * Defined once so every admin surface composes the same two middlewares in the
 * same order: `protect` authenticates (and loads the live role from MongoDB),
 * then `adminOnly` authorises. Routers that mix public and admin endpoints must
 * apply it per route, because a router-level `use` would lock out the public
 * handlers.
 *
 * The `RequestHandler` casts are type-level only — they are erased at compile
 * time, so Express still receives the original function references (verified by
 * `tests/verify-admin-route-guards.ts`). That matters because Express 5 detects
 * a handler's returned promise and forwards rejections to `next`, which only
 * works while the handler itself is passed through unchanged.
 *
 * The array is frozen and typed `readonly` so the shared guard chain cannot be
 * mutated at runtime — an accidental `push`, `splice`, or element reassignment
 * would otherwise silently weaken every admin route at once.
 */
export const adminGuard: readonly RequestHandler[] = Object.freeze([
  protect as RequestHandler,
  adminOnly as RequestHandler,
]);
