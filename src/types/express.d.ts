import type { AdminPermission, AdminRole } from '../admin/admin.model';

/**
 * Express request augmentation.
 *
 * `user` is the CUSTOMER principal and is only ever set by `protect`.
 * `admin` is the ADMIN principal and is only ever set by `adminProtect`.
 *
 * Two separate fields, rather than one field plus a role flag, is what makes the
 * isolation hold in both directions: a handler that needs an admin reads
 * `req.admin` and cannot be satisfied by a customer session, and a handler that
 * needs a customer reads `req.user`, which an admin session does not touch
 * (except for the documented audit-field compatibility shim in `adminProtect`,
 * where `req.user` is derived from the verified admin session, never from a
 * customer token).
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: 'user' | 'admin';
      };
      admin?: {
        id: string;
        email: string;
        name?: string | null;
        role: AdminRole;
        permissions: AdminPermission[];
        isActive: boolean;
        createdAt?: Date;
        sessionId: string;
        sessionExpiresAt: Date;
      };
    }
  }
}

export {};
