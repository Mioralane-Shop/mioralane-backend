import { NextFunction, Request, Response } from 'express';
import { isAllowedOrigin } from '../config/allowed-origins';

/**
 * Origin-based CSRF guard for state-changing requests.
 *
 * Why this exists: the auth cookie is issued with `SameSite=None` in
 * production (unavoidable — the storefront, the admin app and the API live on
 * three different hosts). With `SameSite=None` the browser attaches the auth
 * cookie to cross-site requests, and because `protect` reads the cookie
 * *before* the `Authorization` header, a forged cross-site request would
 * otherwise be authenticated. There is no CSRF token anywhere in the stack, so
 * this guard is the compensating control.
 *
 * Policy for POST/PUT/PATCH/DELETE:
 *   1. `Origin` present       -> must be in the shared allowlist.
 *   2. no `Origin`, `Referer` -> the referrer's origin must be in the allowlist.
 *   3. neither header present -> allowed (non-browser client: curl, Postman,
 *      server-to-server, uptime checks).
 *
 * Known limitation: browsers do not let a page suppress `Origin` on a
 * cross-site request, so rule 3 is not a browser bypass — but it does mean
 * this guard alone would not stop a future client that omits both headers.
 * A double-submit CSRF token remains the follow-up hardening step.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BLOCKED_RESPONSE = {
  success: false,
  message: 'Request blocked — untrusted origin',
};

/** Extracts a scheme+host origin from a Referer URL, or null when unusable. */
const parseRefererOrigin = (referer: string | undefined): string | null => {
  if (!referer) {
    return null;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
};

export const csrfOriginGuard = (req: Request, res: Response, next: NextFunction): void => {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin;

  if (typeof origin === 'string' && origin.length > 0) {
    if (isAllowedOrigin(origin)) {
      next();
      return;
    }

    res.status(403).json(BLOCKED_RESPONSE);
    return;
  }

  const refererOrigin = parseRefererOrigin(
    typeof req.headers.referer === 'string' ? req.headers.referer : undefined
  );

  if (refererOrigin && !isAllowedOrigin(refererOrigin)) {
    res.status(403).json(BLOCKED_RESPONSE);
    return;
  }

  next();
};
