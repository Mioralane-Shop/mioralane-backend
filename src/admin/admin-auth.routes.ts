import { Router } from 'express';
import { adminLogin, verifyAdminOtp } from './admin-auth.controller';
import { adminLoginSchema, verifyAdminOtpSchema } from './admin.schemas';
import { validate } from '../middleware/validate.middleware';
import { requireTurnstile } from '../turnstile/turnstile.middleware';

/**
 * Admin auth bootstrap routes (mounted at `/api/admin/auth` in app.module.ts).
 *
 * These are intentionally NOT behind `protect`/`adminOnly`: a caller reaches
 * them before holding any session — `login` issues the OTP and `verify-otp` is
 * the request that issues the session. These deliberate exceptions are
 * asserted (with their reasons) in `tests/verify-admin-route-guards.ts`, which
 * flags any OTHER unguarded route under `/api/admin`.
 *
 * `validate()` runs first, so a malformed body is answered by the schema
 * before the controller reads it. Rate limiting and the CSRF origin guard are
 * applied globally; `requireTurnstile` covers the credential-entry step.
 */
const router = Router();

router.post(
  '/login',
  validate({ body: adminLoginSchema, message: 'Email and password are required' }),
  requireTurnstile,
  adminLogin
);

router.post(
  '/verify-otp',
  validate({ body: verifyAdminOtpSchema, message: 'Email and a 6-digit OTP are required' }),
  verifyAdminOtp
);

export default router;
