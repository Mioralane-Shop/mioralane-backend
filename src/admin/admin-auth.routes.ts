import { Router, type RequestHandler } from 'express';
import {
  adminLogin,
  bootstrapAdmin,
  getAdminMe,
  logoutAdmin,
  resendAdminOtp,
  verifyAdminOtp,
} from './admin-auth.controller';
import {
  adminBootstrapSchema,
  adminLoginSchema,
  resendAdminOtpSchema,
  verifyAdminOtpSchema,
} from './admin.schemas';
import { validate } from '../middleware/validate.middleware';
import { requireTurnstile } from '../turnstile/turnstile.middleware';
import { adminGuard } from '../middleware/auth.middleware';
import {
  adminBootstrapLimiter,
  adminLoginLimiter,
  adminOtpResendLimiter,
  adminOtpVerifyLimiter,
} from '../middleware/rateLimiter.middleware';

/**
 * Admin authentication routes (mounted at `/api/admin/auth` in app.module.ts).
 *
 * Two families live here:
 *
 *   - **Pre-session** (`bootstrap`, `login`, `verify-otp`, `resend-otp`): the
 *     caller has no admin session yet, so these cannot sit behind `adminGuard`.
 *     They are the only deliberate exceptions under `/api/admin`, they are each
 *     rate limited, and they are asserted (with reasons) in
 *     `tests/verify-admin-route-guards.ts`, which fails on any OTHER unguarded
 *     route under `/api/admin`.
 *   - **Session-bound** (`me`, `logout`): guarded by `adminGuard`, i.e. the admin
 *     cookie plus a live, unrevoked, unexpired `adminsessions` row belonging to an
 *     active admin.
 *
 * CSRF: the four pre-session routes are in `CSRF_EXEMPT_PATHS` (no session can
 * exist yet), while `logout` is NOT — it must present the session-bound token.
 */
const router = Router();

router.post(
  '/bootstrap',
  // Limiter first: this endpoint is the highest-value target under /api/admin, so
  // a flood is refused before the body is parsed. (The other routes keep the
  // project-wide "validate, then act" precedence so their 400 wording is stable.)
  adminBootstrapLimiter,
  validate({ body: adminBootstrapSchema, message: 'Email and a strong password are required' }),
  bootstrapAdmin as RequestHandler
);

router.post(
  '/login',
  validate({ body: adminLoginSchema, message: 'Email and password are required' }),
  adminLoginLimiter,
  requireTurnstile,
  adminLogin as RequestHandler
);

router.post(
  '/verify-otp',
  validate({
    body: verifyAdminOtpSchema,
    message: 'A login challenge and a 6-digit OTP are required',
  }),
  adminOtpVerifyLimiter,
  verifyAdminOtp as RequestHandler
);

router.post(
  '/resend-otp',
  validate({ body: resendAdminOtpSchema, message: 'A login challenge is required' }),
  adminOtpResendLimiter,
  resendAdminOtp as RequestHandler
);

router.get('/me', ...adminGuard, getAdminMe as RequestHandler);

router.post('/logout', ...adminGuard, logoutAdmin as RequestHandler);

export default router;
