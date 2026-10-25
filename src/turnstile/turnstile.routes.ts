import { Router, RequestHandler } from 'express';
import { validate } from '../middleware/validate.middleware';
import { verifyTurnstileHandler } from './turnstile.controller';
import { verifyTurnstileSchema } from './turnstile.schemas';

/**
 * Turnstile verification, mounted at `/api/verify-turnstile` (see `app.module.ts`).
 *
 * PUBLIC by design: it is the endpoint a caller reaches before it has any
 * session, and it holds no data of its own. It is therefore deliberately NOT
 * behind `adminGuard` or `protect`.
 *
 * The IP rate limit is applied by the mount in `app.module.ts`
 * (`turnstileLimiter`), next to the router, so the two cannot drift apart.
 */
export const turnstileRoutes = Router();

turnstileRoutes.post(
    '/',
    validate({ body: verifyTurnstileSchema }),
    verifyTurnstileHandler as RequestHandler
);
