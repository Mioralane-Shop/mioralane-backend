import { Router, Response, RequestHandler } from 'express';
import { registerUser, loginUser, logoutUser, googleLogin } from './auth.controller';
import { protect, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/google', googleLogin);
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
  ((req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({
      success: true,
      message: 'Token is valid!',
      user: req.user,
    });
  }) as RequestHandler
);

export default router;
