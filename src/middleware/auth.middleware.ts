import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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

const JWT_SECRET = process.env.JWT_SECRET;

interface JwtPayload {
  id: string;
  role: UserRole;
}

/**
 * Middleware that verifies the JWT from the Authorization header or
 * httpOnly cookie and attaches the decoded user payload to `req.user`.
 *
 * Token sources (checked in order):
 * 1. `req.cookies.token`  —  httpOnly cookie (XSS-safe, preferred)
 * 2. `Authorization: Bearer <token>`  —  standard header fallback
 */
export const protect = (req: Request, res: Response, next: NextFunction): void => {
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

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    req.user = {
      id: decoded.id,
      role: decoded.role,
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
