import { Router, Response, RequestHandler } from 'express';
import { registerUser, loginUser, logoutUser, googleLogin } from './auth.controller';
import { googleLoginSchema, loginUserSchema, registerUserSchema } from './auth.schemas';
import { validate } from '../middleware/validate.middleware';
import { protect, AuthenticatedRequest } from '../middleware/auth.middleware';
import { createCsrfToken, readSessionToken } from '../middleware/csrf-token.middleware';
import { requireTurnstile } from '../turnstile/turnstile.middleware';
import { UserModel } from './user.model';

const router = Router();

// Messages are overridden per route so every existing 400 keeps its exact
// wording. Status codes and the response envelope are unchanged.
//
// `requireTurnstile` is mounted immediately before each handler — after
// `validate`, so a malformed body is still answered by the schema (see the
// middleware's ordering note). These three routes are the credential-entry
// points, which is what it exists to protect.
router.post(
  '/register',
  validate({ body: registerUserSchema, message: 'Username, email, and password are required' }),
  requireTurnstile,
  registerUser
);
router.post(
  '/login',
  validate({ body: loginUserSchema, message: 'Username or email and password are required' }),
  requireTurnstile,
  loginUser
);
router.post(
  '/google',
  validate({ body: googleLoginSchema, message: 'Google credential is required' }),
  requireTurnstile,
  googleLogin
);
router.post('/logout', logoutUser);

/**
 * GET /me
 * Returns the authenticated user decoded from the JWT.
 * Used to validate that a token is still valid.
 */
/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     description: Validates the JWT and returns the decoded user payload.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     role:
 *                       type: string
 *       401:
 *         description: Not authorized — token missing, expired, or invalid
 */
router.get(
  '/me',
  protect,
  (async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, message: 'Not authorized' });
      return;
    }

    const user = await UserModel.findById(userId);

    if (!user) {
      res.status(401).json({ success: false, message: 'User session is no longer valid' });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Token is valid!',
      // Re-issued on every call (P1.1) so a client that dropped its in-memory
      // token — page reload, or a login in another tab rotating the session —
      // recovers with the `/me` call it already makes, with no extra endpoint
      // and no extra round trip. Derived from the session, so it is exactly the
      // value `csrfTokenGuard` expects. `null` for a Bearer-only caller, which
      // the guard skips and which therefore needs no token.
      csrfToken: createCsrfToken(readSessionToken(req)),
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  }) as RequestHandler
);

export default router;
